import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BaseResource } from "../lark/base-resource.js";
import { validateDashboardConfig } from "../lark/base-tools.js";
import type { SourceReader } from "../lark/source-reader.js";
import type { SourceRegistry } from "../sources/registry.js";
import type { StateStore } from "../state/store.js";
import type { PendingAction } from "../types.js";
import type { FrozenAction, FrozenComponent } from "./types.js";

export interface ActionContext {
  requesterId: string;
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  sources: SourceRegistry;
}

export interface ApprovalCardSender {
  sendApprovalCard(action: PendingAction): Promise<unknown>;
}

const componentSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["statistics", "column", "bar", "line", "pie", "ring", "area", "combo", "scatter", "funnel", "wordCloud", "radar", "text"]),
  data_config: z.record(z.unknown()),
}).strict();

export class ActionService {
  constructor(
    private readonly state: StateStore,
    private readonly base: BaseResource,
    private readonly reader: SourceReader,
    private readonly cards: ApprovalCardSender,
  ) {}

  async proposeDashboardCreate(context: ActionContext, raw: unknown): Promise<PendingAction> {
    const input = z.object({
      source_id: z.string().min(1), dashboard_id: z.string().min(1),
      name: z.string().min(1).max(100),
      component_type: z.enum(["statistics", "column", "bar", "line", "pie", "ring", "area", "combo", "scatter", "funnel", "wordCloud", "radar", "text"]),
      data_config: z.record(z.unknown()),
    }).strict().parse(raw);
    const source = context.sources.require(input.source_id);
    const location = await this.base.resolve(source);
    const component = freezeComponent({
      name: input.name, type: input.component_type, data_config: input.data_config,
    });
    return this.save(context, {
      kind: "dashboard.component.create",
      target: { sourceId: source.id, baseToken: location.baseToken, dashboardId: input.dashboard_id },
      component,
      idempotencyKey: randomUUID(),
    });
  }

  async proposeDashboardUpdate(context: ActionContext, raw: unknown): Promise<PendingAction> {
    const input = z.object({
      source_id: z.string().min(1), dashboard_id: z.string().min(1), block_id: z.string().min(1),
      name: z.string().min(1).max(100).nullable(),
      data_config_patch: z.record(z.unknown()).nullable(),
    }).strict().parse(raw);
    if (input.name === null && input.data_config_patch === null) throw new Error("Dashboard update is empty");
    const source = context.sources.require(input.source_id);
    const location = await this.base.resolve(source);
    const current = normalizeComponent(await this.base.getDashboardBlock(location, input.dashboard_id, input.block_id));
    const after: FrozenComponent = {
      name: input.name ?? current.name,
      type: current.type,
      dataConfig: { ...current.dataConfig, ...(input.data_config_patch ?? {}) },
    };
    return this.save(context, {
      kind: "dashboard.component.update",
      target: { sourceId: source.id, baseToken: location.baseToken, dashboardId: input.dashboard_id, blockId: input.block_id },
      before: current,
      after,
      configHash: hash(current),
    });
  }

  proposeDocumentCreate(context: ActionContext, raw: unknown): Promise<PendingAction> {
    const input = z.object({ title: z.string().min(1).max(200), content_xml: z.string().min(1).max(100_000) }).strict().parse(raw);
    return this.save(context, {
      kind: "document.create", title: input.title, contentXml: input.content_xml, idempotencyKey: randomUUID(),
    });
  }

  async proposeDocumentAppend(context: ActionContext, raw: unknown): Promise<PendingAction> {
    const input = z.object({ source_id: z.string().min(1), content_xml: z.string().min(1).max(100_000) }).strict().parse(raw);
    const source = context.sources.require(input.source_id);
    const snapshot = await this.reader.inspectDocumentState(source);
    return this.save(context, {
      kind: "document.append", document: snapshot.document, contentXml: input.content_xml,
      revisionId: snapshot.revisionId, idempotencyKey: randomUUID(),
    });
  }

  async proposeDocumentReplace(context: ActionContext, raw: unknown): Promise<PendingAction> {
    const input = z.object({
      source_id: z.string().min(1), block_id: z.string().min(1), content_xml: z.string().min(1).max(100_000),
    }).strict().parse(raw);
    const source = context.sources.require(input.source_id);
    const block = await this.reader.inspectDocumentBlock(source, input.block_id);
    return this.save(context, {
      kind: "document.replace", document: block.document, blockId: block.blockId,
      oldContentHash: hash(block.content), contentXml: input.content_xml,
      revisionId: block.revisionId, idempotencyKey: randomUUID(),
    });
  }

  private async save(context: ActionContext, payload: FrozenAction): Promise<PendingAction> {
    const action: PendingAction = {
      id: `pa_${randomUUID()}`, requesterId: context.requesterId, chatId: context.chatId,
      rootMessageId: context.rootMessageId, threadId: context.threadId,
      expiresAt: Date.now() + 10 * 60_000, kind: payload.kind, payload,
    };
    this.state.createPendingAction(action);
    try {
      await this.cards.sendApprovalCard(action);
    } catch (error) {
      this.state.cancelPendingActionById(action.id, context.requesterId, context.chatId);
      throw error;
    }
    return action;
  }
}

function freezeComponent(input: z.infer<typeof componentSchema>): FrozenComponent {
  const parsed = componentSchema.parse(input);
  return {
    name: parsed.name,
    type: parsed.type,
    dataConfig: validateDashboardConfig(parsed.type, parsed.data_config, true),
  };
}

function normalizeComponent(value: unknown): FrozenComponent {
  const record = findRecord(value, ["block_id", "id"]);
  if (!record) throw new Error("Dashboard component response is invalid");
  const name = findString(record, ["name", "block_name"]);
  const type = z.enum(["statistics", "column", "bar", "line", "pie", "ring", "area", "combo", "scatter", "funnel", "wordCloud", "radar", "text"])
    .parse(findString(record, ["type", "block_type"]));
  const dataConfig = findRecord(record, ["data_config", "dataConfig"]);
  if (!name || !type || !dataConfig) throw new Error("Dashboard component configuration is incomplete");
  return { name, type, dataConfig };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function findString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string") return String(value[key]);
  return undefined;
}

function findRecord(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (keys.some((key) => key in record)) {
    for (const key of keys) {
      const candidate = record[key];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as Record<string, unknown>;
    }
    return record;
  }
  for (const child of Object.values(record)) {
    const found = findRecord(child, keys);
    if (found) return found;
  }
  return undefined;
}
