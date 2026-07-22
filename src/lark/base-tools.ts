import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ComponentProposal, ComponentType, MessageEvent } from "../types.js";
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

export class BaseTools {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cli: LarkCli, private readonly config: AppConfig, private readonly state: StateStore) {}

  getSourceSchema(): Promise<unknown> {
    return this.cli.run(["base", "+field-list", "--base-token", this.config.lark.baseToken, "--table-id", this.config.lark.tableId, "--as", "bot", "--format", "json"]);
  }

  resolveSnapshotDate(requestedDate: string | null): Promise<unknown> {
    if (requestedDate) return Promise.resolve({ snapshot_date: requestedDate, source: "requested" });
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
    return this.cli.run(["base", "+data-query", "--base-token", this.config.lark.baseToken, "--dsl", JSON.stringify(safeDsl), "--as", "bot", "--format", "json"]);
  }

  searchRecords(input: { keyword: string; searchFields: string[]; selectFields: string[]; limit: number; snapshotDate: string }): Promise<unknown> {
    const body = {
      keyword: input.keyword,
      search_fields: input.searchFields.slice(0, 20),
      select_fields: input.selectFields.slice(0, 50),
      limit: Math.min(Math.max(input.limit, 1), 50),
      offset: 0,
      filter: { logic: "and", conditions: [[this.config.lark.snapshotField, "==", `ExactDate(${input.snapshotDate})`]] },
    };
    return this.cli.run(["base", "+record-search", "--base-token", this.config.lark.baseToken, "--table-id", this.config.lark.tableId, "--json", JSON.stringify(body), "--as", "bot", "--format", "json"]);
  }

  listManagedComponents(): unknown[] { return this.state.listManagedComponents(); }

  async getManagedComponent(blockId: string): Promise<unknown> {
    if (!this.state.isManagedComponent(blockId)) throw new Error("Component is not managed by this service");
    const dashboardId = await this.ensureDashboard();
    const metadata = await this.cli.run(["base", "+dashboard-block-get", "--base-token", this.config.lark.baseToken, "--dashboard-id", dashboardId, "--block-id", blockId, "--as", "bot", "--format", "json"]);
    const data = await this.cli.run(["base", "+dashboard-block-get-data", "--base-token", this.config.lark.baseToken, "--block-id", blockId, "--as", "bot", "--format", "json"]).catch(() => null);
    return { metadata, data };
  }

  validateProposal(proposal: ComponentProposal): ComponentProposal {
    const parsed = proposal.action === "create" ? createSchema.parse(proposal) : updateSchema.parse(proposal);
    if (parsed.action === "update" && !this.state.isManagedComponent(parsed.blockId)) throw new Error("Only service-managed components can be updated");
    if (parsed.dataConfig && parsed.action === "create" && parsed.type !== "text") parsed.dataConfig.table_name = this.config.lark.tableName;
    if (parsed.dataConfig && parsed.action === "update") parsed.dataConfig.table_name = this.config.lark.tableName;
    return parsed as ComponentProposal;
  }

  executeProposal(proposal: ComponentProposal): Promise<unknown> {
    const run = async () => {
      const valid = this.validateProposal(proposal);
      const dashboardId = await this.ensureDashboard();
      if (valid.action === "create") {
        const data = await this.cli.run<Record<string, unknown>>([
          "base", "+dashboard-block-create", "--base-token", this.config.lark.baseToken, "--dashboard-id", dashboardId,
          "--name", valid.name, "--type", valid.type as ComponentType, "--data-config", JSON.stringify(valid.dataConfig), "--as", "bot", "--format", "json",
        ]);
        const blockId = findString(data, ["block_id", "id"]);
        if (!blockId) throw new Error("Dashboard create response did not include block_id");
        this.state.registerComponent(blockId, valid.name, valid.type as string, valid.dataConfig);
        return { action: "created", block_id: blockId, dashboard_id: dashboardId };
      }
      const args = ["base", "+dashboard-block-update", "--base-token", this.config.lark.baseToken, "--dashboard-id", dashboardId, "--block-id", valid.blockId as string];
      if (valid.name) args.push("--name", valid.name);
      if (valid.dataConfig) args.push("--data-config", JSON.stringify(valid.dataConfig));
      args.push("--as", "bot", "--format", "json");
      const data = await this.cli.run(args);
      this.state.registerComponent(valid.blockId as string, valid.name ?? "managed component", "managed", valid.dataConfig ?? {});
      return { action: "updated", block_id: valid.blockId, data };
    };
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  async ensureDashboard(): Promise<string> {
    const cached = this.state.getSetting("dashboard_id");
    if (cached) return cached;
    const listed = await this.cli.run<unknown>(["base", "+dashboard-list", "--base-token", this.config.lark.baseToken, "--as", "bot", "--format", "json"]);
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

  reply(messageId: string, text: string): Promise<unknown> {
    return this.cli.run(["im", "+messages-reply", "--message-id", messageId, "--text", text.slice(0, 20_000), "--reply-in-thread", "--as", "bot", "--format", "json"]);
  }

  async resolveBotOpenId(): Promise<string> {
    const data = await this.cli.run<Record<string, unknown>>(["whoami", "--as", "bot", "--json"]);
    const openId = findString(data, ["openId", "open_id"]);
    if (!openId) throw new Error("Unable to resolve bot open_id");
    return openId;
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
  const timestamp = new Date(`${snapshotDate}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("snapshot_date must use YYYY-MM-DD");
  const current = existing && typeof existing === "object" ? existing as Record<string, unknown> : {};
  const conditions = Array.isArray(current.conditions) ? current.conditions : [];
  return {
    type: 1,
    conjunction: "and",
    conditions: [...conditions, { field_name: fieldName, operator: "is", value: ["ExactDate", String(timestamp)] }],
  };
}
