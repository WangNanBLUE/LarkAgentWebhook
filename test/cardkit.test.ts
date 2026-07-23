import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BaseTools } from "../src/lark/base-tools.js";
import {
  ANSWER_ELEMENT_ID,
  ANSWER_PREFIX,
  STATUS_ELEMENT_ID,
  StreamingCardKit,
} from "../src/lark/cardkit.js";

const config = loadConfig({
  OPENAI_BASE_URL: "https://example.test/v1",
  OPENAI_API_KEY: "test-key",
  OPENAI_MODEL: "test-model",
  LARK_EXPECTED_APP_ID: "cli_test",
});

afterEach(() => {
  vi.useRealTimers();
});

describe("interactive card delivery", () => {
  test("sends a CardKit entity directly to the group chat", async () => {
    const cli = { runRetryable: vi.fn(async (_args: string[]) => ({})) };
    const tools = new BaseTools(cli as never, config, {} as never);

    await tools.sendCardToChat("oc_1", "card_1");

    expect(cli.runRetryable).toHaveBeenCalledWith([
      "im", "+messages-send",
      "--chat-id", "oc_1",
      "--msg-type", "interactive",
      "--content", JSON.stringify({ type: "card", data: { card_id: "card_1" } }),
      "--idempotency-key", expect.any(String),
      "--as", "bot", "--format", "json",
    ]);
  });
});

describe("CardKit streaming", () => {
  test("creates a Card 2.0 entity and replies in the group main stream", async () => {
    const cli = { runRetryable: vi.fn(async (_args: string[]) => ({ data: { card_id: "card_1" } })) };
    const tools = { replyCard: vi.fn(async () => ({})), sendCardToChat: vi.fn(async () => ({})) };
    const cards = new StreamingCardKit(cli as never, tools as never);

    await cards.start({
      message_id: "om_group",
      chat_id: "oc_group",
      sender_id: "ou_sender",
      chat_type: "group",
      content: "分析",
    });

    const args = cli.runRetryable.mock.calls[0]?.[0] as string[];
    const createBody = JSON.parse(args[args.indexOf("--data") + 1] ?? "{}") as { type?: string; data?: string };
    const card = JSON.parse(createBody.data ?? "{}") as {
      schema?: string;
      config?: { streaming_mode?: boolean };
      body?: { elements?: Array<{ element_id?: string; content?: string }> };
    };
    expect(args.slice(0, 3)).toEqual(["api", "POST", "/open-apis/cardkit/v1/cards"]);
    expect(createBody.type).toBe("card_json");
    expect(card).toMatchObject({ schema: "2.0", config: { streaming_mode: true } });
    expect(card.body?.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ element_id: STATUS_ELEMENT_ID, content: "<at id=ou_sender></at> 正在分析" }),
      expect.objectContaining({ element_id: ANSWER_ELEMENT_ID, content: ANSWER_PREFIX }),
    ]));
    expect(tools.replyCard).toHaveBeenCalledWith("om_group", "card_1", false);
    expect(tools.sendCardToChat).not.toHaveBeenCalled();
  });

  test("coalesces deltas and serializes status, content, and close updates", async () => {
    vi.useFakeTimers();
    const cli = { runRetryable: vi.fn(async (_args: string[]) => ({ card_id: "card_1" })) };
    const tools = { replyCard: vi.fn(async () => ({})) };
    const session = await new StreamingCardKit(cli as never, tools as never).start({
      message_id: "om_1",
      chat_id: "oc_1",
      sender_id: "ou_1",
      chat_type: "p2p",
      content: "分析",
    });
    cli.runRetryable.mockClear();

    session.setStatus("querying");
    session.appendText("分析");
    session.appendText("完成");
    await vi.advanceTimersByTimeAsync(250);
    expect(await session.finish("分析完成")).toBe(true);

    const writes = cli.runRetryable.mock.calls.map((call) => {
      const args = call[0] as string[];
      return {
        method: args[1],
        path: args[2] ?? "",
        body: JSON.parse(args[args.indexOf("--data") + 1] ?? "{}") as Record<string, unknown>,
      };
    });
    const contentWrites = writes.filter((write) => write.path.endsWith("/content"));
    const settingsWrite = writes.find((write) => write.path.endsWith("/settings"));

    expect(contentWrites).toHaveLength(3);
    expect(contentWrites.map((write) => write.body.sequence)).toEqual([1, 2, 3]);
    expect(contentWrites[0]?.body.content).toBe("正在查询看板数据");
    expect(contentWrites[1]?.body.content).toBe(`${ANSWER_PREFIX}分析完成`);
    expect(contentWrites[2]?.body.content).toBe("分析完成");
    expect(settingsWrite?.method).toBe("PATCH");
    expect(settingsWrite?.body.sequence).toBe(4);
    expect(JSON.parse(String(settingsWrite?.body.settings))).toMatchObject({
      config: { streaming_mode: false, summary: { content: "分析完成" } },
    });
  });

  test("stops CardKit writes after the first terminal update failure", async () => {
    vi.useFakeTimers();
    const cli = { runRetryable: vi.fn(async (_args: string[]) => ({ card_id: "card_1" })) };
    const tools = { replyCard: vi.fn(async () => ({})) };
    const session = await new StreamingCardKit(cli as never, tools as never).start({
      message_id: "om_failure",
      chat_id: "oc_1",
      sender_id: "ou_1",
      chat_type: "p2p",
      content: "分析",
    });
    cli.runRetryable.mockClear();
    cli.runRetryable.mockRejectedValueOnce(new Error("permission denied"));

    session.setStatus("querying");
    session.appendText("分析");
    await vi.advanceTimersByTimeAsync(250);

    expect(await session.finish("分析完成")).toBe(false);
    expect(cli.runRetryable).toHaveBeenCalledTimes(1);
  });

  test("keeps streamed preamble text when the final response covers only the last round", async () => {
    vi.useFakeTimers();
    const cli = { runRetryable: vi.fn(async (_args: string[]) => ({ card_id: "card_1" })) };
    const tools = { replyCard: vi.fn(async () => ({})) };
    const session = await new StreamingCardKit(cli as never, tools as never).start({
      message_id: "om_preamble",
      chat_id: "oc_1",
      sender_id: "ou_1",
      chat_type: "p2p",
      content: "分析",
    });
    cli.runRetryable.mockClear();

    session.appendText("我先查询。");
    await vi.advanceTimersByTimeAsync(250);
    session.appendText("最终结论");
    expect(await session.finish("最终结论")).toBe(true);

    const answerWrites = cli.runRetryable.mock.calls
      .map((call) => call[0])
      .filter((args) => args[2]?.includes(`/elements/${ANSWER_ELEMENT_ID}/content`))
      .map((args) => JSON.parse(args[args.indexOf("--data") + 1] ?? "{}") as { content?: string });
    expect(answerWrites.at(-1)?.content).toBe(`${ANSWER_PREFIX}我先查询。最终结论`);
  });

  test("writes the complete answer again after closing streaming mode", async () => {
    const cli = { runRetryable: vi.fn(async (_args: string[]) => ({ card_id: "card_1" })) };
    const tools = { replyCard: vi.fn(async () => ({})) };
    const session = await new StreamingCardKit(cli as never, tools as never).start({
      message_id: "om_final",
      chat_id: "oc_1",
      sender_id: "ou_1",
      chat_type: "p2p",
      content: "比较两本书",
    });
    cli.runRetryable.mockClear();

    session.appendText("结论：建议选择 An Under");
    expect(await session.finish("结论：建议选择 An Understated Dominance。")).toBe(true);

    const writes = cli.runRetryable.mock.calls.map((call) => {
      const args = call[0] as string[];
      return {
        method: args[1],
        path: args[2] ?? "",
        body: JSON.parse(args[args.indexOf("--data") + 1] ?? "{}") as Record<string, unknown>,
      };
    });
    const closeIndex = writes.findIndex((write) => write.path.endsWith("/settings"));
    const finalWriteIndex = writes.findIndex((write) => (
      write.method === "PATCH" && write.path.endsWith(`/elements/${ANSWER_ELEMENT_ID}`)
    ));
    const finalWrite = writes[finalWriteIndex];

    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(finalWriteIndex).toBeGreaterThan(closeIndex);
    expect(JSON.parse(String(finalWrite?.body.partial_element))).toEqual({
      content: `${ANSWER_PREFIX}结论：建议选择 An Understated Dominance。`,
    });
  });
});
