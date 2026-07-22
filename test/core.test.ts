import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyCliError } from "../src/lark/errors.js";
import { StateStore } from "../src/state/store.js";
import { shouldHandleEvent, writeMessageLog } from "../src/service/message-service.js";
import { addDashboardDateFilter } from "../src/agent/runner.js";
import { validateDashboardConfig } from "../src/lark/base-tools.js";

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

  test("writes received and sent message content as structured JSON", () => {
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    writeMessageLog("message.received", { message_id: "om_1", content: "分析来源分布" });
    writeMessageLog("message.sent", { reply_to_message_id: "om_1", content: "已完成分析" });
    write.mockRestore();

    expect(output.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ type: "message.received", message_id: "om_1", content: "分析来源分布" }),
      expect.objectContaining({ type: "message.sent", reply_to_message_id: "om_1", content: "已完成分析" }),
    ]);
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

  test("records an unknown external write outcome", () => {
    const store = new StateStore(":memory:");
    stores.push(store);
    store.createPendingAction({
      id: "pa_unknown", requesterId: "ou_owner", chatId: "oc_1", rootMessageId: "om_1",
      threadId: "om_1", expiresAt: 2000, kind: "component.create", payload: { name: "来源分布" },
    });
    expect(store.claimPendingAction("ou_owner", "oc_1", "om_1", 1500).ok).toBe(true);
    store.markActionUnknown("pa_unknown", "network timeout");
    expect(store.getPendingActionStatus("pa_unknown")).toBe("unknown");
  });
});

describe("dashboard filters", () => {
  test("uses numeric milliseconds for dashboard datetime filters", () => {
    const result = addDashboardDateFilter({ count_all: true }, "快照日期", "2026-07-22");
    const filter = result.filter as { conditions: Array<{ value: unknown }> };
    expect(filter.conditions[0]?.value).toBe(1784649600000);
  });

  test("does not add datasource fields to text components", () => {
    expect(addDashboardDateFilter({ text: "# 结论" }, "快照日期", "2026-07-22")).toEqual({ text: "# 结论" });
  });

  test("rejects invalid snapshot dates and mismatched component configs", () => {
    expect(() => addDashboardDateFilter({ count_all: true }, "快照日期", "2026-02-30")).toThrow(/YYYY-MM-DD/);
    expect(() => validateDashboardConfig("text", { count_all: true }, true)).toThrow();
    expect(() => validateDashboardConfig("ring", { count_all: true, series: [{ field_name: "阅读量估算", rollup: "SUM" }] }, true)).toThrow();
  });
});
