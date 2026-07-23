export class SourceBudget {
  private totalUsed = 0;
  private readonly sourceUsed = new Map<string, number>();

  constructor(
    private readonly perSourceLimit = 60_000,
    private readonly totalLimit = 120_000,
  ) {}

  take(sourceId: string, value: string): { text: string; truncated: boolean } {
    const sourceRemaining = this.perSourceLimit - (this.sourceUsed.get(sourceId) ?? 0);
    const totalRemaining = this.totalLimit - this.totalUsed;
    const allowed = Math.max(0, Math.min(value.length, sourceRemaining, totalRemaining));
    this.sourceUsed.set(sourceId, (this.sourceUsed.get(sourceId) ?? 0) + allowed);
    this.totalUsed += allowed;
    return { text: value.slice(0, allowed), truncated: allowed < value.length };
  }
}
