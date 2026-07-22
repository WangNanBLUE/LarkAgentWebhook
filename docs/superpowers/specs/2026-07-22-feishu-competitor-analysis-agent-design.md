# Feishu Competitor Analysis Agent Design

## Goal

Build a local Node.js and TypeScript backend for the Feishu custom app `竞品分析`. The service listens for group messages that explicitly mention the bot, answers questions from the `竞品书籍快照` table, and can create or update components in a separately managed AI dashboard.

Success means a group member can mention the bot, receive an evidence-based reply, request a dashboard change, review the proposed change, confirm it, and see the change applied without exposing the existing dashboard's unsupported dashboard-v2 components to mutation.

## Confirmed Scope

- Trigger only on group messages that explicitly mention `竞品分析`.
- Subscribe to `im.message.receive_v1` with bot identity.
- Use `lark` skills as the behavior and safety specification, then execute operations through `lark-cli`.
- Use the OpenAI Responses API with function tools and configurable base URL, API key, and model.
- Let all group members query data and propose dashboard changes.
- Require the proposal author to confirm a write in the same message thread within 10 minutes.
- Default analysis to the latest value in the `快照日期` field. Honor an explicitly requested historical date.
- Create and manage a separate dashboard named `竞品书籍 AI 分析看板`.
- Support creating and updating statistics, column, line, pie, ring, and text components.
- Do not delete tables, records, dashboards, or components.
- Do not modify the 13 dashboard-v2 components in the existing `竞品书籍全维度分析看板`, because the public Dashboard API does not expose them reliably.

## Fixed Feishu Resources

- Base token: `MRWSbBwxMafAqRsAZsecYy9Mn5e`
- Source table: `竞品书籍快照`
- Source table ID: `tbl66n4X12oPZmz0`
- Existing dashboard: `竞品书籍全维度分析看板`
- Existing dashboard ID: `blkY8aklJbxp87Cr`
- Managed dashboard: `竞品书籍 AI 分析看板`

These values are supplied as environment defaults so a future deployment can override them without changing code.

## Architecture

The backend is one long-running Node.js process with five focused modules:

1. `EventConsumer` starts `lark-cli event consume im.message.receive_v1 --as bot`, waits for the stderr ready marker, and reads stdout as NDJSON.
2. `MessageRouter` accepts group messages that mention the bot, normalizes the prompt, and deduplicates by `message_id`.
3. `AgentRunner` calls the OpenAI Responses API and runs a bounded function-tool loop.
4. `LarkToolAdapter` validates tool arguments and maps approved operations to fixed `lark-cli` argument arrays.
5. `StateStore` uses SQLite for event deduplication, pending writes, managed dashboard and component IDs, and operational state.

The service also exposes a loopback-only HTTP health endpoint. It does not expose a public webhook because Feishu events arrive through the `lark-cli` long connection.

## Message Flow

### Read Request

1. Receive an `im.message.receive_v1` event.
2. Reject non-group messages and messages that do not mention the bot.
3. Insert `message_id` into the deduplication table. Ignore an existing ID.
4. Remove the bot mention and send the user request plus bounded conversation context to `AgentRunner`.
5. Let the model call read-only tools as needed.
6. Reply to the originating message with the final answer through `lark-cli im +messages-reply --as bot`.

### Write Request

1. The model calls a proposal tool rather than a write tool.
2. The backend validates and normalizes the complete dashboard component configuration.
3. Store an immutable pending action with its requester, chat, originating message, thread, expiry, and normalized arguments.
4. Reply with a human-readable preview and confirmation instruction.
5. Accept `确认` only from the original requester, in the same thread, within 10 minutes.
6. Execute the saved arguments directly through the relevant dashboard shortcut. Do not ask the model to regenerate them.
7. Save returned IDs and reply with the result.

## Agent Runtime

The service uses the OpenAI JavaScript SDK against the Responses API. Configuration:

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

The tool loop is limited to six model-tool rounds and 90 seconds. Every function tool uses strict JSON Schema. The complete response output is preserved between tool rounds so reasoning and tool-call items remain valid.

The model has no shell, arbitrary HTTP, filesystem, raw `lark-cli`, or destructive tools. Tool results are structured, size-limited, and stripped of secrets before they return to the model.

## Tool Catalog

Read-only tools:

- `get_source_schema`: read real table and field metadata.
- `resolve_snapshot_date`: find and validate the latest or requested snapshot date.
- `query_books`: retrieve a bounded, filtered set of book records.
- `aggregate_books`: run grouped statistics, sorting, and Top N queries in Feishu.
- `list_managed_components`: list components created by this service.
- `get_managed_component`: read one managed component and its computed data.

Proposal tools:

- `propose_component_create`: validate a new supported component and return a preview.
- `propose_component_update`: validate changes to a registered component and return a preview.

The deterministic confirmation executor is not exposed to the model.

## Skill And CLI Policy

The implementation follows this resolution order:

1. Use `lark-event` rules for the event consumer lifecycle.
2. Use `lark-im` rules for message parsing and replies.
3. Use `lark-base` rules and high-level shortcuts for data and dashboard operations.
4. If no supported shortcut exists, use `lark-openapi-explorer` to verify the official endpoint before a raw `lark-cli api` call is added to the allowlist.

All CLI calls use `child_process.spawn` or `execFile` with argument arrays. Shell execution and user-provided command fragments are forbidden. Success requires exit code zero and `ok: true` where the command uses a JSON envelope.

The event process must keep stdin open, wait for `[event] ready event_key=im.message.receive_v1`, and receive `SIGTERM` during shutdown. It must never be stopped with `SIGKILL` during normal operation.

## Data Access

The latest snapshot date is resolved before a default analysis. Aggregations run in Feishu through `lark-cli base +data-query` whenever the DSL supports the requested calculation. Record search is used only when the answer requires individual books.

The model receives aggregates and a bounded number of relevant records, not an unconditional dump of all 504 current records. Every answer states the effective snapshot date when it materially affects the interpretation.

## Dashboard Management

At startup, the service looks up `竞品书籍 AI 分析看板` by exact name. It creates the dashboard only if no exact match exists and stores the returned ID. Component creation is serialized. A component can be updated only when its `block_id` is registered in SQLite as service-managed.

Dashboard component types are limited to `statistics`, `column`, `line`, `pie`, `ring`, and `text`. An update can change the name or data configuration but cannot change the component type. A type change is returned as a suggestion to create a new component.

## Persistence

SQLite tables cover:

- processed message IDs and timestamps;
- pending actions and their confirmation state;
- the managed dashboard ID;
- managed component IDs, types, names, and last applied configuration;
- lightweight health and migration metadata.

Writes use transactions. Pending-action confirmation performs an atomic compare-and-update so duplicate confirmations cannot execute a write twice.

## Configuration And Credentials

Feishu credentials stay in a dedicated named `lark-cli` profile for the `竞品分析` app. The profile uses bot-only strict mode. App Secret, access tokens, and user tokens are never stored in the repository or application database.

The current machine is configured for a different app and has strict user mode, so deployment is blocked until the new app profile is configured and selected for this workspace.

The Feishu application must have bot capability, the `im.message.receive_v1` event subscription, permission to receive group @ messages, `im:message:send_as_bot`, and the Base permissions required by the read and dashboard commands. Startup preflight reports any exact missing scopes returned by `lark-cli`.

## Failure Handling

- Restart a failed event consumer with capped exponential backoff.
- Retry bounded network and rate-limit failures with jitter.
- Do not retry authentication, permission, validation, or unsupported-operation failures.
- Serialize Base component writes to avoid concurrent mutation conflicts.
- Treat ambiguous component creation failures as unknown state: reconcile the managed dashboard before retrying to avoid duplicates.
- Return a concise user-facing error in the originating thread and log structured diagnostics locally.
- Redact credentials, tokens, and full raw messages from logs.

## Health And Operations

`GET /healthz` binds to loopback and reports:

- process status;
- event consumer ready state;
- SQLite readiness;
- last successful Feishu preflight;
- last successful model request;
- degraded reasons without secrets.

PM2 or macOS `launchd` keeps the service running. Graceful shutdown stops accepting events, waits for the active request within a short deadline, sends `SIGTERM` to the consumer, and closes SQLite.

## Verification

Unit tests are intentionally limited to the highest-risk logic:

- group mention filtering and `message_id` deduplication;
- strict tool-argument validation;
- confirmation ownership, thread binding, expiry, and one-time execution;
- mapping structured `lark-cli` failures into retryable and terminal classes.

Integration tests use a fake `lark-cli` executable and a fake Responses client to cover one read flow and one preview-confirm-write flow. CLI `--dry-run` checks verify generated command paths without changing Feishu. After the new app profile and permissions are configured, a live smoke test verifies one group @ query and one confirmed component creation in the AI dashboard.

## Out Of Scope

- Polling or reacting to Feishu Pin messages.
- Receiving every group message without an @ mention.
- Modifying the existing dashboard-v2 components.
- Deleting Base resources or records.
- User impersonation or user access tokens.
- A public web UI or public webhook endpoint.
- A separately deployed remote Agent service.
