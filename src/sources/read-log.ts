import { createHash } from "node:crypto";
import type { InputSource, SourceReadResult } from "./types.js";

export function logSourceRead(source: InputSource, result: SourceReadResult, status = "completed"): void {
  const returnedCharacters = typeof result.content === "string"
    ? result.content.length
    : JSON.stringify(result.content).length;
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "source.read",
    source_id: source.id,
    source_type: result.source_type,
    resource_hash: createHash("sha256").update(source.url ?? source.title).digest("hex").slice(0, 16),
    range: result.range,
    returned_characters: returnedCharacters,
    complete: result.complete,
    truncated: result.truncated,
    status,
  })}\n`);
}
