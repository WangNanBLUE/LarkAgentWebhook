import { z } from "zod";
import type { SourceBudget } from "../sources/budget.js";
import type { InputSource, SourceReadResult } from "../sources/types.js";
import { logSourceRead } from "../sources/read-log.js";
import type { LarkCli } from "./cli.js";
import { LarkCliError } from "./errors.js";

const documentReadSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("keyword"), keyword: z.string().min(1).max(500) }).strict(),
  z.object({ mode: z.literal("section"), start_block_id: z.string().min(1) }).strict(),
  z.object({
    mode: z.literal("range"),
    start_block_id: z.string().min(1).optional(),
    end_block_id: z.string().min(1).optional(),
  }).strict(),
  z.object({ mode: z.literal("full") }).strict(),
]).superRefine((value, context) => {
  if (value.mode === "range" && !value.start_block_id && !value.end_block_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "range requires a start or end block" });
  }
});

const sheetReadSchema = z.object({
  sheet_id: z.string().min(1).max(200),
  range: z.string().min(1).max(500),
}).strict();

type DocumentReadInput = z.input<typeof documentReadSchema>;
type SheetReadInput = z.input<typeof sheetReadSchema>;

export class SourceReader {
  constructor(private readonly cli: LarkCli) {}

  async inspectDocument(source: InputSource, budget: SourceBudget): Promise<SourceReadResult> {
    assertSource(source, ["document", "wiki"]);
    const data = await this.cli.runRetryable<unknown>([
      "docs", "+fetch",
      "--doc", requireUrl(source),
      "--scope", "outline",
      "--max-depth", "3",
      "--detail", "simple",
      "--as", "bot",
      "--format", "json",
    ]);
    return logged(source, textResult(source, "document", "outline", false, findString(data, ["content"]) ?? "", budget));
  }

  async inspectDocumentState(source: InputSource): Promise<{
    document: string;
    revisionId: number;
    blocks: Array<{ id: string; content: string }>;
  }> {
    assertSource(source, ["document", "wiki"]);
    const data = await this.cli.runRetryable<unknown>([
      "docs", "+fetch", "--doc", requireUrl(source), "--detail", "full",
      "--as", "bot", "--format", "json",
    ]);
    const revisionId = findNumber(data, ["revision_id", "revisionId", "revision"]);
    if (revisionId === undefined) throw new Error("Document revision is unavailable");
    return { document: requireUrl(source), revisionId, blocks: findBlocks(data) };
  }

  async inspectDocumentBlock(source: InputSource, blockId: string): Promise<{
    document: string;
    revisionId: number;
    blockId: string;
    content: string;
  }> {
    assertSource(source, ["document", "wiki"]);
    const data = await this.cli.runRetryable<unknown>([
      "docs", "+fetch", "--doc", requireUrl(source), "--scope", "range",
      "--start-block-id", blockId, "--end-block-id", blockId, "--detail", "full",
      "--as", "bot", "--format", "json",
    ]);
    const revisionId = findNumber(data, ["revision_id", "revisionId", "revision"]);
    const content = findString(data, ["content"]);
    if (revisionId === undefined || content === undefined) throw new Error("Document block state is unavailable");
    return { document: requireUrl(source), revisionId, blockId, content };
  }

  async resolveWiki(source: InputSource, budget: SourceBudget): Promise<SourceReadResult> {
    assertSource(source, ["wiki"]);
    try {
      return await this.inspectDocument(source, budget);
    } catch (error) {
      if (!canProbeAnotherResourceType(error)) throw error;
    }
    try {
      return await this.inspectSheet(source);
    } catch (error) {
      if (!canProbeAnotherResourceType(error)) throw error;
      throw new UnresolvedBaseWikiError(source.id);
    }
  }

  async readDocument(
    source: InputSource,
    rawInput: DocumentReadInput,
    budget: SourceBudget,
  ): Promise<SourceReadResult> {
    assertSource(source, ["document", "wiki"]);
    const input = documentReadSchema.parse(rawInput);
    const args = ["docs", "+fetch", "--doc", requireUrl(source)];
    let range = "full";
    if (input.mode === "keyword") {
      args.push("--scope", "keyword", "--keyword", input.keyword);
      range = `keyword:${input.keyword}`;
    } else if (input.mode === "section") {
      args.push("--scope", "section", "--start-block-id", input.start_block_id);
      range = `section:${input.start_block_id}`;
    } else if (input.mode === "range") {
      args.push("--scope", "range");
      if (input.start_block_id) args.push("--start-block-id", input.start_block_id);
      if (input.end_block_id) args.push("--end-block-id", input.end_block_id);
      range = `range:${input.start_block_id ?? ""}:${input.end_block_id ?? ""}`;
    }
    args.push("--detail", "simple", "--as", "bot", "--format", "json");
    const data = await this.cli.runRetryable<unknown>(args);
    return logged(source, textResult(
      source,
      "document",
      range,
      input.mode === "full",
      findString(data, ["content"]) ?? "",
      budget,
    ));
  }

  async inspectSheet(source: InputSource): Promise<SourceReadResult> {
    assertSource(source, ["sheet", "wiki"]);
    const data = await this.cli.runRetryable<unknown>([
      "sheets", "+workbook-info",
      "--url", requireUrl(source),
      "--as", "bot",
      "--format", "json",
    ]);
    return logged(source, {
      source_id: source.id,
      source_type: "sheet",
      title: source.title,
      range: "workbook",
      complete: true,
      truncated: false,
      content: data,
    });
  }

  async readSheet(
    source: InputSource,
    rawInput: SheetReadInput,
    budget: SourceBudget,
  ): Promise<SourceReadResult> {
    assertSource(source, ["sheet", "wiki"]);
    const input = sheetReadSchema.parse(rawInput);
    const data = await this.cli.runRetryable<unknown>([
      "sheets", "+csv-get",
      "--url", requireUrl(source),
      "--sheet-id", input.sheet_id,
      "--range", input.range,
      "--as", "bot",
      "--format", "json",
    ]);
    return logged(source, textResult(
      source,
      "sheet",
      `${input.sheet_id}:${input.range}`,
      true,
      findString(data, ["annotated_csv", "csv", "content"]) ?? "",
      budget,
    ));
  }
}

export class UnresolvedBaseWikiError extends Error {
  constructor(readonly sourceId: string) {
    super("Wiki source may resolve to a Base and requires Base resolution");
  }
}

function textResult(
  source: InputSource,
  type: "document" | "sheet",
  range: string,
  complete: boolean,
  content: string,
  budget: SourceBudget,
): SourceReadResult {
  const bounded = budget.take(source.id, content);
  return {
    source_id: source.id,
    source_type: type,
    title: source.title,
    range,
    complete: complete && !bounded.truncated,
    truncated: bounded.truncated,
    content: bounded.text,
  };
}

function logged(source: InputSource, result: SourceReadResult): SourceReadResult {
  logSourceRead(source, result);
  return result;
}

function assertSource(source: InputSource, kinds: InputSource["kind"][]): void {
  if (!kinds.includes(source.kind)) throw new Error(`Source ${source.id} is not a ${kinds.join(" or ")} source`);
}

function requireUrl(source: InputSource): string {
  if (!source.url) throw new Error(`Source ${source.id} does not have a URL`);
  return source.url;
}

function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    const found = findString(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findNumber(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "number") return record[key];
  for (const child of Object.values(record)) {
    const found = findNumber(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findBlocks(value: unknown): Array<{ id: string; content: string }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(findBlocks);
  const record = value as Record<string, unknown>;
  const id = findString(record, ["block_id", "blockId"]);
  const content = findString(record, ["content", "text"]);
  const nested = Object.values(record).flatMap(findBlocks);
  return id ? [{ id, content: content ?? "" }, ...nested] : nested;
}

function canProbeAnotherResourceType(error: unknown): boolean {
  if (!(error instanceof LarkCliError)) return false;
  if (error.retryable || error.details.type === "authorization" || error.details.code === 91403) return false;
  return true;
}
