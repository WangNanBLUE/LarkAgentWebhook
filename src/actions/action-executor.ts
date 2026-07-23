import { createHash } from "node:crypto";
import type { BaseResource } from "../lark/base-resource.js";
import type { LarkCli } from "../lark/cli.js";
import { LarkCliError } from "../lark/errors.js";
import type { SourceReader } from "../lark/source-reader.js";
import type { StateStore } from "../state/store.js";
import type { PendingAction } from "../types.js";
import type { ComponentType } from "../types.js";
import type { FrozenAction, FrozenComponent } from "./types.js";

export class ActionExecutionError extends Error {
  constructor(message: string, readonly outcome: "failed" | "unknown") {
    super(message);
  }
}

export class ActionExecutor {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cli: LarkCli,
    private readonly state: StateStore,
    private readonly base: BaseResource,
    private readonly reader: SourceReader,
  ) {}

  execute(action: PendingAction): Promise<unknown> {
    const run = () => this.executeClassified(action);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async executeClassified(action: PendingAction): Promise<unknown> {
    try {
      return await this.executeFrozen(action);
    } catch (error) {
      if (error instanceof ActionExecutionError) throw error;
      const outcome = error instanceof LarkCliError && !error.retryable ? "failed" : "unknown";
      throw new ActionExecutionError(messageOf(error), outcome);
    }
  }

  async reconcileExecutingActions(): Promise<void> {
    for (const item of this.state.listExecutingActions()) {
      const payload = item.action.payload;
      if (payload.kind !== "dashboard.component.create") {
        this.state.markActionUnknown(item.action.id, "Service restarted while the external write was in progress");
        continue;
      }
      const context = item.reconciliation as { existingBlockIds?: string[] } | undefined;
      if (!context?.existingBlockIds) {
        this.state.markActionUnknown(item.action.id, "Dashboard create reconciliation metadata is missing");
        continue;
      }
      try {
        const location = { sourceId: payload.target.sourceId, baseToken: payload.target.baseToken };
        const items = findArray(await this.base.listDashboardBlocks(location, payload.target.dashboardId), "items");
        const previous = new Set(context.existingBlockIds);
        const match = items.find((item) => {
          const id = findString(item, ["block_id", "id"]);
          return id && !previous.has(id) && findString(item, ["name", "block_name"]) === payload.component.name;
        });
        const blockId = match ? findString(match, ["block_id", "id"]) : undefined;
        if (blockId) this.state.markActionCompleted(item.action.id, { action: "created_reconciled", block_id: blockId });
        else this.state.markActionUnknown(item.action.id, "No matching component was found during reconciliation");
      } catch (error) {
        this.state.markActionUnknown(item.action.id, messageOf(error));
      }
    }
  }

  private async executeFrozen(action: PendingAction): Promise<unknown> {
    const payload = action.payload;
    switch (payload.kind) {
      case "dashboard.component.create":
        return this.createDashboardComponent(action.id, payload);
      case "dashboard.component.update":
        return this.updateDashboardComponent(payload);
      case "document.create":
        return this.write(() => this.cli.run([
          "docs", "+create", "--title", payload.title, "--content", payload.contentXml,
          "--as", "bot", "--format", "json",
        ]));
      case "document.append":
        await this.assertDocumentRevision(payload.document, payload.revisionId);
        return this.write(() => this.cli.run([
          "docs", "+update", "--doc", payload.document, "--command", "append",
          "--content", payload.contentXml, "--revision-id", String(payload.revisionId),
          "--as", "bot", "--format", "json",
        ]));
      case "document.replace":
        await this.assertDocumentReplaceState(payload);
        return this.write(() => this.cli.run([
          "docs", "+update", "--doc", payload.document, "--command", "block_replace",
          "--block-id", payload.blockId, "--content", payload.contentXml,
          "--revision-id", String(payload.revisionId), "--as", "bot", "--format", "json",
        ]));
    }
  }

  private async createDashboardComponent(actionId: string, payload: Extract<FrozenAction, { kind: "dashboard.component.create" }>): Promise<unknown> {
    const location = { sourceId: payload.target.sourceId, baseToken: payload.target.baseToken };
    const before = findArray(await this.base.listDashboardBlocks(location, payload.target.dashboardId), "items")
      .map((item) => findString(item, ["block_id", "id"])).filter((id): id is string => Boolean(id));
    this.state.setActionReconciliation(actionId, { existingBlockIds: before });
    return this.write(() => this.cli.run([
      "base", "+dashboard-block-create", "--base-token", payload.target.baseToken,
      "--dashboard-id", payload.target.dashboardId, "--name", payload.component.name,
      "--type", payload.component.type, "--data-config", JSON.stringify(payload.component.dataConfig),
      "--as", "bot", "--format", "json",
    ]));
  }

  private async updateDashboardComponent(payload: Extract<FrozenAction, { kind: "dashboard.component.update" }>): Promise<unknown> {
    const location = { sourceId: payload.target.sourceId, baseToken: payload.target.baseToken };
    const current = normalizeComponent(await this.base.getDashboardBlock(location, payload.target.dashboardId, payload.target.blockId));
    if (hash(current) !== payload.configHash) throw new ActionExecutionError("Dashboard component changed after approval preview", "failed");
    return this.write(() => this.cli.run([
      "base", "+dashboard-block-update", "--base-token", payload.target.baseToken,
      "--dashboard-id", payload.target.dashboardId, "--block-id", payload.target.blockId,
      "--name", payload.after.name, "--data-config", JSON.stringify(payload.after.dataConfig),
      "--as", "bot", "--format", "json",
    ]));
  }

  private async assertDocumentRevision(document: string, revisionId: number): Promise<void> {
    const current = await this.reader.inspectDocumentState({
      id: "src_revision_check", kind: "document", title: "revision check", url: document,
    });
    if (current.revisionId !== revisionId) throw new ActionExecutionError("Document changed after approval preview", "failed");
  }

  private async assertDocumentReplaceState(payload: Extract<FrozenAction, { kind: "document.replace" }>): Promise<void> {
    const current = await this.reader.inspectDocumentBlock({
      id: "src_revision_check", kind: "document", title: "revision check", url: payload.document,
    }, payload.blockId);
    if (current.revisionId !== payload.revisionId) throw new ActionExecutionError("Document changed after approval preview", "failed");
    if (hash(current.content) !== payload.oldContentHash) {
      throw new ActionExecutionError("Document block changed after approval preview", "failed");
    }
  }

  private async write(run: () => Promise<unknown>): Promise<unknown> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ActionExecutionError) throw error;
      const outcome = error instanceof LarkCliError && !error.retryable ? "failed" : "unknown";
      throw new ActionExecutionError(messageOf(error), outcome);
    }
  }
}

function normalizeComponent(value: unknown): FrozenComponent {
  const record = findRecordWith(value, ["block_id", "id"]);
  if (!record) throw new ActionExecutionError("Dashboard component response is invalid", "failed");
  const name = findString(record, ["name", "block_name"]);
  const type = findString(record, ["type", "block_type"]) as ComponentType | undefined;
  const dataConfig = findRecordWith(record, ["data_config", "dataConfig"], true);
  if (!name || !type || !dataConfig) throw new ActionExecutionError("Dashboard component configuration is incomplete", "failed");
  return { name, type, dataConfig };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "string") return String(record[key]);
  for (const child of Object.values(record)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return undefined;
}

function findRecordWith(value: unknown, keys: string[], returnValue = false): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (!(key in record)) continue;
    const candidate = record[key];
    if (returnValue && candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as Record<string, unknown>;
    return record;
  }
  for (const child of Object.values(record)) {
    const found = findRecordWith(child, keys, returnValue);
    if (found) return found;
  }
  return undefined;
}

function findArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record[key])) return record[key] as unknown[];
  for (const child of Object.values(record)) {
    const found = findArray(child, key);
    if (found.length) return found;
  }
  return Array.isArray(value) ? value : [];
}
