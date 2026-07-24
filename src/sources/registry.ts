import { randomUUID } from "node:crypto";
import type { InputSource, SourceDescriptor, SourceKind } from "./types.js";

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gu;
const TRAILING_PUNCTUATION = /[.,，。!！?？;；)）\]】]+$/u;
const KIND_BY_PREFIX: Array<[string, SourceKind]> = [
  ["/docx/", "document"],
  ["/wiki/", "wiki"],
  ["/sheets/", "sheet"],
  ["/spreadsheets/", "sheet"],
  ["/base/", "base"],
];

export interface ParsedFeishuSourceUrl {
  normalizedUrl: string;
  kind: Exclude<SourceKind, "text">;
  title: string;
}

export class SourceRegistry {
  private constructor(private readonly sources: Map<string, InputSource>) {}

  static fromPrompt(
    prompt: string,
    options: { idFactory?: () => string; additionalUrls?: string[] } = {},
  ): SourceRegistry {
    const idFactory = options.idFactory ?? (() => `src_${randomUUID()}`);
    const matches = [...prompt.matchAll(URL_PATTERN)];
    const parsedLinks = new Map<string, ParsedFeishuSourceUrl>();
    for (const raw of [...matches.map((match) => match[0]), ...(options.additionalUrls ?? [])]) {
      const parsed = parseFeishuSourceUrl(raw);
      parsedLinks.set(parsed.normalizedUrl, parsed);
    }
    if (parsedLinks.size > 5) throw new Error("At most 5 Feishu links are allowed per message");

    const sources = new Map<string, InputSource>();
    const text = prompt.replace(URL_PATTERN, " ").replace(/\s+/gu, " ").trim();
    if (text) {
      if (text.length > 20_000) throw new Error("Text source exceeds 20000 characters");
      const id = idFactory();
      sources.set(id, { id, kind: "text", title: "消息文本", text });
    }

    for (const parsed of parsedLinks.values()) {
      const id = idFactory();
      sources.set(id, {
        id,
        kind: parsed.kind,
        title: parsed.title,
        url: parsed.normalizedUrl,
      });
    }
    return new SourceRegistry(sources);
  }

  list(): SourceDescriptor[] {
    return [...this.sources.values()].map(({ id, kind, title }) => ({ id, kind, title }));
  }

  require(id: string): InputSource {
    const source = this.sources.get(id);
    if (!source) throw new Error("Unknown source_id for this request");
    return source;
  }

  hasLinkedSource(): boolean {
    return [...this.sources.values()].some((source) => source.kind !== "text");
  }

  withSource(source: InputSource): SourceRegistry {
    const sources = new Map(this.sources);
    sources.set(source.id, source);
    return new SourceRegistry(sources);
  }
}

export interface DefaultBaseSourceConfig {
  baseToken: string;
  tableId: string;
  tableName: string;
}

export function buildSources(
  prompt: string,
  defaultBase?: DefaultBaseSourceConfig,
  additionalUrls: string[] = [],
): SourceRegistry {
  const registry = SourceRegistry.fromPrompt(prompt, { additionalUrls });
  const competitorRequest = /(竞品|书籍)/u.test(prompt) && /(分析|查询|统计|排行|对比)/u.test(prompt);
  if (!defaultBase || registry.hasLinkedSource() || !competitorRequest) return registry;
  return registry.withSource({
    id: "src_default_base",
    kind: "base",
    title: defaultBase.tableName,
    resolvedBase: { baseToken: defaultBase.baseToken, tableId: defaultBase.tableId },
  });
}

export function parseFeishuSourceUrl(raw: string): ParsedFeishuSourceUrl {
  const url = new URL(raw.replace(TRAILING_PUNCTUATION, ""));
  if (url.protocol !== "https:" || !isFeishuHostname(url.hostname)) {
    throw new Error("Only HTTPS Feishu resource links are supported");
  }
  const kind = KIND_BY_PREFIX.find(([prefix]) => url.pathname.startsWith(prefix))?.[1];
  if (!kind || kind === "text") throw new Error("Unsupported Feishu resource link");

  const params = [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);
  url.hash = "";

  return {
    normalizedUrl: url.toString(),
    kind,
    title: decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? kind),
  };
}

function isFeishuHostname(hostname: string): boolean {
  return hostname === "feishu.cn" || hostname.endsWith(".feishu.cn");
}
