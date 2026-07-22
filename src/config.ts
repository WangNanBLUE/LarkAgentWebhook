import { z } from "zod";

const envSchema = z.object({
  OPENAI_BASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  LARK_CLI_BINARY: z.string().default("lark-cli"),
  LARK_BOT_NAME: z.string().default("竞品分析"),
  LARK_BOT_OPEN_ID: z.string().optional(),
  LARK_BASE_TOKEN: z.string().default("MRWSbBwxMafAqRsAZsecYy9Mn5e"),
  LARK_TABLE_ID: z.string().default("tbl66n4X12oPZmz0"),
  LARK_TABLE_NAME: z.string().default("竞品书籍快照"),
  LARK_SNAPSHOT_FIELD: z.string().default("快照日期"),
  LARK_DASHBOARD_NAME: z.string().default("竞品书籍 AI 分析看板"),
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
      botName: value.LARK_BOT_NAME,
      botOpenId: value.LARK_BOT_OPEN_ID,
      baseToken: value.LARK_BASE_TOKEN,
      tableId: value.LARK_TABLE_ID,
      tableName: value.LARK_TABLE_NAME,
      snapshotField: value.LARK_SNAPSHOT_FIELD,
      dashboardName: value.LARK_DASHBOARD_NAME,
    },
    agent: { maxToolRounds: 6, timeoutMs: 90_000 },
    statePath: value.STATE_PATH,
    health: { host: value.HEALTH_HOST, port: value.HEALTH_PORT },
  };
}
