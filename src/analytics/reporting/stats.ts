/**
 * Small, dependency-free statistics helpers with the phase's numeric rules baked
 * in: percentages always expose numerator + denominator and return null when the
 * denominator is zero; comparisons never return infinite percentage change; raw
 * counts are never rounded (only derived rates/durations are).
 */

export interface Ratio {
  numerator: number;
  denominator: number;
  /** Percentage 0–100, rounded to 2 dp; null when the denominator is zero. */
  percentage: number | null;
}

export interface Comparison {
  current: number;
  previous: number;
  absoluteChange: number;
  /** Percentage change, rounded to 2 dp; null when undefined (see `reason`). */
  percentageChange: number | null;
  /** Present only when percentageChange is null, explaining why. */
  reason?: string;
}

/** Rounds to `dp` decimal places (default 2). Use for rates/durations, not counts. */
export function round(value: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/** Builds a {numerator, denominator, percentage} ratio; null percentage when d=0. */
export function ratio(numerator: number, denominator: number): Ratio {
  return {
    numerator,
    denominator,
    percentage: denominator === 0 ? null : round((numerator / denominator) * 100),
  };
}

/** Compares current vs previous, guarding against divide-by-zero → null change. */
export function compare(current: number, previous: number): Comparison {
  const absoluteChange = round(current - previous, 4);
  if (previous === 0) {
    return {
      current,
      previous,
      absoluteChange,
      percentageChange: null,
      reason: "previous value is zero; percentage change is undefined",
    };
  }
  return {
    current,
    previous,
    absoluteChange,
    percentageChange: round(((current - previous) / previous) * 100),
  };
}

/** Arithmetic mean, or null for an empty set. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Median (linear interpolation), or null for an empty set. */
export function median(values: number[]): number | null {
  return percentile(values, 50);
}

/**
 * The `p`-th percentile (0–100) by linear interpolation, or null for an empty
 * set. `percentile(xs, 50)` is the median.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return round(values[0]);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return round(sorted[lo]);
  return round(sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo));
}
