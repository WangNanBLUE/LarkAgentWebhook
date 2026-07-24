export type SourceKind = "text" | "document" | "sheet" | "base" | "wiki";

export interface ResolvedBaseSource {
  baseToken: string;
  tableId?: string;
  viewId?: string;
}

export interface InputSource {
  id: string;
  kind: SourceKind;
  title: string;
  text?: string;
  url?: string;
  resolvedBase?: ResolvedBaseSource;
}

export type SourceDescriptor = Pick<InputSource, "id" | "kind" | "title">;

export interface SourceReadResult {
  source_id: string;
  source_type: Exclude<SourceKind, "wiki">;
  title: string;
  range: string;
  complete: boolean;
  truncated: boolean;
  content: unknown;
}
