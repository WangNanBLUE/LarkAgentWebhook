import { AgentRunner } from "./agent/runner.js";
import { ActionExecutor } from "./actions/action-executor.js";
import { ActionService } from "./actions/action-service.js";
import { loadConfig } from "./config.js";
import { startHealthServer, type HealthState } from "./health.js";
import { BaseTools } from "./lark/base-tools.js";
import { BaseResource } from "./lark/base-resource.js";
import { StreamingCardKit } from "./lark/cardkit.js";
import { LarkCli } from "./lark/cli.js";
import { EventConsumer } from "./lark/event-consumer.js";
import { SourceReader } from "./lark/source-reader.js";
import { MessageService } from "./service/message-service.js";
import { ApprovalService } from "./service/approval-service.js";
import { StateStore } from "./state/store.js";
import type { CardActionEvent, MessageEvent } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const stateStore = new StateStore(config.statePath);
  const cli = new LarkCli(config.lark.binary);
  const baseTools = new BaseTools(cli, config, stateStore);
  const sourceReader = new SourceReader(cli);
  const baseResource = new BaseResource(cli);
  const actionService = new ActionService(stateStore, baseResource, sourceReader, baseTools);
  const actionExecutor = new ActionExecutor(cli, stateStore, baseResource, sourceReader);
  const health: HealthState = {
    startedAt: new Date().toISOString(),
    eventReady: false,
    sqliteReady: true,
    feishuReady: false,
    modelConfigured: true,
  };
  await cli.runText(["config", "strict-mode", "bot"]);
  const whoami = JSON.parse(await cli.runText(["whoami"])) as { identity?: string; appId?: string; available?: boolean };
  if (whoami.identity !== "bot" || whoami.available !== true || whoami.appId !== config.lark.expectedAppId) {
    throw new Error("lark-cli must use the 竞品分析 profile with strict-mode bot");
  }
  if (config.lark.defaultBase) {
    await baseTools.getSourceSchema();
  }
  await actionExecutor.reconcileExecutingActions();
  health.feishuReady = true;
  const healthServer = startHealthServer(config.health.host, config.health.port, health);

  const agent = new AgentRunner(config, baseTools, stateStore, undefined, sourceReader, baseResource, actionService);
  const cards = new StreamingCardKit(cli, baseTools);
  const botIdentity = config.lark.botOpenId || config.lark.botName;
  const service = new MessageService(
    botIdentity,
    stateStore,
    agent,
    baseTools,
    config.lark.responseMode,
    cards,
    actionExecutor,
    config.lark.defaultBase,
  );
  const approvalService = new ApprovalService(stateStore, actionExecutor, baseTools);
  const messageConsumer = new EventConsumer<MessageEvent>(cli, "im.message.receive_v1");
  const approvalConsumer = new EventConsumer<CardActionEvent>(cli, "card.action.trigger");
  const ready = { messages: false, approvals: false };
  const restartDelay = { messages: 1_000, approvals: 1_000 };
  let shuttingDown = false;

  const updateHealth = (): void => {
    health.eventReady = ready.messages && ready.approvals;
    health.degradedReason = health.eventReady ? undefined : "One or more event consumers are unavailable";
    if (health.eventReady) process.stdout.write(`竞品分析服务已就绪：http://${config.health.host}:${config.health.port}/healthz\n`);
  };
  const startConsumer = async <T>(
    name: keyof typeof ready,
    consumer: EventConsumer<T>,
    handler: (event: T) => Promise<void>,
  ): Promise<void> => {
    try {
      await consumer.start(handler, (error) => {
        ready[name] = false;
        health.degradedReason = error?.message;
        updateHealth();
        if (shuttingDown) return;
        setTimeout(() => void startConsumer(name, consumer, handler), restartDelay[name]);
        restartDelay[name] = Math.min(restartDelay[name] * 2, 30_000);
      });
      ready[name] = true;
      restartDelay[name] = 1_000;
      updateHealth();
    } catch (error) {
      ready[name] = false;
      health.degradedReason = error instanceof Error ? error.message : String(error);
      updateHealth();
      if (!shuttingDown) setTimeout(() => void startConsumer(name, consumer, handler), restartDelay[name]);
      restartDelay[name] = Math.min(restartDelay[name] * 2, 30_000);
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    health.eventReady = false;
    messageConsumer.stop();
    approvalConsumer.stop();
    const hardExit = setTimeout(() => process.exit(1), 5_000);
    hardExit.unref();
    await Promise.all([messageConsumer.drain(4_000), approvalConsumer.drain(4_000)]);
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    stateStore.close();
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await Promise.all([
    startConsumer("messages", messageConsumer, (event) => service.handle(event)),
    startConsumer("approvals", approvalConsumer, (event) => approvalService.handle(event)),
  ]);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
