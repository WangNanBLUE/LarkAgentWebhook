import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { parseShanghaiDate } from "../date.js";
import type { ComponentProposal, ComponentType } from "../types.js";
import { StateStore } from "../state/store.js";
import { LarkCli } from "./cli.js";

const componentTypes = ["statistics", "column", "line", "pie", "ring", "text"] as const;
const createSchema = z.object({
  action: z.literal("create"),
  name: z.string().min(1).max(100),
  type: z.enum(componentTypes),
  dataConfig: z.record(z.unknown()),
});
const updateSchema = z.object({
  action: z.literal("update"),
  blockId: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  dataConfig: z.record(z.unknown()).optional(),
});

const filterConditionSchema = z.object({
  field_name: z.string().min(1),
  operator: z.enum(["is", "isNot", "contains", "doesNotContain", "isGreater", "isGreaterEqual", "isLess", "isLessEqual", "isEmpty", "isNotEmpty"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
}).strict().superRefine((condition, context) => {
  const emptyOperator = condition.operator === "isEmpty" || condition.operator === "isNotEmpty";
  if (emptyOperator && condition.value !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "Empty operators must omit value" });
  if (!emptyOperator && condition.value === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "Filter operator requires value" });
});
const groupByItemSchema = z.object({
  field_name: z.string().min(1),
  mode: z.enum(["integrated", "enumerated"]),
  sort: z.object({ type: z.enum(["group", "value", "view"]), order: z.enum(["asc", "desc"]).optional() }).strict().optional(),
}).strict();
const chartShape = {
  table_name: z.string().min(1).optional(),
  series: z.array(z.object({ field_name: z.string().min(1), rollup: z.enum(["SUM", "MAX", "MIN", "AVERAGE"]) }).strict()).min(1).optional(),
  count_all: z.literal(true).optional(),
  group_by: z.array(groupByItemSchema).max(2).optional(),
  filter: z.object({
    conjunction: z.enum(["and", "or"]),
    conditions: z.array(filterConditionSchema),
  }).strict().optional(),
};
const partialChartConfigSchema = z.object(chartShape).strict();

export function validateDashboardConfig(type: ComponentType | string, config: Record<string, unknown>, requireMetric: boolean): Record<string, unknown> {
  if (type === "text") return z.object({ text: z.string().min(1) }).strict().parse(config);
  if (!requireMetric) return partialChartConfigSchema.parse(config);
  const grouping = type === "pie" || type === "ring"
    ? z.array(groupByItemSchema).length(1)
    : z.array(groupByItemSchema).min(1).max(2);
  const schema = type === "statistics"
    ? z.object({ ...chartShape, group_by: z.never().optional() }).strict()
    : z.object({ ...chartShape, group_by: grouping }).strict();
  const parsed = schema.parse(config);
  if (requireMetric && Boolean(parsed.series) === Boolean(parsed.count_all)) throw new Error("Chart config requires exactly one of series or count_all");
  return parsed;
}

export class BaseTools {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cli: LarkCli, private readonly config: AppConfig, private readonly state: StateStore) {}

  getSourceSchema(): Promise<unknown> {
    return this.cli.runRetryable(["base", "+field-list", "--base-token", this.config.lark.baseToken, "--table-id", this.config.lark.tableId, "--as", "bot", "--format", "json"]);
  }

  resolveSnapshotDate(requestedDate: string | null): Promise<unknown> {
    if (requestedDate) {
      parseShanghaiDate(requestedDate);
      return Promise.resolve({ snapshot_date: requestedDate, source: "requested" });
    }
    return this.dataQuery({
      dimensions: [{ field_name: this.config.lark.snapshotField, alias: "snapshot_date" }],
      measures: [{ field_name: this.config.lark.snapshotField, aggregation: "count", alias: "record_count" }],
      sort: [{ field_name: "snapshot_date", order: "desc" }],
      pagination: { limit: 1 },
    });
  }

  dataQuery(rawDsl: unknown, snapshotDate?: string): Promise<unknown> {
    const dsl = z.record(z.unknown()).parse(rawDsl);
    const pagination = z.object({ limit: z.number().int().positive().max(200).default(100) }).parse(dsl.pagination ?? {});
    const filters = snapshotDate ? mergeDataQueryDateFilter(dsl.filters, this.config.lark.snapshotField, snapshotDate) : dsl.filters;
    const safeDsl = {
      ...dsl,
      datasource: { type: "table", table: { tableId: this.config.lark.tableId } },
      ...(filters ? { filters } : {}),
      pagination,
      shaper: { format: "flat" },
    };
    return this.cli.runRetryable(["base", "+data-query", "--base-token", this.config.lark.baseToken, "--dsl", JSON.stringify(safeDsl), "--as", "bot", "--format", "json"]);
  }

  searchRecords(input: { keyword: string; searchFields: string[]; selectFields: string[]; limit: number; snapshotDate: string }): Promise<unknown> {
    parseShanghaiDate(input.snapshotDate);
    const body = {
      keyword: input.keyword,
      search_fields: input.searchFields.slice(0, 20),
      select_fields: input.selectFields.slice(0, 50),
      limit: Math.min(Math.max(input.limit, 1), 50),
      offset: 0,
      filter: { logic: "and", conditions: [[this.config.lark.snapshotField, "==", `ExactDate(${input.snapshotDate})`]] },
    };
    return this.cli.runRetryable(["base", "+record-search", "--base-token", this.config.lark.baseToken, "--table-id", this.config.lark.tableId, "--json", JSON.stringify(body), "--as", "bot", "--format", "json"]);
  }

  listManagedComponents(): unknown[] { return this.state.listManagedComponents(); }

  async getManagedComponent(blockId: string): Promise<unknown> {
    if (!this.state.isManagedComponent(blockId)) throw new Error("Component is not managed by this service");
    const dashboardId = await this.ensureDashboard();
    const metadata = await this.cli.runRetryable(["base", "+dashboard-block-get", "--base-token", this.config.lark.baseToken, "--dashboard-id", dashboardId, "--block-id", blockId, "--as", "bot", "--format", "json"]);
    const data = await this.cli.runRetryable(["base", "+dashboard-block-get-data", "--base-token", this.config.lark.baseToken, "--block-id", blockId, "--as", "bot", "--format", "json"]).catch(() => null);
    return { metadata, data };
  }

  validateProposal(proposal: ComponentProposal): ComponentProposal {
    const parsed = proposal.action === "create" ? createSchema.parse(proposal) : updateSchema.parse(proposal);
    if (parsed.action === "update" && !this.state.isManagedComponent(parsed.blockId)) throw new Error("Only service-managed components can be updated");
    if (parsed.action === "create") {
      if (parsed.type !== "text") parsed.dataConfig.table_name = this.config.lark.tableName;
      parsed.dataConfig = validateDashboardConfig(parsed.type, parsed.dataConfig, true);
    } else if (parsed.dataConfig) {
      const current = this.state.getManagedComponentRecord(parsed.blockId);
      if (!current) throw new Error("Managed component metadata is missing");
      const partial = current.type === "text" ? parsed.dataConfig : partialChartConfigSchema.parse(parsed.dataConfig);
      const effective = {
        ...current.config,
        ...partial,
        ...(current.type === "text" ? {} : { table_name: this.config.lark.tableName }),
      };
      parsed.dataConfig = validateDashboardConfig(current.type, effective, true);
    }
    return parsed as ComponentProposal;
  }

  executeProposal(proposal: ComponentProposal, actionId?: string): Promise<unknown> {
    const run = async () => {
      const valid = this.validateProposal(proposal);
      const dashboardId = await this.ensureDashboard();
      if (valid.action === "create") {
        const existingIds = new Set((await this.listDashboardBlocks(dashboardId)).map((item) => findString(item, ["block_id", "id"])).filter(Boolean));
        if (actionId) this.state.setActionReconciliation(actionId, { dashboardId, existingBlockIds: [...existingIds] });
        try {
          const data = await this.cli.run<Record<string, unknown>>([
            "base", "+dashboard-block-create", "--base-token", this.config.lark.baseToken, "--dashboard-id", dashboardId,
            "--name", valid.name, "--type", valid.type as ComponentType, "--data-config", JSON.stringify(valid.dataConfig), "--as", "bot", "--format", "json",
          ]);
          const blockId = findString(data, ["block_id", "id"]);
          if (!blockId) throw new Error("Dashboard create response did not include block_id");
          this.state.registerComponent(blockId, valid.name, valid.type as string, valid.dataConfig);
          return { action: "created", block_id: blockId, dashboard_id: dashboardId };
        } catch (error) {
          const reconciled = (await this.listDashboardBlocks(dashboardId).catch(() => []))
            .find((item) => {
              const id = findString(item, ["block_id", "id"]);
              return id && !existingIds.has(id) && findString(item, ["name", "block_name"]) === valid.name;
            });
          const blockId = reconciled ? findString(reconciled, ["block_id", "id"]) : undefined;
          if (!blockId) throw error;
          this.state.registerComponent(blockId, valid.name, valid.type as string, valid.dataConfig);
          return { action: "created_reconciled", block_id: blockId, dashboard_id: dashboardId };
        }
      }
      const current = this.state.getManagedComponentRecord(valid.blockId);
      if (!current) throw new Error("Managed component metadata is missing");
      const effectiveConfig = valid.dataConfig
        ? { ...current.config, ...valid.dataConfig, ...(current.type === "text" ? {} : { table_name: this.config.lark.tableName }) }
        : current.config;
      validateDashboardConfig(current.type, effectiveConfig, true);
      const args = ["base", "+dashboard-block-update", "--base-token", this.config.lark.baseToken, "--dashboard-id", dashboardId, "--block-id", valid.blockId as string];
      if (valid.name) args.push("--name", valid.name);
      if (valid.dataConfig) args.push("--data-config", JSON.stringify(effectiveConfig));
      args.push("--as", "bot", "--format", "json");
      const data = await this.cli.run(args);
      this.state.registerComponent(valid.blockId, valid.name ?? current.name, current.type, effectiveConfig);
      return { action: "updated", block_id: valid.blockId, data };
    };
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  async reconcileExecutingActions(): Promise<void> {
    for (const item of this.state.listExecutingActions()) {
      const proposal = item.action.payload as ComponentProposal;
      const context = item.reconciliation as { dashboardId?: string; existingBlockIds?: string[] } | undefined;
      if (item.action.kind !== "component.create" || proposal.action !== "create" || !context?.dashboardId || !context.existingBlockIds) {
        this.state.markActionUnknown(item.action.id, "Service restarted while the external write was in progress");
        continue;
      }
      try {
        const oldIds = new Set(context.existingBlockIds);
        const reconciled = (await this.listDashboardBlocks(context.dashboardId)).find((block) => {
          const id = findString(block, ["block_id", "id"]);
          return id && !oldIds.has(id) && findString(block, ["name", "block_name"]) === proposal.name;
        });
        const blockId = reconciled ? findString(reconciled, ["block_id", "id"]) : undefined;
        if (!blockId) {
          this.state.markActionUnknown(item.action.id, "No matching component was found after restart reconciliation");
          continue;
        }
        this.state.registerComponent(blockId, proposal.name, proposal.type, proposal.dataConfig);
        this.state.markActionCompleted(item.action.id, { action: "created_reconciled_after_restart", block_id: blockId, dashboard_id: context.dashboardId });
      } catch (error) {
        this.state.markActionUnknown(item.action.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  async ensureDashboard(): Promise<string> {
    const cached = this.state.getSetting("dashboard_id");
    if (cached) return cached;
    const listed = await this.cli.runRetryable<unknown>(["base", "+dashboard-list", "--base-token", this.config.lark.baseToken, "--as", "bot", "--format", "json"]);
    const items = findArray(listed, "items");
    const existing = items.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).name === this.config.lark.dashboardName) as Record<string, unknown> | undefined;
    let dashboardId = existing ? findString(existing, ["dashboard_id", "id"]) : undefined;
    if (!dashboardId) {
      const created = await this.cli.run<unknown>(["base", "+dashboard-create", "--base-token", this.config.lark.baseToken, "--name", this.config.lark.dashboardName, "--as", "bot", "--format", "json"]);
      dashboardId = findString(created, ["dashboard_id", "id"]);
    }
    if (!dashboardId) throw new Error("Unable to resolve managed dashboard ID");
    this.state.setSetting("dashboard_id", dashboardId);
    return dashboardId;
  }

  reply(messageId: string, text: string, replyInThread: boolean): Promise<unknown> {
    const body = text.slice(0, 20_000);
    const key = createHash("sha256").update(`${replyInThread ? "thread" : "main"}:${messageId}:${body}`).digest("hex").slice(0, 48);
    const args = ["im", "+messages-reply", "--message-id", messageId, "--text", body];
    if (replyInThread) args.push("--reply-in-thread");
    args.push("--idempotency-key", key, "--as", "bot", "--format", "json");
    return this.cli.runRetryable(args);
  }

  replyCard(messageId: string, cardId: string, replyInThread: boolean): Promise<unknown> {
    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    const key = createHash("sha256")
      .update(`${replyInThread ? "thread" : "main"}:${messageId}:${cardId}`)
      .digest("hex")
      .slice(0, 48);
    const args = [
      "im", "+messages-reply",
      "--message-id", messageId,
      "--msg-type", "interactive",
      "--content", content,
    ];
    if (replyInThread) args.push("--reply-in-thread");
    args.push("--idempotency-key", key, "--as", "bot", "--format", "json");
    return this.cli.runRetryable(args);
  }

  private async listDashboardBlocks(dashboardId: string): Promise<unknown[]> {
    const data = await this.cli.runRetryable<unknown>([
      "base", "+dashboard-block-list", "--base-token", this.config.lark.baseToken, "--dashboard-id", dashboardId,
      "--page-size", "100", "--as", "bot", "--format", "json",
    ]);
    return findArray(data, "items");
  }

}

function findArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record[key])) return record[key] as unknown[];
  for (const child of Object.values(record)) {
    const found = findArray(child, key);
    if (found.length) return found;
  }
  return [];
}

function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "string") return record[key] as string;
  for (const child of Object.values(record)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return undefined;
}

function mergeDataQueryDateFilter(existing: unknown, fieldName: string, snapshotDate: string): Record<string, unknown> {
  const timestamp = parseShanghaiDate(snapshotDate);
  const current = existing && typeof existing === "object" ? existing as Record<string, unknown> : {};
  const conditions = Array.isArray(current.conditions) ? current.conditions : [];
  return {
    type: 1,
    conjunction: "and",
    conditions: [...conditions, { field_name: fieldName, operator: "is", value: ["ExactDate", String(timestamp)] }],
  };
}
