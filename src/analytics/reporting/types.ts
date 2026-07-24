/**
 * Shared shapes and small helpers for the reporting services. Each service
 * returns a plain, JSON-compatible object with a `methodology` field so results
 * are transparent and auditable, and a `limitations` list for data-quality caveats.
 */
import type { ReportingStore } from "./store.js";
import type { ReportingConfig } from "./config.js";
import { resolveDateRange, tzOffsetSeconds } from "./dateRange.js";

/** The resolved reporting period, exposing both local dates and UTC boundaries. */
export interface Period {
  timezone: string;
  startDate: string;
  endDate: string;
  startUtc: string;
  endUtcExclusive: string;
  /** Fixed tz offset (seconds) used for day bucketing across the range. */
  offsetSeconds: number;
}

/** Everything a service needs: a read-only store plus the reporting config. */
export interface ReportContext {
  store: ReportingStore;
  reporting: ReportingConfig;
  /** Injectable clock for deterministic tests (defaults to Date.now()). */
  now?: Date;
}

/** Resolves an inclusive local date range into a {@link Period}. */
export function buildPeriod(startDate: string, endDate: string, tz: string): Period {
  const { startUtc, endUtcExclusive } = resolveDateRange(startDate, endDate, tz);
  return {
    timezone: tz,
    startDate,
    endDate,
    startUtc,
    endUtcExclusive,
    offsetSeconds: tzOffsetSeconds(startUtc, tz),
  };
}

/** Collects data-quality limitation strings, de-duplicated. */
export class Limitations {
  private readonly set = new Set<string>();
  add(msg: string): void {
    this.set.add(msg);
  }
  addIf(condition: boolean, msg: string): void {
    if (condition) this.set.add(msg);
  }
  list(): string[] {
    return [...this.set];
  }
}

/** Truncates an excerpt to the 240-char privacy limit; null when not permitted. */
export function excerptOf(
  content: string | null,
  include: boolean,
  storeContent: boolean,
): string | null {
  if (!include || !storeContent || content === null) return null;
  return content.length <= 240 ? content : content.slice(0, 240);
}

export type { ReportingStore };
