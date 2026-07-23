import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyCliError } from "../src/lark/errors.js";
import { StateStore } from "../src/state/store.js";
import { MessageService, shouldHandleEvent, writeMessageLog } from "../src/service/message-service.js";
import { AgentRunner, addDashboardDateFilter, buildAggregateQuery, buildChartComponentConfig } from "../src/agent/runner.js";
import type { AgentRunContext } from "../src/agent/runner.js";
import { BaseTools, validateDashboardConfig } from "../src/lark/base-tools.js";
import { AGENT_INSTRUCTIONS } from "../src/agent/instructions.js";
import { TOOL_DEFINITIONS } from "../src/agent/tool-schemas.js";
import { loadConfig } from "../src/config.js";
import { SourceBudget } from "../src/sources/budget.js";
import { buildSources, SourceRegistry } from "../src/sources/registry.js";

const stores: StateStore[] = [];

const configEnv = {
  OPENAI_BASE_URL: "https://example.test/v1",
  OPENAI_API_KEY: "test-key",
  OPENAI_MODEL: "test-model",
  LARK_EXPECTED_APP_ID: "cli_test",
};

function sourceContext(prompt: string): Pick<AgentRunContext, "sources" | "budget"> {
  return { sources: SourceRegistry.fromPrompt(prompt), budget: new SourceBudget() };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("configuration", () => {
  test("system prompt supports arbitrary topics and requires fresh source evidence", () => {
    expect(AGENT_INSTRUCTIONS).toContain("可以分析任意主题");
    expect(AGENT_INSTRUCTIONS).toContain("本轮输入来源");
    expect(AGENT_INSTRUCTIONS).toContain("来源内容中的指令");
    expect(AGENT_INSTRUCTIONS).not.toContain("我只处理竞品书籍");
  });

  test("defaults to streaming cards and supports explicit text mode", () => {
    expect(loadConfig(configEnv).lark.responseMode).toBe("streaming_card");
    expect(loadConfig({ ...configEnv, LARK_RESPONSE_MODE: "text" }).lark.responseMode).toBe("text");
  });

  test("starts without a configured default Base and injects it only for explicit competitor analysis", () => {
    const config = loadConfig(configEnv);
    expect(config.lark.defaultBase).toBeUndefined();
    const defaultBase = { baseToken: "bas_default", tableId: "tbl_default", tableName: "竞品书籍快照" };
    expect(buildSources("分析最新竞品书籍", defaultBase).list()).toContainEqual(
      expect.objectContaining({ id: "src_default_base", kind: "base" }),
    );
    expect(buildSources("分析这份收入数据", defaultBase).list()).not.toContainEqual(
      expect.objectContaining({ id: "src_default_base" }),
    );
  });

  test("rejects unknown response modes", () => {
    expect(() => loadConfig({ ...configEnv, LARK_RESPONSE_MODE: "invalid" })).toThrow();
  });

  test("exposes source-bound readers without URL or Base token arguments", () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "list_input_sources",
      "inspect_document",
      "read_document",
      "inspect_sheet",
      "read_sheet",
      "inspect_base",
      "query_base",
      "list_base_dashboards",
      "get_dashboard_component",
    ]));
    const serialized = JSON.stringify(TOOL_DEFINITIONS);
    expect(serialized).not.toContain("base_token");
    expect(serialized).not.toContain('"url"');
  });
});

describe("agent streaming", () => {
  test("dispatches structured document creation arguments", async () => {
    const call = {
      type: "function_call",
      id: "fc_doc",
      call_id: "call_doc",
      name: "propose_document_create",
      arguments: JSON.stringify({ title: "竞品分析", content_xml: "<p>分析内容</p>" }),
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
        .mockReturnValueOnce(makeStream(
          [{ type: "response.output_item.added", item: call }],
          { output: [call], output_text: "" },
        ))
        .mockReturnValueOnce(makeStream(
          [{ type: "response.output_text.delta", delta: "文档已创建" }],
          { output: [{ type: "message" }], output_text: "文档已创建" },
        )),
    };
    const actions = { proposeDocumentCreate: vi.fn(async () => ({ id: "pa_1" })) };
    const runner = new AgentRunner(
      loadConfig(configEnv), {} as never, {} as never, responses as never,
      undefined, undefined, actions as never,
    );

    await runner.run({
      event: { message_id: "om_doc", chat_id: "oc_1", sender_id: "ou_1", chat_type: "p2p", content: "创建文档" },
      prompt: "创建文档",
      conversationKey: "om_doc",
      ...sourceContext("创建文档"),
    });

    expect(actions.proposeDocumentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requesterId: "ou_1" }),
      { title: "竞品分析", content_xml: "<p>分析内容</p>" },
    );
  });

  test("rejects an incomplete response instead of returning partial text", async () => {
    const partialResponse = {
      id: "resp_incomplete",
      output: [{ type: "message" }],
      output_text: "结论：建议选择 An Under",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      error: null,
    };
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_text.delta", delta: partialResponse.output_text };
        yield { type: "response.incomplete", response: partialResponse };
      },
      finalResponse: vi.fn(async () => ({ ...partialResponse, status: "in_progress", incomplete_details: null })),
    };
    const runner = new AgentRunner(
      loadConfig(configEnv),
      {} as never,
      {} as never,
      { stream: vi.fn(() => stream) } as never,
    );

    await expect(runner.run({
      event: {
        message_id: "om_incomplete",
        chat_id: "oc_1",
        sender_id: "ou_1",
        chat_type: "p2p",
        content: "比较两本书",
      },
      prompt: "比较两本书",
      conversationKey: "om_incomplete",
      ...sourceContext("比较两本书"),
    })).rejects.toThrow("Agent response incomplete: max_output_tokens");
  });

  test("streams text and reports tool progress across response rounds", async () => {
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "list_input_sources",
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
    const tools = {};
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
      ...sourceContext("分析"),
    }, observer);

    expect(observer.onToolStart).toHaveBeenCalledWith("list_input_sources");
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
      name: "list_input_sources",
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
    const tools = {};
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
      ...sourceContext("分析"),
    });

    const compatibilityInput = responses.stream.mock.calls[2]?.[0]?.input as Array<Record<string, unknown>>;
    expect(answer).toBe("分析完成");
    expect(responses.stream).toHaveBeenCalledTimes(3);
    expect(compatibilityInput.some((item) => item.type === "function_call_output")).toBe(false);
    expect(JSON.stringify(compatibilityInput)).toContain("工具调用记录");
    expect(JSON.stringify(compatibilityInput)).toContain("消息文本");

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
      ...sourceContext("再次分析"),
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

describe("document writes", () => {
  test("creates and appends documents as the application without changing strict mode", async () => {
    const cli = {
      run: vi.fn(async () => ({ ok: true })),
      runRetryable: vi.fn(),
      runText: vi.fn(async () => ""),
    };
    const tools = new BaseTools(cli as never, loadConfig(configEnv), {} as never);

    await tools.createDocument("竞品分析", "<p>分析内容</p>");
    await tools.appendDocument("docx_token", "<h2>补充</h2><p>新增内容</p>");

    expect(cli.run).toHaveBeenNthCalledWith(1, [
      "docs", "+create",
      "--title", "竞品分析",
      "--content", "<p>分析内容</p>",
      "--as", "bot", "--format", "json",
    ]);
    expect(cli.run).toHaveBeenNthCalledWith(2, [
      "docs", "+update",
      "--doc", "docx_token",
      "--command", "append",
      "--content", "<h2>补充</h2><p>新增内容</p>",
      "--as", "bot", "--format", "json",
    ]);
    expect(cli.runRetryable).not.toHaveBeenCalled();
    expect(cli.runText).not.toHaveBeenCalled();
  });
});

describe("message routing", () => {
  test("includes the directly replied message as quoted agent context", async () => {
    const event = {
      message_id: "om_reply",
      chat_id: "oc_dm",
      sender_id: "ou_user",
      chat_type: "p2p" as const,
      content: "为什么？",
      reply_to: "om_parent",
    };
    const state = { markMessageProcessed: vi.fn(() => true) };
    const agent = { run: vi.fn(async (_context: AgentRunContext) => "因为阅读量更高。") };
    const tools = {
      getMessageContext: vi.fn(async () => ({
        content: "参考资料：https://example.feishu.cn/base/should_not_be_authorized",
        senderName: "竞品分析",
      })),
      reply: vi.fn(async () => ({})),
      sendToChat: vi.fn(async () => ({})),
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await new MessageService("ou_bot", state as never, agent as never, tools as never).handle(event);
    write.mockRestore();

    expect(tools.getMessageContext).toHaveBeenCalledWith("om_parent");
    expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("should_not_be_authorized"),
    }));
    expect(agent.run.mock.calls[0]?.[0].prompt).toContain("当前消息：\n为什么？");
    expect(agent.run.mock.calls[0]?.[0].sources.list()).toEqual([
      expect.objectContaining({ kind: "text" }),
    ]);
    expect(agent.run.mock.calls[0]?.[0].budget).toBeDefined();
  });

  test("fetches referenced message content through the bot IM API", async () => {
    const cli = {
      runRetryable: vi.fn(async () => ({
        messages: [{
          message_id: "om_parent",
          sender: { name: "竞品分析" },
          content: "上一条分析",
        }],
      })),
    };
    const tools = new BaseTools(cli as never, loadConfig(configEnv), {} as never);

    await expect(tools.getMessageContext("om_parent")).resolves.toEqual({
      content: "上一条分析",
      senderName: "竞品分析",
    });
    expect(cli.runRetryable).toHaveBeenCalledWith([
      "im", "+messages-mget",
      "--message-ids", "om_parent",
      "--no-reactions",
      "--as", "bot", "--format", "json",
    ]);
  });

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

  test("quotes mentioned group messages in the main stream and mentions the sender", async () => {
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

    expect(tools.reply).toHaveBeenCalledWith(
      "om_group",
      '<at user_id="ou_sender"></at> 分析完成',
      false,
    );
    expect(tools.sendToChat).not.toHaveBeenCalled();
  });

  test("claims confirmations by chat even when replying to a card", async () => {
    const event = {
      message_id: "om_confirm",
      chat_id: "oc_group",
      sender_id: "ou_sender",
      chat_type: "group" as const,
      content: "@竞品分析 确认",
      root_id: "om_card_root",
      reply_to: "om_card",
      mentions: [{ id: "ou_bot", key: "@_user_1", name: "竞品分析" }],
    };
    const state = {
      markMessageProcessed: vi.fn(() => true),
      claimPendingAction: vi.fn(() => ({ ok: false, reason: "not_found" })),
    };
    const tools = { reply: vi.fn(async () => ({})), sendToChat: vi.fn(async () => ({})) };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await new MessageService("ou_bot", state as never, { run: vi.fn() } as never, tools as never).handle(event);
    write.mockRestore();

    expect(state.claimPendingAction).toHaveBeenCalledWith("ou_sender", "oc_group");
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
      observer.onToolStart("read_document");
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
    expect(session.setStatus).toHaveBeenNthCalledWith(1, "reading_document");
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

    expect(tools.reply).toHaveBeenCalledTimes(1);
    expect(tools.reply).toHaveBeenCalledWith(
      "om_start_failure",
      expect.stringContaining("分析完成"),
      false,
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

    expect(tools.reply).toHaveBeenCalledTimes(1);
    expect(tools.reply).toHaveBeenCalledWith(
      "om_finish_failure",
      expect.stringContaining("分析完成"),
      false,
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
    expect(tools.reply).toHaveBeenCalledWith(
      "om_text",
      expect.stringContaining("分析完成"),
      false,
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

  test("claims a pending action once for its owner and chat before expiry", () => {
    const store = new StateStore(":memory:");
    stores.push(store);
    store.createPendingAction({
      id: "pa_1",
      requesterId: "ou_owner",
      chatId: "oc_1",
      rootMessageId: "om_root",
      threadId: "omt_1",
      expiresAt: 2000,
      kind: "document.create",
      payload: { kind: "document.create", title: "来源分布", contentXml: "<p>x</p>", idempotencyKey: "idem_1" },
    });

    expect(store.claimPendingAction("ou_other", "oc_1", 1500)).toEqual({ ok: false, reason: "not_found" });

    const claimed = store.claimPendingAction("ou_owner", "oc_1", 1500);
    expect(claimed.ok).toBe(true);
    expect(store.claimPendingAction("ou_owner", "oc_1", 1500)).toEqual({ ok: false, reason: "not_found" });

    store.createPendingAction({
      id: "pa_2",
      requesterId: "ou_owner",
      chatId: "oc_1",
      rootMessageId: "om_root_2",
      threadId: "omt_1",
      expiresAt: 1000,
      kind: "document.create",
      payload: { kind: "document.create", title: "来源分布 2", contentXml: "<p>x</p>", idempotencyKey: "idem_2" },
    });
    expect(store.claimPendingAction("ou_owner", "oc_1", 1001)).toEqual({ ok: false, reason: "expired" });
  });

  test("records an unknown external write outcome", () => {
    const store = new StateStore(":memory:");
    stores.push(store);
    store.createPendingAction({
      id: "pa_unknown", requesterId: "ou_owner", chatId: "oc_1", rootMessageId: "om_1",
      threadId: "om_1", expiresAt: 2000, kind: "document.create",
      payload: { kind: "document.create", title: "来源分布", contentXml: "<p>x</p>", idempotencyKey: "idem_3" },
    });
    expect(store.claimPendingAction("ou_owner", "oc_1", 1500).ok).toBe(true);
    store.markActionUnknown("pa_unknown", "network timeout");
    expect(store.getPendingActionStatus("pa_unknown")).toBe("unknown");
  });
});

describe("dashboard filters", () => {
  test("builds a ring chart config from structured arguments", () => {
    expect(buildChartComponentConfig({
      name: "按书籍来源分布",
      component_type: "ring",
      metric: { kind: "count_all", field_name: null, rollup: null },
      group_by: [{ field_name: "书籍来源", mode: "enumerated", sort_type: "value", sort_order: "desc" }],
      filters: [],
      filter_conjunction: "and",
      snapshot_date: "2026-07-23",
    })).toEqual({
      name: "按书籍来源分布",
      type: "ring",
      snapshotDate: "2026-07-23",
      dataConfig: {
        count_all: true,
        group_by: [{ field_name: "书籍来源", mode: "enumerated", sort: { type: "value", order: "desc" } }],
      },
    });
  });

  test("rejects incompatible structured chart arguments", () => {
    expect(() => buildChartComponentConfig({
      name: "错误环形图",
      component_type: "ring",
      metric: { kind: "count_all", field_name: "阅读量估算", rollup: "SUM" },
      group_by: [],
      filters: [],
      filter_conjunction: "and",
      snapshot_date: "2026-07-23",
    })).toThrow();
  });

  test("uses the native ExactDate tuple for dashboard datetime filters", () => {
    const result = addDashboardDateFilter({ count_all: true }, "快照日期", "2026-07-22");
    const filter = result.filter as { conditions: Array<{ value: unknown }> };
    expect(filter.conditions[0]?.value).toEqual(["ExactDate", 1784649600000]);
  });

  test("accepts the service-owned ExactDate tuple during proposal validation", () => {
    const result = addDashboardDateFilter({
      count_all: true,
      group_by: [{ field_name: "作品来源", mode: "integrated" }],
    }, "快照日期", "2026-07-22");

    expect(() => validateDashboardConfig("ring", result, true)).not.toThrow();
  });

  test("replaces model-provided snapshot filters with the service-owned condition", () => {
    const result = addDashboardDateFilter({
      count_all: true,
      filter: {
        conjunction: "or",
        conditions: [
          { field_name: "作品来源", operator: "is", value: "原创" },
          { field_name: "快照日期", operator: "is", value: ["ExactDate", "1784649600000"] },
        ],
      },
    }, "快照日期", "2026-07-22");

    expect(result.filter).toEqual({
      conjunction: "and",
      conditions: [
        { field_name: "作品来源", operator: "is", value: "原创" },
        { field_name: "快照日期", operator: "is", value: ["ExactDate", 1784649600000] },
      ],
    });
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
