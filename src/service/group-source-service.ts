import { parseFeishuSourceUrl } from "../sources/registry.js";
import type { StateStore } from "../state/store.js";
import type { MessageEvent } from "../types.js";

export type GroupSourceCommandResult =
  | { handled: false }
  | { handled: true; message: string };

type Command = "固定来源" | "查看固定来源" | "解绑来源" | "清空固定来源";

export class GroupSourceService {
  constructor(private readonly state: StateStore) {}

  handle(event: MessageEvent, prompt: string): GroupSourceCommandResult {
    const match = prompt.match(/^(固定来源|查看固定来源|解绑来源|清空固定来源)(?:\s+([\s\S]*))?$/u);
    if (!match) return { handled: false };

    const command = match[1] as Command;
    const argument = match[2]?.trim() ?? "";
    if (event.chat_type !== "group") {
      this.log(event, command, "rejected", 0);
      return { handled: true, message: "固定来源命令仅支持群聊。" };
    }

    try {
      const message = this.execute(event, command, argument);
      return { handled: true, message };
    } catch (error) {
      this.log(event, command, "failed", 0);
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Group source limit exceeded: 5") {
        return { handled: true, message: "本群最多固定 5 个来源，请先解绑不再使用的来源。" };
      }
      throw error;
    }
  }

  listUrls(chatId: string): string[] {
    return this.state.listGroupSources(chatId).map(({ url }) => url);
  }

  private execute(event: MessageEvent, command: Command, argument: string): string {
    if (command === "查看固定来源") {
      if (argument) return "用法：查看固定来源";
      const sources = this.state.listGroupSources(event.chat_id);
      this.log(event, command, "completed", sources.length, sources.map(({ kind }) => kind));
      if (sources.length === 0) return "本群暂未固定分析来源。";
      return [
        `本群固定分析来源（${sources.length}/5）：`,
        ...sources.map((source, index) =>
          `${index + 1}. [${source.kind}] ${source.url}（添加人：${source.addedBy}）`),
      ].join("\n");
    }

    if (command === "清空固定来源") {
      if (argument) return "用法：清空固定来源";
      const count = this.state.clearGroupSources(event.chat_id);
      this.log(event, command, "completed", count);
      return `已清空 ${count} 个固定来源。`;
    }

    if (!argument) return `用法：${command} <1-5 个飞书链接>`;
    const tokens = argument.split(/\s+/u);
    if (tokens.length > 5) return "本群最多固定 5 个来源；单次命令也不能超过 5 个链接。";

    let parsed: ReturnType<typeof parseFeishuSourceUrl>[];
    try {
      parsed = tokens.map((token) => parseFeishuSourceUrl(token));
    } catch {
      this.log(event, command, "rejected", 0);
      return "存在不支持的链接；仅接受飞书 Docx、Wiki、Sheets 和 Base HTTPS 链接。";
    }

    if (command === "固定来源") {
      const result = this.state.bindGroupSources(
        event.chat_id,
        parsed.map(({ normalizedUrl, kind }) => ({ url: normalizedUrl, kind })),
        event.sender_id,
      );
      this.log(event, command, "completed", result.added.length, parsed.map(({ kind }) => kind));
      return `已固定 ${result.added.length} 个来源；已存在 ${result.existing.length} 个。`;
    }

    const urls = parsed.map(({ normalizedUrl }) => normalizedUrl);
    const removed = this.state.removeGroupSources(event.chat_id, urls);
    this.log(event, command, "completed", removed.length, parsed.map(({ kind }) => kind));
    return `已解绑 ${removed.length} 个来源；未找到 ${urls.length - removed.length} 个。`;
  }

  private log(
    event: MessageEvent,
    action: Command,
    status: "completed" | "failed" | "rejected",
    count: number,
    sourceKinds: string[] = [],
  ): void {
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "group_sources.config",
      action,
      chat_id: event.chat_id,
      sender_id: event.sender_id,
      source_kinds: [...new Set(sourceKinds)],
      count,
      status,
    })}\n`);
  }
}
