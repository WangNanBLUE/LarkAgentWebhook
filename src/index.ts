import { AgentRunner } from "./agent/runner.js";
import { loadConfig } from "./config.js";
import { startHealthServer, type HealthState } from "./health.js";
import { BaseTools } from "./lark/base-tools.js";
import { LarkCli } from "./lark/cli.js";
import { EventConsumer } from "./lark/event-consumer.js";
import { MessageService } from "./service/message-service.js";
import { StateStore } from "./state/store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const stateStore = new StateStore(config.statePath);
  const cli = new LarkCli(config.lark.binary);
  const baseTools = new BaseTools(cli, config, stateStore);
  const health: HealthState = {
    startedAt: new Date().toISOString(),
    eventReady: false,
    sqliteReady: true,
    feishuReady: false,
    modelConfigured: true,
  };
  const whoami = JSON.parse(await cli.runText(["whoami"])) as { identity?: string; appId?: string; available?: boolean };
  if (whoami.identity !== "bot" || whoami.available !== true || whoami.appId !== config.lark.expectedAppId) {
    throw new Error("lark-cli must use the 竞品分析 profile with strict-mode bot");
  }
  await baseTools.getSourceSchema();
  await baseTools.ensureDashboard();
  await baseTools.reconcileExecutingActions();
  health.feishuReady = true;
  const healthServer = startHealthServer(config.health.host, config.health.port, health);

  const agent = new AgentRunner(config, baseTools, stateStore);
  const botIdentity = config.lark.botOpenId || config.lark.botName;
  const service = new MessageService(botIdentity, stateStore, agent, baseTools);
  const consumer = new EventConsumer(cli);
  let restartDelay = 1_000;
  let shuttingDown = false;

  const startConsumer = async (): Promise<void> => {
    try {
      await consumer.start((event) => service.handle(event), (error) => {
        health.eventReady = false;
        health.degradedReason = error?.message;
        if (shuttingDown) return;
        setTimeout(() => void startConsumer(), restartDelay);
        restartDelay = Math.min(restartDelay * 2, 30_000);
      });
      health.eventReady = true;
      health.degradedReason = undefined;
      restartDelay = 1_000;
      process.stdout.write(`竞品分析服务已就绪：http://${config.health.host}:${config.health.port}/healthz\n`);
    } catch (error) {
      health.eventReady = false;
      health.degradedReason = error instanceof Error ? error.message : String(error);
      if (!shuttingDown) setTimeout(() => void startConsumer(), restartDelay);
      restartDelay = Math.min(restartDelay * 2, 30_000);
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    health.eventReady = false;
    consumer.stop();
    const hardExit = setTimeout(() => process.exit(1), 5_000);
    hardExit.unref();
    await consumer.drain(4_000);
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    stateStore.close();
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await startConsumer();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
