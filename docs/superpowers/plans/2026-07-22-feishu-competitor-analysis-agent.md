# Feishu Competitor Analysis Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local TypeScript service that receives Feishu group @ messages through `lark-cli`, answers from the competitor Base, and applies confirmed changes to a managed AI dashboard.

**Architecture:** One Node.js process owns a `lark-cli` event child, an OpenAI Responses function-tool loop, a fixed CLI adapter, and SQLite state. Read tools execute immediately; component writes are immutable proposals executed only after bound confirmation.

**Tech Stack:** Node.js 22+, TypeScript, OpenAI JavaScript SDK, Zod, built-in `node:sqlite`, Vitest, PM2.

---

### Task 1: Project Skeleton And Configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- Create: `src/config.ts`, `src/types.ts`

- [ ] Define npm scripts for `dev`, `build`, `start`, `test`, and `check`.
- [ ] Add runtime dependencies `openai` and `zod`; add TypeScript, tsx, Vitest, and Node types for development.
- [ ] Parse configuration with Zod and require `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`.
- [ ] Provide defaults for the confirmed Base, table, snapshot field, dashboard name, SQLite path, and loopback health address.
- [ ] Run `npm run check`; expect TypeScript compilation to pass.
- [ ] Commit the project skeleton.

Core configuration shape:

```ts
export interface AppConfig {
  openai: { baseURL: string; apiKey: string; model: string };
  lark: { binary: string; baseToken: string; tableId: string; tableName: string; snapshotField: string; dashboardName: string };
  agent: { maxToolRounds: number; timeoutMs: number };
  statePath: string;
  health: { host: string; port: number };
}
```

### Task 2: CLI Adapter And SQLite State

**Files:**
- Create: `src/lark/cli.ts`, `src/lark/errors.ts`, `src/state/store.ts`
- Test: `test/core.test.ts`

- [ ] Write focused failing tests for structured CLI error classification and one-time confirmation ownership/thread/expiry.
- [ ] Implement `LarkCli.run(args)` with `execFile`, JSON-envelope validation, timeout, redaction, and no shell.
- [ ] Implement SQLite migrations for processed messages, pending actions, settings, and managed components.
- [ ] Implement atomic `claimPendingAction` so a proposal can execute only once.
- [ ] Run `npm test`; expect the focused tests to pass.
- [ ] Commit CLI and persistence support.

Required boundary:

```ts
export interface PendingAction {
  id: string;
  requesterId: string;
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  expiresAt: number;
  kind: "component.create" | "component.update";
  payload: unknown;
}
```

### Task 3: Base And Dashboard Tools

**Files:**
- Create: `src/lark/base-tools.ts`, `src/agent/tool-schemas.ts`

- [ ] Implement fixed read operations for field metadata, data-query DSL, bounded record search, dashboard listing, and managed block reads.
- [ ] Force every data query to the configured Base/table and cap returned rows.
- [ ] Implement latest snapshot resolution with a datetime `max` aggregation.
- [ ] Validate supported component types and `data_config` with Zod.
- [ ] Implement idempotent managed-dashboard lookup/create and serialized component create/update.
- [ ] Register only the confirmed read and proposal schemas with the model.
- [ ] Run `npm run check`; expect no type errors.
- [ ] Commit Base tools.

### Task 4: Responses Agent Loop

**Files:**
- Create: `src/agent/runner.ts`, `src/agent/instructions.ts`

- [ ] Create the OpenAI client with configurable `baseURL` and `apiKey`.
- [ ] Send strict function tools through the Responses API.
- [ ] Preserve response output items and append matching `function_call_output` items.
- [ ] Stop after six rounds or 90 seconds and return a concise failure.
- [ ] Execute read tools immediately and store write proposals without exposing an executor tool.
- [ ] Run `npm run check`; expect no type errors.
- [ ] Commit the agent loop.

Loop invariant:

```ts
for (let round = 0; round < maxToolRounds; round += 1) {
  const response = await client.responses.create(request);
  const calls = response.output.filter(item => item.type === "function_call");
  if (calls.length === 0) return response.output_text;
  input.push(...response.output, ...await executeCalls(calls));
}
throw new Error("Agent tool limit exceeded");
```

### Task 5: Event Routing, Replies, And Confirmation

**Files:**
- Create: `src/lark/event-consumer.ts`, `src/service/message-service.ts`
- Extend: `test/core.test.ts`

- [ ] Write focused failing tests for group @ filtering and `message_id` deduplication.
- [ ] Spawn `lark-cli event consume im.message.receive_v1 --as bot`, wait for its ready marker, and parse NDJSON.
- [ ] Keep stdin open and stop the child with `SIGTERM`.
- [ ] Route normal @ requests to the Agent and replies through `im +messages-reply`.
- [ ] Detect bound `确认`, atomically claim the saved proposal, execute the exact payload, and reply with the result.
- [ ] Run `npm test`; expect all focused tests to pass.
- [ ] Commit the message flow.

### Task 6: Entrypoint, Health, And Deployment

**Files:**
- Create: `src/index.ts`, `src/health.ts`, `ecosystem.config.cjs`, `README.md`

- [ ] Add startup preflight for CLI config, strict bot mode, field access, and managed dashboard setup.
- [ ] Expose loopback-only `GET /healthz` with event, SQLite, Feishu, and model status.
- [ ] Add graceful shutdown and capped event-consumer restart backoff.
- [ ] Document the named `lark-cli` profile setup, app scopes, environment configuration, PM2 commands, and live smoke test.
- [ ] Run `npm test`, `npm run check`, and `npm run build`; expect all to pass.
- [ ] Run CLI dry-runs for reply and dashboard creation command generation.
- [ ] Start the service only after the new app profile and model credentials exist; verify `/healthz` and one live @ flow.
- [ ] Commit the runnable service and deployment documentation.
