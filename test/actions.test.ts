import { afterEach, describe, expect, test, vi } from "vitest";
import { ActionExecutionError, ActionExecutor } from "../src/actions/action-executor.js";
import { ActionService } from "../src/actions/action-service.js";
import { SourceRegistry } from "../src/sources/registry.js";
import { StateStore } from "../src/state/store.js";
import type { PendingAction } from "../src/types.js";

const stores: StateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function context(prompt: string) {
  return {
    requesterId: "ou_1", chatId: "oc_1", rootMessageId: "om_1",
    sources: SourceRegistry.fromPrompt(prompt, { idFactory: () => prompt.includes("/base/") ? "src_base" : "src_doc" }),
  };
}

describe("frozen actions", () => {
  test("freezes an arbitrary dashboard component update and only sends an approval card", async () => {
    const state = new StateStore(":memory:");
    stores.push(state);
    const base = {
      resolve: vi.fn(async () => ({ sourceId: "src_base", baseToken: "bas_1" })),
      getDashboardBlock: vi.fn(async () => ({
        block_id: "blk_1", name: "收入趋势", type: "line",
        data_config: { table_name: "销售", count_all: true, group_by: [{ field_name: "月份", mode: "integrated" }] },
      })),
    };
    const cards = { sendApprovalCard: vi.fn(async () => ({})) };
    const service = new ActionService(state, base as never, {} as never, cards);

    const action = await service.proposeDashboardUpdate(
      context("https://a.feishu.cn/base/bas_1"),
      {
        source_id: "src_base", dashboard_id: "dash_1", block_id: "blk_1",
        name: "收入趋势（更新）", data_config_patch: { group_by: [{ field_name: "地区", mode: "integrated" }] },
      },
    );

    expect(action.kind).toBe("dashboard.component.update");
    expect(action.payload).toMatchObject({
      target: { baseToken: "bas_1", dashboardId: "dash_1", blockId: "blk_1" },
      before: { name: "收入趋势" },
      after: { name: "收入趋势（更新）" },
    });
    expect(state.getPendingActionStatus(action.id)).toBe("pending");
    expect(cards.sendApprovalCard).toHaveBeenCalledWith(action);
  });

  test("freezes document revision before append without writing", async () => {
    const state = new StateStore(":memory:");
    stores.push(state);
    const reader = {
      inspectDocumentState: vi.fn(async () => ({
        document: "https://a.feishu.cn/docx/doc_1", revisionId: 12, blocks: [],
      })),
    };
    const cards = { sendApprovalCard: vi.fn(async () => ({})) };
    const service = new ActionService(state, {} as never, reader as never, cards);
    const action = await service.proposeDocumentAppend(
      context("https://a.feishu.cn/docx/doc_1"),
      { source_id: "src_doc", content_xml: "<p>补充</p>" },
    );

    expect(action.payload).toMatchObject({ kind: "document.append", revisionId: 12, contentXml: "<p>补充</p>" });
    expect(state.getPendingActionStatus(action.id)).toBe("pending");
  });

  test("rejects a stale document revision before append", async () => {
    const state = new StateStore(":memory:");
    stores.push(state);
    const cli = { run: vi.fn() };
    const reader = { inspectDocumentState: vi.fn(async () => ({ document: "doc_1", revisionId: 13, blocks: [] })) };
    const executor = new ActionExecutor(cli as never, state, {} as never, reader as never);
    const action: PendingAction = {
      id: "pa_append", requesterId: "ou_1", chatId: "oc_1", rootMessageId: "om_1",
      expiresAt: Date.now() + 60_000, kind: "document.append",
      payload: {
        kind: "document.append", document: "https://a.feishu.cn/docx/doc_1",
        contentXml: "<p>补充</p>", revisionId: 12, idempotencyKey: "idem_1",
      },
    };

    await expect(executor.execute(action)).rejects.toEqual(expect.objectContaining({
      outcome: "failed",
    }));
    expect(cli.run).not.toHaveBeenCalled();
  });
});
