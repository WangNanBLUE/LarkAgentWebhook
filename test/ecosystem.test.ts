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
