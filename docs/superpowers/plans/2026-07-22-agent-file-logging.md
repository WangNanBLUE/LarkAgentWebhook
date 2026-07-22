# Agent File Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the service under PM2 with stdout and stderr persisted only to `data/agent.log`, including bounded log rotation.

**Architecture:** Keep application logging on the standard streams and configure PM2 as the sole file sink. A focused configuration test locks the absolute log paths and merged-log behavior; `pm2-logrotate` handles retention without adding logging code to the application.

**Tech Stack:** Node.js 26, TypeScript, Vitest, PM2, pm2-logrotate

---

## File Structure

- Create `test/ecosystem.test.ts`: verifies the PM2 logging contract.
- Modify `ecosystem.config.cjs`: resolves one absolute log file and assigns it to both PM2 output streams.
- Modify `README.md`: documents the runtime log path and inspection command.

### Task 1: Lock The PM2 Logging Contract

**Files:**
- Create: `test/ecosystem.test.ts`
- Test: `test/ecosystem.test.ts`

- [ ] **Step 1: Write the failing configuration test**

```ts
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const ecosystem = require("../ecosystem.config.cjs") as {
  apps: Array<{ out_file?: string; error_file?: string; merge_logs?: boolean }>;
};

describe("PM2 logging", () => {
  test("merges stdout and stderr into the ignored data log", () => {
    const app = ecosystem.apps[0];
    const logPath = path.join(process.cwd(), "data", "agent.log");

    expect(app?.out_file).toBe(logPath);
    expect(app?.error_file).toBe(logPath);
    expect(app?.merge_logs).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/ecosystem.test.ts`

Expected: FAIL because `out_file`, `error_file`, and `merge_logs` are currently undefined.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/ecosystem.test.ts
git commit -m "test: define PM2 file logging contract"
```

### Task 2: Configure The Shared Log File

**Files:**
- Modify: `ecosystem.config.cjs`
- Test: `test/ecosystem.test.ts`

- [ ] **Step 1: Add the minimal PM2 configuration**

Replace `ecosystem.config.cjs` with:

```js
const path = require("node:path");

const logFile = path.join(__dirname, "data", "agent.log");

module.exports = {
  apps: [{
    name: "feishu-competitor-analysis",
    script: "dist/src/index.js",
    cwd: __dirname,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
    merge_logs: true,
    out_file: logFile,
    error_file: logFile,
    env: { NODE_ENV: "production" },
  }],
};
```

- [ ] **Step 2: Run the focused test and verify GREEN**

Run: `npm test -- test/ecosystem.test.ts`

Expected: PASS with one test passing.

- [ ] **Step 3: Run all static and automated checks**

Run: `npm test`

Expected: all test files and tests pass.

Run: `npm run check`

Expected: exit code 0 with no TypeScript errors.

Run: `npm run build`

Expected: exit code 0 and refreshed `dist/` output.

- [ ] **Step 4: Commit the PM2 configuration**

```bash
git add ecosystem.config.cjs
git commit -m "feat: persist agent logs through PM2"
```

### Task 3: Document The Operator Workflow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the log location after the PM2 commands**

Add:

````markdown
服务的 stdout 和 stderr 合并写入 `data/agent.log`。查看实时日志：

```bash
tail -f data/agent.log
```
````

- [ ] **Step 2: Check the documentation diff**

Run: `git diff --check`

Expected: exit code 0 with no whitespace errors.

- [ ] **Step 3: Commit the documentation**

```bash
git add README.md
git commit -m "docs: document agent log location"
```

### Task 4: Configure PM2 And Rotate Logs

**Files:**
- Runtime state: `/Users/blue/.pm2/`

- [ ] **Step 1: Install PM2 globally and verify it**

Run: `npm install -g pm2`

Expected: exit code 0.

Run: `pm2 --version`

Expected: a semantic version is printed.

- [ ] **Step 2: Install the rotation module**

Run: `pm2 install pm2-logrotate`

Expected: PM2 reports `pm2-logrotate` online.

- [ ] **Step 3: Configure bounded rotation**

Run: `pm2 set pm2-logrotate:max_size 10M`

Expected: PM2 confirms `max_size = 10M`.

Run: `pm2 set pm2-logrotate:retain 7`

Expected: PM2 confirms `retain = 7`.

Run: `pm2 set pm2-logrotate:compress true`

Expected: PM2 confirms `compress = true`.

### Task 5: Replace The Terminal Process And Verify Runtime Behavior

**Files:**
- Runtime log: `data/agent.log`
- Runtime state: `data/agent.sqlite*`

- [ ] **Step 1: Stop the verified terminal-attached service**

Run: `ps -p 58085 -o pid=,stat=,command=`

Expected: PID 58085 is `node --env-file=.env dist/src/index.js`.

Run: `kill -TERM 58085`

Expected: the process exits gracefully and port 8787 becomes available.

- [ ] **Step 2: Start the application under PM2 with `.env` loaded**

Run:

```bash
set -a
source .env
set +a
pm2 start ecosystem.config.cjs --update-env
```

Expected: PM2 reports `feishu-competitor-analysis` as `online`.

- [ ] **Step 3: Save the PM2 process list**

Run: `pm2 save`

Expected: PM2 reports that the process list was saved to `/Users/blue/.pm2/dump.pm2`.

- [ ] **Step 4: Verify health and log routing**

Run: `curl --silent --show-error --fail http://127.0.0.1:8787/healthz`

Expected: JSON includes `"status":"ok"`, `"eventReady":true`, and `"feishuReady":true`.

Run: `pm2 describe feishu-competitor-analysis`

Expected: status is `online`; both out log and error log resolve to `/Users/blue/Documents/LarkWebhook/data/agent.log`.

Run: `tail -n 20 data/agent.log`

Expected: output contains `竞品分析服务已就绪` from the new PM2-managed process.

Run: `git check-ignore -v data/agent.log`

Expected: `.gitignore` matches `data/agent.log` through the `data/` rule.

- [ ] **Step 5: Run final repository verification**

Run: `npm test`

Expected: all tests pass.

Run: `npm run check`

Expected: exit code 0.

Run: `npm run build`

Expected: exit code 0.
