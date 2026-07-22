import type { AgentRunner } from "../agent/runner.js";
import type { BaseTools } from "../lark/base-tools.js";
import type { StateStore } from "../state/store.js";
import type { MessageEvent } from "../types.js";

export function shouldHandleEvent(event: MessageEvent, botIdentity: string): boolean {
  return event.chat_type === "group" && Boolean(event.mentions?.some((mention) => mention.id === botIdentity || mention.name === botIdentity));
}

export function stripBotMention(event: MessageEvent, botIdentity: string): string {
  const mention = event.mentions?.find((item) => item.id === botIdentity || item.name === botIdentity);
  return mention
    ? event.content.replaceAll(`@${mention.name}`, "").replaceAll(mention.name, "").replaceAll(mention.key, "").trim()
    : event.content.trim();
}

export class MessageService {
  constructor(
    private readonly botIdentity: string,
    private readonly state: StateStore,
    private readonly agent: AgentRunner,
    private readonly tools: BaseTools,
  ) {}

  async handle(event: MessageEvent): Promise<void> {
    if (!shouldHandleEvent(event, this.botIdentity)) return;
    if (!this.state.markMessageProcessed(event.message_id)) return;

    const prompt = stripBotMention(event, this.botIdentity);
    const conversationKey = event.root_id ?? event.reply_to ?? event.message_id;
    try {
      if (prompt === "确认") {
        const claimed = this.state.claimPendingAction(event.sender_id, event.chat_id, conversationKey);
        if (!claimed.ok) {
          const text = claimed.reason === "expired" ? "该变更预览已过期，请重新发起。" : "未找到由你发起、等待确认的变更。";
          await this.tools.reply(event.message_id, text);
          return;
        }
        const result = await this.tools.executeProposal(claimed.action.payload as never);
        await this.tools.reply(event.message_id, `变更已执行：\n${JSON.stringify(result, null, 2)}`);
        return;
      }

      const answer = await this.agent.run({ event, prompt, conversationKey });
      await this.tools.reply(event.message_id, answer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.tools.reply(event.message_id, `处理失败：${message.slice(0, 500)}`).catch(() => undefined);
    }
  }
}
