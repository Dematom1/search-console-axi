export function searchDateRange(now = new Date()): { startDate: string; endDate: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const today = Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day));
  const format = (offset: number) => new Date(today + offset * 86_400_000).toISOString().slice(0, 10);
  return { startDate: format(-7), endDate: format(-1) };
}
