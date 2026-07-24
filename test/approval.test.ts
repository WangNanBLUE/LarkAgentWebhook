import { afterEach, describe, expect, test, vi } from "vitest";
import { buildApprovalCard } from "../src/lark/approval-card.js";
import { ApprovalService } from "../src/service/approval-service.js";
import { StateStore } from "../src/state/store.js";
import type { PendingAction } from "../src/types.js";

const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function pendingAction(): PendingAction {
  return {
    id: "pa_1",
    requesterId: "ou_owner",
    chatId: "oc_1",
    rootMessageId: "om_1",
    expiresAt: Date.now() + 600_000,
    kind: "dashboard.component.create",
    payload: {
      kind: "dashboard.component.create",
      target: { sourceId: "src_base", baseToken: "bas_1", dashboardId: "dash_1" },
      component: { name: "按书籍来源分布", type: "ring", dataConfig: { table_name: "竞品书籍快照", count_all: true, group_by: [{ field_name: "来源", mode: "integrated" }] } },
      idempotencyKey: "idem_1",
    },
  };
}

describe("approval cards", () => {
  test("carries the proposal id in confirm and cancel callbacks", () => {
    const card = buildApprovalCard(pendingAction(), "pending");
    const serialized = JSON.stringify(card);

    expect(card).toMatchObject({ schema: "2.0", header: { template: "yellow" } });
    expect(serialized).toContain('"action":"confirm"');
    expect(serialized).toContain('"action":"cancel"');
    expect(serialized.match(/"proposal_id":"pa_1"/g)).toHaveLength(2);
  });

  test("confirms by proposal id only for the owner in the original chat", async () => {
    const state = new StateStore(":memory:");
    stores.push(state);
    state.createPendingAction(pendingAction());
    const executor = {
      execute: vi.fn(async () => ({ action: "created", block_id: "cht_1" })),
    };
    const tools = {
      updateInteractiveCard: vi.fn(async () => ({})),
      sendToChat: vi.fn(async () => ({})),
    };
    const service = new ApprovalService(state, executor as never, tools as never);

    await service.handle({
      type: "card.action.trigger",
      event_id: "evt_1",
      operator_id: "ou_owner",
      message_id: "om_card",
      chat_id: "oc_1",
      token: "token_1",
      action_tag: "button",
      action_value: JSON.stringify({ action: "confirm", proposal_id: "pa_1" }),
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(state.getPendingActionStatus("pa_1")).toBe("completed");
    expect(tools.updateInteractiveCard).toHaveBeenCalledTimes(2);

    await service.handle({
      type: "card.action.trigger",
      event_id: "evt_2",
      operator_id: "ou_owner",
      message_id: "om_card",
      chat_id: "oc_1",
      token: "token_2",
      action_tag: "button",
      action_value: JSON.stringify({ action: "confirm", proposal_id: "pa_1" }),
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  test("rejects another operator without consuming the proposal", async () => {
    const state = new StateStore(":memory:");
    stores.push(state);
    state.createPendingAction(pendingAction());
    const executor = { execute: vi.fn() };
    const tools = {
      updateInteractiveCard: vi.fn(),
      sendToChat: vi.fn(async () => ({})),
    };
    const service = new ApprovalService(state, executor as never, tools as never);

    await service.handle({
      type: "card.action.trigger",
      event_id: "evt_other",
      operator_id: "ou_other",
      message_id: "om_card",
      chat_id: "oc_1",
      token: "token_1",
      action_tag: "button",
      action_value: JSON.stringify({ action: "confirm", proposal_id: "pa_1" }),
    });

    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.getPendingActionStatus("pa_1")).toBe("pending");
    expect(tools.sendToChat).toHaveBeenCalledWith("oc_1", expect.stringContaining("ou_other"));
  });
});
