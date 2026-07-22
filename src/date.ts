export function parseShanghaiDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("snapshot_date must use a real YYYY-MM-DD date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error("snapshot_date must use a real YYYY-MM-DD date");
  }
  return Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000;
}
