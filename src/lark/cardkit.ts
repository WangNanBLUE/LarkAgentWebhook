import { randomUUID } from "node:crypto";
import type { MessageEvent } from "../types.js";
import type { BaseTools } from "./base-tools.js";
import type { LarkCli } from "./cli.js";

export const STATUS_ELEMENT_ID = "status_text";
export const ANSWER_ELEMENT_ID = "answer_text";
export const ANSWER_PREFIX = "\u200b";

const FLUSH_INTERVAL_MS = 250;
const STATUS_TEXT = {
  analyzing: "正在分析",
  querying: "正在查询看板数据",
  summarizing: "正在整理分析结果",
} as const;

export type StreamingCardStatus = keyof typeof STATUS_TEXT;

export function buildStreamingCard(): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      streaming_mode: true,
      summary: { content: "[生成中...]" },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        { tag: "markdown", element_id: STATUS_ELEMENT_ID, content: STATUS_TEXT.analyzing },
        { tag: "markdown", element_id: ANSWER_ELEMENT_ID, content: ANSWER_PREFIX },
      ],
    },
  };
}

export class StreamingCardKit {
  constructor(private readonly cli: LarkCli, private readonly tools: BaseTools) {}

  async start(event: MessageEvent): Promise<StreamingCardSession> {
    const created = await this.cli.runRetryable<unknown>([
      "api", "POST", "/open-apis/cardkit/v1/cards",
      "--data", JSON.stringify({ type: "card_json", data: JSON.stringify(buildStreamingCard()) }),
      "--as", "bot", "--format", "json",
    ]);
    const cardId = findString(created, "card_id");
    if (!cardId) throw new Error("CardKit create response did not include card_id");
    await this.tools.replyCard(event.message_id, cardId, event.chat_type === "group");
    return new StreamingCardSession(this.cli, cardId);
  }
}

export class StreamingCardSession {
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private answer = "";
  private lastQueuedAnswer = "";
  private failure: unknown;
  private finished = false;

  constructor(private readonly cli: LarkCli, private readonly cardId: string) {}

  appendText(delta: string): void {
    if (this.finished || !delta) return;
    this.answer += delta;
    if (!this.timer) this.timer = setTimeout(() => this.flushAnswer(), FLUSH_INTERVAL_MS);
  }

  setStatus(status: StreamingCardStatus): void {
    if (this.finished) return;
    this.updateElement(STATUS_ELEMENT_ID, STATUS_TEXT[status]);
  }

  async finish(finalText: string): Promise<boolean> {
    if (this.finished) {
      await this.queue;
      return this.failure === undefined;
    }
    this.finished = true;
    this.cancelTimer();
    this.answer = mergeFinalText(this.answer, finalText);
    this.flushAnswer();
    this.updateElement(STATUS_ELEMENT_ID, "分析完成");
    this.updateSettings(this.answer);
    await this.queue;
    return this.failure === undefined;
  }

  async fail(message: string): Promise<boolean> {
    if (this.finished) {
      await this.queue;
      return this.failure === undefined;
    }
    this.finished = true;
    this.cancelTimer();
    const text = `处理失败：${message.slice(0, 500)}`;
    this.answer = text;
    this.flushAnswer();
    this.updateElement(STATUS_ELEMENT_ID, "分析失败");
    this.updateSettings(text);
    await this.queue;
    return this.failure === undefined;
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flushAnswer(): void {
    this.timer = undefined;
    if (this.answer === this.lastQueuedAnswer) return;
    this.lastQueuedAnswer = this.answer;
    this.updateElement(ANSWER_ELEMENT_ID, this.answer ? `${ANSWER_PREFIX}${this.answer}` : ANSWER_PREFIX);
  }

  private updateElement(elementId: string, content: string): void {
    const path = `/open-apis/cardkit/v1/cards/${encodeURIComponent(this.cardId)}/elements/${elementId}/content`;
    this.enqueue("PUT", path, (sequence) => ({ content, sequence, uuid: randomUUID() }));
  }

  private updateSettings(finalText: string): void {
    const summary = finalText.replaceAll(ANSWER_PREFIX, "").trim().slice(0, 80) || "分析完成";
    const path = `/open-apis/cardkit/v1/cards/${encodeURIComponent(this.cardId)}/settings`;
    this.enqueue("PATCH", path, (sequence) => ({
      settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }),
      sequence,
      uuid: randomUUID(),
    }));
  }

  private enqueue(
    method: "PUT" | "PATCH",
    path: string,
    body: (sequence: number) => Record<string, unknown>,
  ): void {
    const sequence = ++this.sequence;
    this.queue = this.queue.then(async () => {
      if (this.failure !== undefined) return;
      try {
        await this.cli.runRetryable([
          "api", method, path,
          "--data", JSON.stringify(body(sequence)),
          "--as", "bot", "--format", "json",
        ]);
      } catch (error) {
        this.failure ??= error;
      }
    });
  }
}

function findString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key] as string;
  for (const child of Object.values(record)) {
    const found = findString(child, key);
    if (found) return found;
  }
  return undefined;
}

function mergeFinalText(streamedText: string, finalText: string): string {
  if (!streamedText || finalText.startsWith(streamedText)) return finalText;
  if (!finalText || streamedText.endsWith(finalText)) return streamedText;
  return streamedText + finalText;
}
