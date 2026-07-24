# Group Fixed Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Completed on `main`; verified with 83 tests, TypeScript check, build, and `git diff --check`.

**Goal:** Let any group member persist up to five supported Feishu sources for automatic inclusion in later mentioned group analyses.

**Architecture:** Extract shared Feishu URL normalization from `SourceRegistry`, persist normalized group sources transactionally in the existing SQLite state store, and place a deterministic command service before Agent execution. `MessageService` injects stored URLs only for normal group analysis while preserving the current opaque per-run `source_id` boundary.

**Tech Stack:** TypeScript, Node.js 22 `node:sqlite`, Vitest, existing `lark-cli` integration.

---

### Task 1: Normalized URLs and Transactional Group Source Storage

**Files:**
- Modify: `src/sources/registry.ts`
- Modify: `src/state/store.ts`
- Modify: `src/types.ts`
- Test: `test/source-registry.test.ts`
- Test: `test/core.test.ts`

- [ ] **Step 1: Write failing URL merge tests**

Add tests proving that `parseFeishuSourceUrl()` removes fragments, sorts query parameters, classifies all supported resource types, and that `SourceRegistry.fromPrompt()` merges `additionalUrls`, deduplicates normalized URLs, and rejects more than five merged links.

```ts
const parsed = parseFeishuSourceUrl("https://TENANT.feishu.cn/docx/doc1?b=2&a=1#part");
expect(parsed).toMatchObject({
  kind: "document",
  normalizedUrl: "https://tenant.feishu.cn/docx/doc1?a=1&b=2",
});

const merged = SourceRegistry.fromPrompt(
  "分析 https://tenant.feishu.cn/docx/doc1?a=1&b=2",
  { additionalUrls: ["https://tenant.feishu.cn/docx/doc1?b=2&a=1#x"] },
);
expect(merged.list().filter((item) => item.kind !== "text")).toHaveLength(1);
```

- [ ] **Step 2: Run the focused registry tests and verify RED**

Run:

```bash
npx vitest run test/source-registry.test.ts
```

Expected: FAIL because `parseFeishuSourceUrl` and `additionalUrls` do not exist.

- [ ] **Step 3: Implement shared URL parsing and merged registration**

Export:

```ts
export interface ParsedFeishuSourceUrl {
  normalizedUrl: string;
  kind: Exclude<SourceKind, "text">;
  title: string;
}

export function parseFeishuSourceUrl(raw: string): ParsedFeishuSourceUrl
```

The function must strip supported trailing punctuation, require HTTPS and a Feishu hostname, classify the existing paths, remove fragments, sort query parameters by key then value, and return the normalized URL. Extend `SourceRegistry.fromPrompt()` options with `additionalUrls?: string[]`, merge before assigning IDs, deduplicate by normalized URL, and enforce the five-link limit after deduplication.

- [ ] **Step 4: Run registry tests and verify GREEN**

Run:

```bash
npx vitest run test/source-registry.test.ts
```

Expected: all registry tests pass.

- [ ] **Step 5: Write failing storage tests**

Add public-behavior tests using `StateStore(":memory:")`:

```ts
expect(store.bindGroupSources("oc_1", [
  { url: "https://tenant.feishu.cn/docx/a", kind: "document" },
], "ou_1", 1000)).toEqual({
  added: ["https://tenant.feishu.cn/docx/a"],
  existing: [],
});
expect(store.listGroupSources("oc_1")).toMatchObject([
  { chatId: "oc_1", addedBy: "ou_1", createdAt: 1000 },
]);
```

Also prove duplicate binding is idempotent, a batch exceeding five rolls back entirely, removing exact URLs leaves others intact, clearing affects only the selected group, and reopening a temporary SQLite file preserves records.

- [ ] **Step 6: Run the focused state tests and verify RED**

Run:

```bash
npx vitest run test/core.test.ts -t "group sources"
```

Expected: FAIL because the group-source state methods do not exist.

- [ ] **Step 7: Implement transactional storage**

Add `GroupSourceRecord` to `src/types.ts`, create `group_sources` in `StateStore` construction, and add:

```ts
bindGroupSources(
  chatId: string,
  sources: Array<{ url: string; kind: GroupSourceRecord["kind"] }>,
  addedBy: string,
  now?: number,
): { added: string[]; existing: string[] }
listGroupSources(chatId: string): GroupSourceRecord[]
removeGroupSources(chatId: string, urls: string[]): string[]
clearGroupSources(chatId: string): number
```

Use `BEGIN IMMEDIATE` around existing-record lookup, capacity validation, and inserts. Throw `Group source limit exceeded: 5` before any insert when the final unique count exceeds five.

- [ ] **Step 8: Run focused state and registry tests**

Run:

```bash
npx vitest run test/core.test.ts -t "group sources"
npx vitest run test/source-registry.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 9: Commit the storage slice**

```bash
git add src/sources/registry.ts src/state/store.ts src/types.ts test/source-registry.test.ts test/core.test.ts
git commit -m "feat: persist normalized group analysis sources"
```

### Task 2: Deterministic Group Source Commands

**Files:**
- Create: `src/service/group-source-service.ts`
- Modify: `src/service/message-service.ts`
- Modify: `src/index.ts`
- Test: `test/group-source-service.test.ts`
- Test: `test/core.test.ts`

- [ ] **Step 1: Write the failing command-service tests**

Cover these public outcomes:

```ts
await expect(service.handle(groupEvent, "固定来源 https://tenant.feishu.cn/docx/a"))
  .resolves.toMatchObject({ handled: true, message: expect.stringContaining("已固定") });
await expect(service.handle(groupEvent, "查看固定来源"))
  .resolves.toMatchObject({ handled: true, message: expect.stringContaining("docx/a") });
await expect(service.handle(groupEvent, "解绑来源 https://tenant.feishu.cn/docx/a"))
  .resolves.toMatchObject({ handled: true, message: expect.stringContaining("已解绑") });
await expect(service.handle(groupEvent, "清空固定来源"))
  .resolves.toMatchObject({ handled: true, message: expect.stringContaining("已清空") });
```

Also test missing links, unsupported URLs, a private-chat command, duplicate binding, limit errors, and ordinary analysis returning `{ handled: false }`.

- [ ] **Step 2: Run command tests and verify RED**

Run:

```bash
npx vitest run test/group-source-service.test.ts
```

Expected: FAIL because `GroupSourceService` does not exist.

- [ ] **Step 3: Implement deterministic parsing and replies**

Create:

```ts
export type GroupSourceCommandResult =
  | { handled: false }
  | { handled: true; message: string };

export class GroupSourceService {
  constructor(private readonly state: StateStore) {}
  handle(event: MessageEvent, prompt: string): GroupSourceCommandResult
  listUrls(chatId: string): string[]
}
```

Recognize only exact `固定来源`, `查看固定来源`, `解绑来源`, and `清空固定来源` prefixes. Validate every argument through `parseFeishuSourceUrl()`. A recognized command in private chat returns a handled error. Binding is all-or-nothing, command messages never call the Agent, and list output includes kind, normalized URL, and `addedBy`.

- [ ] **Step 4: Run command tests and verify GREEN**

Run:

```bash
npx vitest run test/group-source-service.test.ts
```

Expected: all command tests pass.

- [ ] **Step 5: Write failing MessageService command-routing test**

Construct `MessageService` with `GroupSourceService`, send a mentioned group binding command, and assert:

```ts
expect(agent.run).not.toHaveBeenCalled();
expect(tools.reply).toHaveBeenCalledWith(
  "om_bind",
  expect.stringContaining("已固定"),
  false,
);
```

- [ ] **Step 6: Run focused routing test and verify RED**

Run:

```bash
npx vitest run test/core.test.ts -t "group source command"
```

Expected: FAIL because `MessageService` does not route group source commands.

- [ ] **Step 7: Wire command handling before Agent execution**

Add an optional `GroupSourceService` constructor dependency to `MessageService`. After legacy `确认` handling and before source construction, call `handle(event, prompt)`. For handled results, use the existing `reply()` path and return. Instantiate and pass the service from `src/index.ts`.

- [ ] **Step 8: Run command and routing tests**

Run:

```bash
npx vitest run test/group-source-service.test.ts
npx vitest run test/core.test.ts -t "group source command"
```

Expected: all focused tests pass.

- [ ] **Step 9: Commit the command slice**

```bash
git add src/service/group-source-service.ts src/service/message-service.ts src/index.ts test/group-source-service.test.ts test/core.test.ts
git commit -m "feat: add group source configuration commands"
```

### Task 3: Automatic Analysis Injection and Documentation

**Files:**
- Modify: `src/service/message-service.ts`
- Modify: `README.md`
- Test: `test/core.test.ts`

- [ ] **Step 1: Write failing analysis-injection tests**

Cover:

- A normal mentioned group analysis includes stored sources.
- A private analysis never includes group sources.
- A temporary URL matching a stored normalized URL appears once.
- More than five merged URLs replies with a limit error and never calls the Agent.

The main assertion inspects the Agent context through its public `run()` call:

```ts
expect(agent.run.mock.calls[0]?.[0].sources.list()).toEqual(expect.arrayContaining([
  expect.objectContaining({ kind: "document" }),
]));
```

- [ ] **Step 2: Run focused injection tests and verify RED**

Run:

```bash
npx vitest run test/core.test.ts -t "fixed group sources"
```

Expected: FAIL because normal analysis does not load stored group URLs.

- [ ] **Step 3: Inject stored URLs only for group analysis**

In `MessageService.handle()`, get `groupSources.listUrls(event.chat_id)` only when `event.chat_type === "group"` and pass them to:

```ts
buildSources(prompt, this.defaultBase, fixedUrls)
```

Extend `buildSources()` to pass `additionalUrls` into `SourceRegistry.fromPrompt()`. Preserve default-Base injection only when the merged registry has no linked source.

- [ ] **Step 4: Run injection tests and verify GREEN**

Run:

```bash
npx vitest run test/core.test.ts -t "fixed group sources"
```

Expected: all focused injection tests pass.

- [ ] **Step 5: Update README**

Document:

- Four group commands.
- All-members authorization.
- Five-source limit and explicit unbinding.
- Automatic inclusion only in mentioned group analysis.
- Live reads using the application identity.
- Merge, deduplication, and over-limit behavior.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm test
npm run check
npm run build
git diff --check
```

Expected: all tests pass, TypeScript emits no errors, build succeeds, and diff check is empty.

- [ ] **Step 7: Commit the integration slice**

```bash
git add src/service/message-service.ts README.md test/core.test.ts docs/superpowers/plans/2026-07-24-group-fixed-sources.md
git commit -m "feat: inject fixed sources into group analysis"
```
