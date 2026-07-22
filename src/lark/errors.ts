export interface CliErrorShape {
  type?: string;
  subtype?: string;
  code?: number;
  message?: string;
  hint?: string;
}

export function classifyCliError(error: CliErrorShape) {
  const retryable = error.type === "network" || error.type === "internal" || error.subtype === "rate_limit" || error.code === 1254290;
  return { retryable, category: retryable ? "transient" as const : "terminal" as const };
}

export class LarkCliError extends Error {
  readonly details: CliErrorShape;
  readonly retryable: boolean;

  constructor(details: CliErrorShape) {
    super(details.message ?? "lark-cli failed");
    this.name = "LarkCliError";
    this.details = details;
    this.retryable = classifyCliError(details).retryable;
  }
}
