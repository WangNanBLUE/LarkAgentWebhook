import { z } from "zod";

const envSchema = z.object({
  OPENAI_BASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  LARK_CLI_BINARY: z.string().default("lark-cli"),
  LARK_EXPECTED_APP_ID: z.string().min(1),
  LARK_BOT_NAME: z.string().default("竞品分析"),
  LARK_BOT_OPEN_ID: z.string().optional(),
  LARK_RESPONSE_MODE: z.enum(["text", "streaming_card"]).default("streaming_card"),
  LARK_BASE_TOKEN: z.string().min(1).optional(),
  LARK_TABLE_ID: z.string().min(1).optional(),
  LARK_TABLE_NAME: z.string().min(1).optional(),
  LARK_SNAPSHOT_FIELD: z.string().min(1).optional(),
  LARK_DASHBOARD_NAME: z.string().min(1).optional(),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(600_000).default(180_000),
  AGENT_FINAL_RESPONSE_RESERVE_MS: z.coerce.number().int().min(10_000).max(120_000).default(60_000),
  STATE_PATH: z.string().default("./data/agent.sqlite"),
  HEALTH_HOST: z.string().default("127.0.0.1"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = envSchema.parse(env);
  return {
    openai: { baseURL: value.OPENAI_BASE_URL, apiKey: value.OPENAI_API_KEY, model: value.OPENAI_MODEL },
    lark: {
      binary: value.LARK_CLI_BINARY,
      expectedAppId: value.LARK_EXPECTED_APP_ID,
      botName: value.LARK_BOT_NAME,
      botOpenId: value.LARK_BOT_OPEN_ID,
      responseMode: value.LARK_RESPONSE_MODE,
      baseToken: value.LARK_BASE_TOKEN ?? "",
      tableId: value.LARK_TABLE_ID ?? "",
      tableName: value.LARK_TABLE_NAME ?? "竞品书籍快照",
      snapshotField: value.LARK_SNAPSHOT_FIELD ?? "快照日期",
      dashboardName: value.LARK_DASHBOARD_NAME ?? "竞品书籍 AI 分析看板",
      defaultBase: value.LARK_BASE_TOKEN && value.LARK_TABLE_ID ? {
        baseToken: value.LARK_BASE_TOKEN,
        tableId: value.LARK_TABLE_ID,
        tableName: value.LARK_TABLE_NAME ?? "竞品书籍快照",
        snapshotField: value.LARK_SNAPSHOT_FIELD ?? "快照日期",
        dashboardName: value.LARK_DASHBOARD_NAME ?? "竞品书籍 AI 分析看板",
      } : undefined,
    },
    agent: {
      maxToolRounds: 6,
      timeoutMs: value.AGENT_TIMEOUT_MS,
      finalResponseReserveMs: Math.min(value.AGENT_FINAL_RESPONSE_RESERVE_MS, value.AGENT_TIMEOUT_MS - 10_000),
    },
    statePath: value.STATE_PATH,
    health: { host: value.HEALTH_HOST, port: value.HEALTH_PORT },
  };
}
