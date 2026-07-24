/**
 * Time-zone-aware date ranges for reporting. All boundaries are computed in the
 * configured IANA time zone (never the host's local zone) using `Intl` — no heavy
 * dependency. Ranges are half-open in UTC: `[startUtc, endUtcExclusive)`, so a
 * message at local midnight is counted in exactly one day/week.
 */
import type { WeekStart } from "./config.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface UtcRange {
  /** Inclusive lower bound (ISO-8601 UTC). */
  startUtc: string;
  /** Exclusive upper bound (ISO-8601 UTC). */
  endUtcExclusive: string;
}

export interface WeekRange extends UtcRange {
  /** The week's first local calendar date (YYYY-MM-DD). */
  localStartDate: string;
  /** The week's last local calendar date (YYYY-MM-DD, inclusive). */
  localEndDate: string;
}

/** Offset (ms) of `tz` from UTC at the given instant, DST included. */
function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

/** Converts a wall-clock time in `tz` to the corresponding UTC instant. */
function zonedToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  // Correct the guess by the offset observed at that instant (stable except in
  // the ~1h DST gap, which does not affect midnight boundaries in practice).
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}

/** Local midnight (start of `dateStr`) in `tz`, as a UTC instant. */
export function localDateStartUtc(dateStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return zonedToUtc(y, m, d, 0, 0, 0, tz);
}

/** Offset in whole seconds of `tz` at `atUtcIso` — used for SQL day bucketing. */
export function tzOffsetSeconds(atUtcIso: string, tz: string): number {
  return Math.round(tzOffsetMs(new Date(atUtcIso), tz) / 1000);
}

/** The local calendar date (YYYY-MM-DD) of a UTC instant in `tz`. */
export function localDateOf(instant: Date, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Day of week (0=Sunday…6=Saturday) of a UTC instant interpreted in `tz`. */
export function weekdayInTz(instant: Date, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(instant);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] ?? 0;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Resolves an inclusive `[startDate, endDate]` pair of local calendar dates into
 * a half-open UTC range. `endDate` is treated as a full day, so the exclusive
 * upper bound is local midnight of the day after `endDate`.
 * @throws {Error} On malformed dates or an end earlier than the start.
 */
export function resolveDateRange(startDate: string, endDate: string, tz: string): UtcRange {
  if (!ISO_DATE.test(startDate))
    throw new Error(`start_date must be YYYY-MM-DD (got "${startDate}").`);
  if (!ISO_DATE.test(endDate)) throw new Error(`end_date must be YYYY-MM-DD (got "${endDate}").`);
  if (endDate < startDate) throw new Error("end_date must not be earlier than start_date.");
  return {
    startUtc: localDateStartUtc(startDate, tz).toISOString(),
    endUtcExclusive: localDateStartUtc(addDays(endDate, 1), tz).toISOString(),
  };
}

/** Snaps `dateStr` back to the most recent `weekStart` weekday (inclusive). */
function snapToWeekStart(dateStr: string, tz: string, weekStart: WeekStart): string {
  const target = weekStart === "MONDAY" ? 1 : 0;
  let cursor = dateStr;
  for (let i = 0; i < 7; i++) {
    const dow = weekdayInTz(localDateStartUtc(cursor, tz), tz);
    if (dow === target) return cursor;
    cursor = addDays(cursor, -1);
  }
  return dateStr;
}

/**
 * Resolves a seven-day week. The supplied local date is snapped back to the
 * configured week-start weekday, then a 7-day half-open UTC range is returned
 * along with the exact local boundaries used.
 */
export function resolveWeek(localDate: string, tz: string, weekStart: WeekStart): WeekRange {
  if (!ISO_DATE.test(localDate))
    throw new Error(`week_start_date must be YYYY-MM-DD (got "${localDate}").`);
  const start = snapToWeekStart(localDate, tz, weekStart);
  const endInclusive = addDays(start, 6);
  return {
    startUtc: localDateStartUtc(start, tz).toISOString(),
    endUtcExclusive: localDateStartUtc(addDays(start, 7), tz).toISOString(),
    localStartDate: start,
    localEndDate: endInclusive,
  };
}

/**
 * The most recently *completed* full week relative to `now`. The current
 * (possibly partial) week is excluded: we snap today to its week-start, then step
 * back seven days.
 */
export function mostRecentCompletedWeek(now: Date, tz: string, weekStart: WeekStart): WeekRange {
  const today = localDateOf(now, tz);
  const currentWeekStart = snapToWeekStart(today, tz, weekStart);
  const previousWeekStart = addDays(currentWeekStart, -7);
  return resolveWeek(previousWeekStart, tz, weekStart);
}

/** The seven-day week immediately before `week` (for previous-period comparison). */
export function previousWeek(week: WeekRange, tz: string, weekStart: WeekStart): WeekRange {
  return resolveWeek(addDays(week.localStartDate, -7), tz, weekStart);
}
