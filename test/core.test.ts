import { afterEach, describe, expect, test } from "vitest";
import { classifyCliError } from "../src/lark/errors.js";
import { StateStore } from "../src/state/store.js";
import { shouldHandleEvent } from "../src/service/message-service.js";

const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("CLI failures", () => {
  test("treats rate limits as retryable and permissions as terminal", () => {
    expect(classifyCliError({ type: "api", subtype: "rate_limit" }).retryable).toBe(true);
    expect(classifyCliError({ type: "authorization", subtype: "missing_scope" }).retryable).toBe(false);
  });
});

describe("message routing", () => {
  test("accepts only group messages that mention this bot", () => {
    const base = {
      message_id: "om_1",
      chat_id: "oc_1",
      sender_id: "ou_user",
      chat_type: "group" as const,
      content: "分析来源分布",
      mentions: [{ id: "ou_bot", key: "@_user_1", name: "竞品分析" }],
    };

    expect(shouldHandleEvent(base, "ou_bot")).toBe(true);
    expect(shouldHandleEvent({ ...base, chat_type: "p2p" }, "ou_bot")).toBe(false);
    expect(shouldHandleEvent(base, "ou_other_bot")).toBe(false);
  });
});

describe("state", () => {
  test("deduplicates message IDs", () => {
    const store = new StateStore(":memory:");
    stores.push(store);

    expect(store.markMessageProcessed("om_1", 1000)).toBe(true);
    expect(store.markMessageProcessed("om_1", 1001)).toBe(false);
  });

  test("claims a pending action once for its owner and thread before expiry", () => {
    const store = new StateStore(":memory:");
    stores.push(store);
    store.createPendingAction({
      id: "pa_1",
      requesterId: "ou_owner",
      chatId: "oc_1",
      rootMessageId: "om_root",
      threadId: "omt_1",
      expiresAt: 2000,
      kind: "component.create",
      payload: { name: "来源分布" },
    });

    expect(store.claimPendingAction("ou_other", "oc_1", "omt_1", 1500)).toEqual({ ok: false, reason: "not_found" });

    const claimed = store.claimPendingAction("ou_owner", "oc_1", "omt_1", 1500);
    expect(claimed.ok).toBe(true);
    expect(store.claimPendingAction("ou_owner", "oc_1", "omt_1", 1500)).toEqual({ ok: false, reason: "not_found" });

    store.createPendingAction({
      id: "pa_2",
      requesterId: "ou_owner",
      chatId: "oc_1",
      rootMessageId: "om_root_2",
      threadId: "omt_1",
      expiresAt: 1000,
      kind: "component.update",
      payload: { name: "来源分布 2" },
    });
    expect(store.claimPendingAction("ou_owner", "oc_1", "omt_1", 1001)).toEqual({ ok: false, reason: "expired" });
  });
});
