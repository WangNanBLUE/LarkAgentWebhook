import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyCliError } from "../src/lark/errors.js";
import { StateStore } from "../src/state/store.js";
import { MessageService, shouldHandleEvent, writeMessageLog } from "../src/service/message-service.js";
import { AgentRunner, addDashboardDateFilter, buildAggregateQuery } from "../src/agent/runner.js";
import { validateDashboardConfig } from "../src/lark/base-tools.js";
import { AGENT_INSTRUCTIONS } from "../src/agent/instructions.js";
import { loadConfig } from "../src/config.js";

const stores: StateStore[] = [];

const configEnv = {
  OPENAI_BASE_URL: "https://example.test/v1",
  OPENAI_API_KEY: "test-key",
  OPENAI_MODEL: "test-model",
  LARK_EXPECTED_APP_ID: "cli_test",
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("configuration", () => {
  test("system prompt rejects off-topic work and requires fresh data evidence", () => {
    expect(AGENT_INSTRUCTIONS).toContain("我只处理竞品书籍数据分析和 AI 分析看板维护");
    expect(AGENT_INSTRUCTIONS).toContain("本轮必须先成功调用 aggregate_books 或 query_books");
    expect(AGENT_INSTRUCTIONS).toContain("不得凭常识、历史对话或模型记忆作答");
  });

  test("defaults to streaming cards and supports explicit text mode", () => {
    expect(loadConfig(configEnv).lark.responseMode).toBe("streaming_card");
    expect(loadConfig({ ...configEnv, LARK_RESPONSE_MODE: "text" }).lark.responseMode).toBe("text");
  });

  test("rejects unknown response modes", () => {
    expect(() => loadConfig({ ...configEnv, LARK_RESPONSE_MODE: "invalid" })).toThrow();
  });
});

describe("agent streaming", () => {
  test("streams text and reports tool progress across response rounds", async () => {
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "get_source_schema",
      arguments: "{}",
      status: "completed",
    };
    const makeStream = (events: unknown[], response: unknown) => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
      finalResponse: vi.fn(async () => response),
    });
    const responses = {
      stream: vi.fn()
        .mockReturnValueOnce(makeStream([
          { type: "response.output_item.added", item: call },
        ], { output: [call], output_text: "" }))
        .mockReturnValueOnce(makeStream([
          { type: "response.output_text.delta", delta: "分析" },
          { type: "response.output_text.delta", delta: "完成" },
        ], { output: [{ type: "message" }], output_text: "分析完成" })),
    };
    const tools = { getSourceSchema: vi.fn(async () => ({ fields: [] })) };
    const observer = {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };
    const runner = new AgentRunner(
      loadConfig(configEnv),
      tools as never,
      {} as never,
      responses as never,
    );

    const answer = await runner.run({
      event: {
        message_id: "om_1",
        chat_id: "oc_1",
        sender_id: "ou_1",
        chat_type: "p2p",
        content: "分析",
      },
      prompt: "分析",
      conversationKey: "om_1",
    }, observer);

    expect(observer.onToolStart).toHaveBeenCalledWith("get_source_schema");
    expect(observer.onToolEnd).toHaveBeenCalledTimes(1);
    expect(observer.onTextDelta).toHaveBeenNthCalledWith(1, "分析", "分析");
    expect(observer.onTextDelta).toHaveBeenNthCalledWith(2, "完成", "分析完成");
    expect(answer).toBe("分析完成");
    expect(responses.stream).toHaveBeenCalledTimes(2);
  });

  test("falls back to textual tool results when the upstream rejects function outputs", async () => {
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "get_source_schema",
      arguments: "{}",
      status: "completed",
    };
    const makeStream = (events: unknown[], response: unknown) => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
      finalResponse: vi.fn(async () => response),
    });
    const upstreamError = Object.assign(new Error("502 Upstream request failed"), { status: 502 });
    const responses = {
      stream: vi.fn()
        .mockReturnValueOnce(makeStream([], { output: [call], output_text: "" }))
        .mockImplementationOnce(() => { throw upstreamError; })
        .mockReturnValueOnce(makeStream([
          { type: "response.output_text.delta", delta: "分析完成" },
        ], { output: [{ type: "message" }], output_text: "" })),
    };
    const tools = { getSourceSchema: vi.fn(async () => ({ fields: [] })) };
    const runner = new AgentRunner(
      loadConfig(configEnv),
      tools as never,
      {} as never,
      responses as never,
    );

    const answer = await runner.run({
      event: {
        message_id: "om_compat",
        chat_id: "oc_1",
        sender_id: "ou_1",
        chat_type: "p2p",
        content: "分析",
      },
      prompt: "分析",
      conversationKey: "om_compat",
    });

    const compatibilityInput = responses.stream.mock.calls[2]?.[0]?.input as Array<Record<string, unknown>>;
    expect(answer).toBe("分析完成");
    expect(tools.getSourceSchema).toHaveBeenCalledTimes(1);
    expect(responses.stream).toHaveBeenCalledTimes(3);
    expect(compatibilityInput.some((item) => item.type === "function_call_output")).toBe(false);
    expect(JSON.stringify(compatibilityInput)).toContain("工具调用记录");
    expect(JSON.stringify(compatibilityInput)).toContain("fields");

    responses.stream
      .mockReturnValueOnce(makeStream([], { output: [call], output_text: "" }))
      .mockReturnValueOnce(makeStream([
        { type: "response.output_text.delta", delta: "再次完成" },
      ], { output: [{ type: "message" }], output_text: "" }));

    const secondAnswer = await runner.run({
      event: {
        message_id: "om_compat_2",
        chat_id: "oc_1",
        sender_id: "ou_1",
        chat_type: "p2p",
        content: "再次分析",
      },
      prompt: "再次分析",
      conversationKey: "om_compat_2",
    });
    const cachedCompatibilityInput = responses.stream.mock.calls[4]?.[0]?.input as Array<Record<string, unknown>>;

    expect(secondAnswer).toBe("再次完成");
    expect(responses.stream).toHaveBeenCalledTimes(5);
    expect(cachedCompatibilityInput.some((item) => item.type === "function_call_output")).toBe(false);
    expect(JSON.stringify(cachedCompatibilityInput)).toContain("工具调用记录");
  });
});

describe("CLI failures", () => {
  test("treats rate limits as retryable and permissions as terminal", () => {
    expect(classifyCliError({ type: "api", subtype: "rate_limit" }).retryable).toBe(true);
    expect(classifyCliError({ type: "authorization", subtype: "missing_scope" }).retryable).toBe(false);
  });
});

describe("message routing", () => {
  test("accepts direct messages and only mentioned group messages", () => {
    const base = {
      message_id: "om_1",
      chat_id: "oc_1",
      sender_id: "ou_user",
      chat_type: "group" as const,
      content: "分析来源分布",
      mentions: [{ id: "ou_bot", key: "@_user_1", name: "竞品分析" }],
    };

    expect(shouldHandleEvent(base, "ou_bot")).toBe(true);
    expect(shouldHandleEvent({ ...base, chat_type: "p2p", mentions: undefined }, "ou_bot")).toBe(true);
    expect(shouldHandleEvent({ ...base, mentions: undefined }, "ou_bot")).toBe(false);
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

  test("replies to direct messages in the main chat stream", async () => {
    const event = {
      message_id: "om_dm",
      chat_id: "oc_dm",
      sender_id: "ou_user",
      chat_type: "p2p" as const,
      content: "你好",
    };
    const state = { markMessageProcessed: vi.fn(() => true) };
    const agent = { run: vi.fn(async () => "你好，有什么可以帮你？") };
    const tools = { reply: vi.fn(async () => ({})), sendToChat: vi.fn(async () => ({})) };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await new MessageService("ou_bot", state as never, agent as never, tools as never).handle(event);
    write.mockRestore();

    expect(tools.reply).toHaveBeenCalledWith("om_dm", "你好，有什么可以帮你？", false);
  });

  test("replies to mentioned group messages in the main stream and mentions the sender", async () => {
    const event = {
      message_id: "om_group",
      chat_id: "oc_group",
      sender_id: "ou_sender",
      chat_type: "group" as const,
      content: "@竞品分析 分析来源分布",
      mentions: [{ id: "ou_bot", key: "@_user_1", name: "竞品分析" }],
    };
    const state = { markMessageProcessed: vi.fn(() => true) };
    const agent = { run: vi.fn(async () => "分析完成") };
    const tools = { reply: vi.fn(async () => ({})), sendToChat: vi.fn(async () => ({})) };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await new MessageService("ou_bot", state as never, agent as never, tools as never).handle(event);
    write.mockRestore();

    expect(tools.sendToChat).toHaveBeenCalledWith(
      "oc_group",
      '<at user_id="ou_sender"></at> 分析完成',
    );
    expect(tools.reply).not.toHaveBeenCalled();
  });

  test("streams a card before running the agent and forwards progress", async () => {
    const order: string[] = [];
    const event = {
      message_id: "om_stream",
      chat_id: "oc_group",
      sender_id: "ou_sender",
      chat_type: "group" as const,
      content: "@竞品分析 分析来源分布",
      mentions: [{ id: "ou_bot", key: "@_user_1", name: "竞品分析" }],
    };
    const state = { markMessageProcessed: vi.fn(() => true) };
    const session = {
      appendText: vi.fn(),
      setStatus: vi.fn(),
      finish: vi.fn(async () => true),
      fail: vi.fn(async () => true),
    };
    const cards = { start: vi.fn(async () => { order.push("card.start"); return session; }) };
    const agent = { run: vi.fn(async (_context, observer) => {
      order.push("agent.run");
      observer.onTextDelta("分析", "分析");
      observer.onToolStart("aggregate_books");
      observer.onToolEnd();
      observer.onTextDelta("完成", "分析完成");
      return "分析完成";
    }) };
    const tools = { reply: vi.fn(async () => ({})), sendToChat: vi.fn(async () => ({})) };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await new MessageService(
      "ou_bot", state as never, agent as never, tools as never, "streaming_card", cards as never,
    ).handle(event);
    write.mockRestore();

    expect(order.slice(0, 2)).toEqual(["card.start", "agent.run"]);
    expect(session.appendText).toHaveBeenNthCalledWith(1, "分析");
    expect(session.appendText).toHaveBeenNthCalledWith(2, "完成");
    expect(session.setStatus).toHaveBeenNthCalledWith(1, "querying");
    expect(session.setStatus).toHaveBeenNthCalledWith(2, "summarizing");
    expect(session.finish).toHaveBeenCalledWith("分析完成");
    expect(tools.reply).not.toHaveBeenCalled();
  });

  test("falls back once in the group thread when card creation fails", async () => {
    const event = {
      message_id: "om_start_failure",
      chat_id: "oc_group",
      sender_id: "ou_sender",
      chat_type: "group" as const,
      content: "@竞品分析 分析",
      mentions: [{ id: "ou_bot", key: "@_user_1", name: "竞品分析" }],
    };
    const state = { markMessageProcessed: vi.fn(() => true) };
    const agent = { run: vi.fn(async () => "分析完成") };
    const tools = { reply: vi.fn(async () => ({})), sendToChat: vi.fn(async () => ({})) };
    const cards = { start: vi.fn(async () => { throw new Error("missing scope"); }) };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await new MessageService(
      "ou_bot", state as never, agent as never, tools as never, "streaming_card", cards as never,
    ).handle(event);
    stdout.mockRestore();
    stderr.mockRestore();

    expect(tools.sendToChat).toHaveBeenCalledTimes(1);
    expect(tools.sendToChat).toHaveBeenCalledWith(
      "oc_group",
      expect.stringContaining("分析完成"),
    );
  });

  test("falls back once when the final card update fails", async () => {
    const event = {
      message_id: "om_finish_failure",
      chat_id: "oc_group",
      sender_id: "ou_sender",
      chat_type: "group" as const,
      content: "@竞品分析 分析",
      mentions: [{ id: "ou_bot", key: "@_user_1", name: "竞品分析" }],
    };
    const state = { markMessageProcessed: vi.fn(() => true) };
    const agent = { run: vi.fn(async () => "分析完成") };
    const tools = { reply: vi.fn(async () => ({})), sendToChat: vi.fn(async () => ({})) };
    const session = {
      appendText: vi.fn(), setStatus: vi.fn(), finish: vi.fn(async () => false), fail: vi.fn(async () => false),
    };
    const cards = { start: vi.fn(async () => session) };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await new MessageService(
      "ou_bot", state as never, agent as never, tools as never, "streaming_card", cards as never,
    ).handle(event);
    stdout.mockRestore();

    expect(tools.sendToChat).toHaveBeenCalledTimes(1);
    expect(tools.sendToChat).toHaveBeenCalledWith(
      "oc_group",
      expect.stringContaining("分析完成"),
    );
  });

  test("keeps explicit text mode in the main chat stream", async () => {
    const event = {
      message_id: "om_text",
      chat_id: "oc_group",
      sender_id: "ou_sender",
      chat_type: "group" as const,
      content: "@竞品分析 分析",
      mentions: [{ id: "ou_bot", key: "@_user_1", name: "竞品分析" }],
    };
    const state = { markMessageProcessed: vi.fn(() => true) };
    const agent = { run: vi.fn(async () => "分析完成") };
    const tools = { reply: vi.fn(async () => ({})), sendToChat: vi.fn(async () => ({})) };
    const cards = { start: vi.fn() };
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await new MessageService(
      "ou_bot", state as never, agent as never, tools as never, "text", cards as never,
    ).handle(event);
    stdout.mockRestore();

    expect(cards.start).not.toHaveBeenCalled();
    expect(tools.sendToChat).toHaveBeenCalledWith(
      "oc_group",
      expect.stringContaining("分析完成"),
    );
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

describe("aggregate tool input", () => {
  test("builds valid Base DSL from typed model arguments", () => {
    expect(buildAggregateQuery({
      dimensions: [{ field_name: "榜单题材", alias: "genre" }],
      measures: [{ field_name: "书籍ID", aggregation: "count", alias: "book_count" }],
      filters: [],
      filter_conjunction: "and",
      sort: [{ field_name: "book_count", order: "desc" }],
      limit: 10,
    })).toEqual({
      dimensions: [{ field_name: "榜单题材", alias: "genre" }],
      measures: [{ field_name: "书籍ID", aggregation: "count", alias: "book_count" }],
      sort: [{ field_name: "book_count", order: "desc" }],
      pagination: { limit: 10 },
    });
  });
});
