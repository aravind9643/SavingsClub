/**
 * Calendar dates, in the user's own timezone.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious way to get "today" as
 * a YYYY-MM-DD string, and it is wrong everywhere east of Greenwich. It
 * converts to UTC first, so in IST (UTC+5:30) every moment between 00:00 and
 * 05:29 reports YESTERDAY -- roughly a quarter of every day.
 *
 * That is not a display nit. These strings are written to `date` columns the
 * database reasons about: a contribution recorded at 02:00 on the 11th lands
 * on the 10th, and if the grace date was the 10th the late fee is silently
 * skipped. Same shift moves `left_on`, `as_of` and every default paid-on.
 *
 * So the rule is: never derive a calendar date by going through UTC. Read the
 * local fields off the Date and format them.
 */

/** A calendar date as YYYY-MM-DD, read from local fields. Never via UTC. */
export function toDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today, in the user's timezone. The default for every date input. */
export function today(): string {
  return toDateString();
}

/** First day of a month as YYYY-MM-01 — the shape `contribution_periods` uses. */
export function monthStart(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * Parse a YYYY-MM-DD from the database as a LOCAL date.
 *
 * `new Date('2026-09-24')` is parsed as UTC midnight by spec, which renders as
 * the 23rd for anyone west of Greenwich and is a day off in date arithmetic
 * everywhere else. Splitting the parts sidesteps it.
 */
export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Whole days between two calendar dates, ignoring clock time. */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
