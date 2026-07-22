# Streaming Card Responses Design

## Goal

Add a configurable response presentation mode to the Feishu competitor-analysis agent. The default mode uses OpenAI Responses SSE and one CardKit Card 2.0 entity that updates in place; the compatibility mode preserves the current single text reply.

## Configuration

Add `LARK_RESPONSE_MODE` with two accepted values:

- `streaming_card` (default): send and update a Card 2.0 response.
- `text`: preserve the existing single text reply behavior.

The checked-in `.env.example` documents the switch. The local `.env` is set to `streaming_card` during deployment. Streaming-card mode requires the bot scope `cardkit:card:write` in addition to the existing message scopes.

## OpenAI Streaming Loop

`AgentRunner` uses `client.responses.stream()` for every model round in both presentation modes. It consumes typed SSE events and then obtains the SDK's accumulated final response for the existing function-call loop.

- `response.output_text.delta` contributes to the current answer and is published to an optional observer.
- `response.output_item.added` with a `function_call` item publishes the querying status as soon as the model selects a tool.
- The accumulated response output and matching `function_call_output` items remain the source of truth for subsequent rounds.
- Timeouts continue to use the request deadline and abort signal.
- Text mode supplies no observer and returns the accumulated final text exactly once.

The displayed answer buffer spans model rounds and is never retracted. Tool-only rounds normally emit no text; if the provider emits a short preamble before a function call, that text remains before the final analysis so every CardKit update continues to extend the previous content.

The observer is a small interface owned by the agent layer. It exposes answer deltas, tool activity, and completion without importing any Feishu or CardKit types.

Reference: [OpenAI Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses.md).

## CardKit Adapter

A dedicated CardKit adapter owns raw `lark-cli api` calls and does not expose arbitrary HTTP paths to the agent or model.

1. Create one Card 2.0 entity with `POST /open-apis/cardkit/v1/cards`.
2. Reply with that entity through the typed `im +messages-reply` command using `msg_type=interactive` and the returned `card_id`.
3. Update only the status and answer elements through `PUT /open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content`.
4. Close streaming mode through `PATCH /open-apis/cardkit/v1/cards/:card_id/settings`.

Every write includes a unique UUID. One session-level queue serializes all writes and allocates a strictly increasing `sequence`, including status changes, answer updates, and the final settings change. Existing `LarkCli.runRetryable()` retries the same UUID and sequence for idempotency.

References:

- [Create a card entity](https://open.feishu.cn/document/cardkit-v1/card/create)
- [Stream text updates](https://open.feishu.cn/document/cardkit-v1/card-element/content)
- [Update card settings](https://open.feishu.cn/document/cardkit-v1/card/settings)
- [Streaming card overview](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/streaming-updates-openapi-overview)

## Card Presentation

The card uses JSON schema 2.0, shared updates, default width, streaming mode, and the fast print strategy. It contains a restrained header plus two uniquely identified Markdown elements:

- Status element: initially `正在分析`.
- Answer element: starts with an invisible stable prefix so every later full-content update extends the previous content and retains CardKit's typewriter behavior.

Status transitions are:

1. `正在分析`
2. `正在查询看板数据` when a function call is observed
3. `正在整理分析结果` after tool results return
4. `分析完成` after the final answer is flushed

The final sequence is: flush the complete answer, set the completed status, then set `streaming_mode=false` and update the card summary. No evaluation buttons or other interactions are added.

## Delta Coalescing

Model deltas are appended in memory immediately. The card session schedules at most one answer flush every 250 ms, which is inside the requested 200-500 ms range and below the documented per-card limit of ten operations per second.

If a write is already running, later deltas remain buffered. The queue always sends full answer content, never isolated deltas. `finish()` cancels the timer, flushes any remaining text, waits for queued writes, and only then closes streaming mode.

## Message Placement

- Direct messages reply in the main chat stream.
- Group messages use `reply_in_thread=true`, so the streaming card appears in the original message's topic.
- Text compatibility mode preserves its current placement and sender-mention behavior.

## Failure Handling

The response must never fragment into multiple fallback messages.

- If card creation or sending fails, run the model without a card observer and send one final text reply.
- If a card update fails after retry, disable further card writes but continue accumulating the model answer. At completion, send one final text reply.
- If closing streaming mode fails, send one final text reply because the card would otherwise remain in a generating state.
- If the model fails and the card is writable, update the same card to a failure state and close streaming mode.
- If both the model and card path fail, send one text error reply.

The fallback text path reuses the existing reply method, length limit, group sender mention, idempotency key, and structured message log. In streaming-card mode it uses the same placement as the card: direct messages stay in the main stream and group messages use the original topic. Text compatibility mode keeps its current placement.

## Components And Boundaries

- `src/config.ts`: parse and expose the response mode.
- `src/agent/runner.ts`: stream Responses events and publish presentation-neutral progress; accept a narrow Responses client dependency so fake streams can drive unit tests.
- `src/lark/cardkit.ts`: build Card 2.0 JSON, serialize CardKit updates, and enforce sequence/idempotency.
- `src/lark/base-tools.ts`: retain the existing text reply and expose the typed interactive-card reply command.
- `src/service/message-service.ts`: choose the presenter, coordinate fallback, and preserve confirmation handling.
- `src/index.ts`: construct and inject the CardKit dependency.

CardKit cannot execute model tools and the model cannot choose raw API paths. The existing allowlisted dashboard tools remain unchanged.

## Testing

Tests use fake OpenAI streams and fake CLI adapters; they do not call OpenAI or Feishu.

- Configuration defaults to `streaming_card` and accepts `text`.
- Streaming output deltas are accumulated and published while function calls still execute across rounds.
- The card is created before the model starts.
- Direct-message cards remain in the main stream; group cards use the thread flag.
- Deltas coalesce into full-content writes no faster than the configured interval.
- Status and answer writes share one monotonically increasing sequence.
- Completion flushes the full answer before closing streaming mode.
- Card failures produce exactly one text fallback.
- Text mode retains the existing single-reply behavior.

Live verification uses the configured `gpt-5.5` endpoint and the bot profile after `cardkit:card:write` is available. It checks one direct message and one mentioned group message, observes tool status, confirms in-place updates, and verifies the final card is no longer marked as generating.
