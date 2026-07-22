# Streaming Card Responses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `streaming_card` the default response mode while retaining an explicit `text` compatibility mode and a one-message text fallback.

**Architecture:** `AgentRunner` consumes typed Responses SSE events and emits presentation-neutral progress callbacks. `StreamingCardKit` owns one Card 2.0 entity per answer, serializes all CardKit writes, and coalesces full-text updates every 250 ms; `MessageService` selects the mode and coordinates fallback.

**Tech Stack:** Node.js 26, TypeScript, OpenAI SDK 5.20, Vitest, `lark-cli` 1.0.74, Feishu CardKit v1

---

## File Structure

- Modify `.env.example`: document the response-mode switch.
- Modify `src/config.ts`: validate `LARK_RESPONSE_MODE` and default it to `streaming_card`.
- Modify `src/agent/runner.ts`: stream every Responses round and publish deltas/tool status.
- Create `src/lark/cardkit.ts`: build, send, update, finish, and fail one streaming card session.
- Modify `src/lark/base-tools.ts`: add an idempotent interactive-card reply method.
- Modify `src/service/message-service.ts`: select text/card mode and guarantee one fallback.
- Modify `src/index.ts`: construct and inject `StreamingCardKit`.
- Modify `test/core.test.ts`: cover config, streamed tool loops, message placement, and fallback.
- Create `test/cardkit.test.ts`: cover Card 2.0 request shapes, coalescing, sequence order, and closure.
- Modify `README.md`: document the switch and required CardKit scope.

### Task 1: Configuration Switch

**Files:**
- Modify: `.env.example`
- Modify: `src/config.ts`
- Modify: `test/core.test.ts`

- [ ] **Step 1: Add a failing configuration test**

Import `loadConfig` and add assertions that a complete test environment defaults to `streaming_card`, accepts `text`, and rejects any other value:

```ts
const configEnv = {
  OPENAI_BASE_URL: "https://example.test/v1",
  OPENAI_API_KEY: "test-key",
  OPENAI_MODEL: "test-model",
  LARK_EXPECTED_APP_ID: "cli_test",
};

expect(loadConfig(configEnv).lark.responseMode).toBe("streaming_card");
expect(loadConfig({ ...configEnv, LARK_RESPONSE_MODE: "text" }).lark.responseMode).toBe("text");
expect(() => loadConfig({ ...configEnv, LARK_RESPONSE_MODE: "invalid" })).toThrow();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/core.test.ts`

Expected: FAIL because `responseMode` is undefined.

- [ ] **Step 3: Add the enum to the environment schema**

```ts
LARK_RESPONSE_MODE: z.enum(["text", "streaming_card"]).default("streaming_card"),
```

Expose it as `config.lark.responseMode`, and add `LARK_RESPONSE_MODE=streaming_card` to `.env.example`.

- [ ] **Step 4: Re-run the focused test and verify GREEN**

Run: `npm test -- test/core.test.ts`

Expected: all core tests pass.

### Task 2: Responses SSE Agent Observer

**Files:**
- Modify: `src/agent/runner.ts`
- Modify: `test/core.test.ts`

- [ ] **Step 1: Add a failing streamed tool-loop test**

Define a fake async stream with `finalResponse()` and two rounds: the first emits a `function_call` item and returns a function call; the second emits two `response.output_text.delta` events and returns the final message. Assert that:

```ts
expect(observer.onToolStart).toHaveBeenCalledWith("aggregate_books");
expect(observer.onToolEnd).toHaveBeenCalledTimes(1);
expect(observer.onTextDelta).toHaveBeenNthCalledWith(1, "分析", "分析");
expect(observer.onTextDelta).toHaveBeenNthCalledWith(2, "完成", "分析完成");
expect(answer).toBe("分析完成");
expect(responses.stream).toHaveBeenCalledTimes(2);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/core.test.ts`

Expected: FAIL because `AgentRunner` does not accept an observer or Responses client and still calls `responses.create()`.

- [ ] **Step 3: Add the presentation-neutral contracts**

```ts
export interface AgentRunObserver {
  onTextDelta(delta: string, fullText: string): void;
  onToolStart(name: string): void;
  onToolEnd(): void;
}

type ResponsesClient = Pick<OpenAI["responses"], "stream">;
```

Allow the constructor to accept an optional `ResponsesClient`; construct the real OpenAI client only when it is omitted.

- [ ] **Step 4: Implement one streaming response helper**

The helper must:

```ts
const stream = this.responses.stream(params, { signal: AbortSignal.timeout(remaining) });
let roundText = "";
for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    roundText += event.delta;
    displayedText += event.delta;
    observer?.onTextDelta(event.delta, displayedText);
  }
  if (event.type === "response.output_item.added" && event.item.type === "function_call") {
    observer?.onToolStart(event.item.name);
  }
}
const response = await stream.finalResponse();
return { response, roundText };
```

Use it for normal rounds and the tool-budget final round. Keep the existing accumulated `response.output` plus `function_call_output` logic. Invoke `onToolEnd()` after all calls in a round finish. Return `response.output_text || roundText ||` the existing Chinese fallback.

- [ ] **Step 5: Re-run the focused test and verify GREEN**

Run: `npm test -- test/core.test.ts`

Expected: all core tests pass and no test performs network I/O.

### Task 3: CardKit Entity And Serialized Updates

**Files:**
- Create: `src/lark/cardkit.ts`
- Create: `test/cardkit.test.ts`

- [ ] **Step 1: Add failing CardKit tests with fake timers**

Use `vi.useFakeTimers()` and fake `LarkCli.runRetryable()` / `BaseTools.replyCard()` methods. Cover these observable requirements:

```ts
expect(createBody.type).toBe("card_json");
expect(JSON.parse(createBody.data)).toMatchObject({ schema: "2.0", config: { streaming_mode: true } });
expect(replyCard).toHaveBeenCalledWith("om_group", "card_1", true);

session.appendText("分析");
session.appendText("完成");
await vi.advanceTimersByTimeAsync(250);
await session.finish("分析完成");

expect(contentWrites.map((body) => body.sequence)).toEqual([1, 2, 3]);
expect(contentWrites.at(-2)?.content).toContain("分析完成");
expect(settingsWrite.sequence).toBe(4);
expect(JSON.parse(settingsWrite.settings).config.streaming_mode).toBe(false);
```

Also assert that two deltas inside one 250 ms window create one answer-content write.

- [ ] **Step 2: Run the CardKit test and verify RED**

Run: `npm test -- test/cardkit.test.ts`

Expected: FAIL because `src/lark/cardkit.ts` does not exist.

- [ ] **Step 3: Implement the fixed Card 2.0 builder**

Export constants `STATUS_ELEMENT_ID="status_text"`, `ANSWER_ELEMENT_ID="answer_text"`, and an invisible `ANSWER_PREFIX="\u200b"`. Build a schema 2.0 card with:

```ts
config: {
  update_multi: true,
  width_mode: "default",
  streaming_mode: true,
  summary: { content: "[生成中...]" },
  streaming_config: {
    print_frequency_ms: { default: 70 },
    print_step: { default: 1 },
    print_strategy: "fast",
  },
}
```

The body contains one status Markdown element initialized to `正在分析` and one answer Markdown element initialized to `ANSWER_PREFIX`.

- [ ] **Step 4: Implement `StreamingCardKit.start()`**

Create the entity through:

```ts
["api", "POST", "/open-apis/cardkit/v1/cards", "--data", JSON.stringify({
  type: "card_json",
  data: JSON.stringify(buildStreamingCard()),
}), "--as", "bot", "--format", "json"]
```

Recursively extract `card_id`, call `BaseTools.replyCard(message_id, card_id, chat_type === "group")`, and return a `StreamingCardSession`.

- [ ] **Step 5: Implement the session queue and coalescer**

The session owns `sequence`, `queue`, `timer`, `answer`, `lastSentAnswer`, and `failure`. `appendText()` schedules one flush after 250 ms. Every update uses a new UUID, the next sequence, the full element content, and a fixed allowlisted CardKit path.

`finish(finalText)` must cancel the timer, ensure the full final text is queued, queue `分析完成`, queue `streaming_mode=false` with a summary derived from the first 80 visible characters, await the queue, and return `true` only if all writes succeeded.

`fail(message)` must replace the answer/status with a concise failure state, close streaming mode, and return whether those writes succeeded.

- [ ] **Step 6: Re-run CardKit tests and verify GREEN**

Run: `npm test -- test/cardkit.test.ts`

Expected: all CardKit tests pass.

### Task 4: Interactive Reply Command

**Files:**
- Modify: `src/lark/base-tools.ts`
- Modify: `test/cardkit.test.ts`

- [ ] **Step 1: Add a failing reply placement assertion**

Assert that `replyCard("om_1", "card_1", true)` invokes the CLI with:

```ts
[
  "im", "+messages-reply",
  "--message-id", "om_1",
  "--msg-type", "interactive",
  "--content", JSON.stringify({ type: "card", data: { card_id: "card_1" } }),
  "--reply-in-thread",
  "--idempotency-key", expect.any(String),
  "--as", "bot", "--format", "json",
]
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/cardkit.test.ts`

Expected: FAIL because `BaseTools.replyCard()` is missing.

- [ ] **Step 3: Implement `replyCard()`**

Build the exact CardKit entity content above. Derive the idempotency key from thread/main, message ID, and card ID using the same SHA-256 convention as text replies. Use `runRetryable()`.

- [ ] **Step 4: Re-run the focused test and verify GREEN**

Run: `npm test -- test/cardkit.test.ts`

Expected: all CardKit tests pass.

### Task 5: Message Service Mode And Single Fallback

**Files:**
- Modify: `src/service/message-service.ts`
- Modify: `test/core.test.ts`

- [ ] **Step 1: Add failing orchestration tests**

Add tests for:

1. Streaming mode calls `cards.start(event)` before `agent.run()`.
2. Agent observer deltas/statuses are forwarded to the session.
3. A group card uses the session path and does not send a text reply on success.
4. Card start failure sends exactly one text fallback in the group thread.
5. `finish()` returning false sends exactly one text fallback.
6. Text mode sends exactly one existing main-stream text reply and never starts a card.

Use an `order: string[]` ledger and assertions such as:

```ts
expect(order.slice(0, 2)).toEqual(["card.start", "agent.run"]);
expect(tools.reply).toHaveBeenCalledTimes(1);
expect(tools.reply).toHaveBeenCalledWith("om_group", expect.stringContaining("分析完成"), true);
```

- [ ] **Step 2: Run core tests and verify RED**

Run: `npm test -- test/core.test.ts`

Expected: FAIL because `MessageService` has no response mode or CardKit dependency.

- [ ] **Step 3: Implement streaming orchestration**

Extend the constructor with `responseMode` and an optional CardKit dependency. Keep confirmation handling on the existing text path. For model questions:

```ts
if (this.responseMode === "streaming_card" && this.cards) {
  await this.handleStreaming(event, prompt, conversationKey);
  return;
}
```

Create the card before calling the agent. Forward observer callbacks to `appendText()`, `setStatus("querying")`, and `setStatus("summarizing")`. On success, call `finish(answer)`. If card start or finish fails, call the text reply exactly once with `replyInThread = event.chat_type === "group"`.

On a model exception, prefer `session.fail(message)`; send one text error only when that returns false. Add structured error logs without including secrets.

- [ ] **Step 4: Preserve explicit reply placement**

Change the private reply helper to accept `replyInThread = false`. Compatibility mode and confirmation messages pass `false`; streaming-card fallback passes `event.chat_type === "group"`.

- [ ] **Step 5: Re-run core tests and verify GREEN**

Run: `npm test -- test/core.test.ts`

Expected: all core tests pass.

### Task 6: Wiring, Documentation, And Deployment Default

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: local ignored `.env`

- [ ] **Step 1: Wire the production dependency**

Construct `StreamingCardKit` from the existing `LarkCli` and `BaseTools`, then pass it and `config.lark.responseMode` to `MessageService`.

- [ ] **Step 2: Document mode and permissions**

Add README content that states:

```dotenv
LARK_RESPONSE_MODE=streaming_card
```

Document `text` as the compatibility mode and add `cardkit:card:write` to the required bot scopes.

- [ ] **Step 3: Set the local deployment mode**

Add `LARK_RESPONSE_MODE=streaming_card` to the ignored `.env` without changing any existing secret.

- [ ] **Step 4: Run repository verification**

Run: `npm test`

Expected: all tests pass.

Run: `npm run check`

Expected: exit code 0 with no TypeScript errors.

Run: `npm run build`

Expected: exit code 0.

### Task 7: Restart And Runtime Verification

**Files:**
- Runtime log: `data/agent.log`

- [ ] **Step 1: Restart the PM2 process with updated environment**

Run:

```bash
set -a
source .env
set +a
pm2 restart feishu-competitor-analysis --update-env
```

Expected: PM2 reports the process online with a new start time and zero unstable restarts.

- [ ] **Step 2: Verify health and startup logs**

Run: `curl --silent --show-error --fail http://127.0.0.1:8787/healthz`

Expected: JSON includes `"status":"ok"`, `"eventReady":true`, and `"feishuReady":true`.

Run: `tail -n 30 data/agent.log`

Expected: a fresh `竞品分析服务已就绪` line and no startup exception.

- [ ] **Step 3: Verify CardKit request shapes without writing**

Use `lark-cli api ... --dry-run` for the create, element-content, and settings request shapes generated by unit fixtures. Expected: all three dry runs report the intended method, allowlisted path, bot identity, and JSON body without performing a write.

- [ ] **Step 4: Verify the permission boundary**

If a real streaming card attempt returns `missing_scopes`, report the exact `cardkit:card:write` scope and original `console_url`; do not run user authorization for this bot identity. Until the scope is granted, verify that the service sends one text fallback and remains healthy.

- [ ] **Step 5: Commit the implementation**

```bash
git add .env.example README.md src test
git commit -m "feat: stream agent responses into CardKit"
```
