/**
 * Phase 3 reporting configuration: the `DISCORD_ANALYTICS_*` variables that
 * describe who staff is, where trainings are posted, where office hours happen,
 * and the timing/time-zone rules used by every report.
 *
 * Like Phase 2's config, validation never throws and never echoes secrets or
 * message content. Invalid values are reported (secret-free) and safely
 * defaulted, so an analytics-disabled server always starts.
 */

/** Central list of question-opening phrases, shared by SQL and the app detector. */
export { QUESTION_PHRASES } from "./questions.js";

const SNOWFLAKE = /^\d{17,20}$/;

/** Safe upper bound for any "hours" window: one year. */
export const MAX_WINDOW_HOURS = 24 * 365;

const DEFAULT_RESPONSE_WINDOW_HOURS = 24;
const DEFAULT_ACK_WINDOW_HOURS = 24;
const DEFAULT_TRAINING_KEYWORDS = [
  "training",
  "workshop",
  "resource",
  "guide",
  "replay",
  "office hours",
];

export type WeekStart = "MONDAY" | "SUNDAY";

export interface ReportingConfig {
  /** Optional primary user's Discord ID (community owner/admin), or null when unset. */
  primaryUserId: string | null;
  /** Staff IDs exactly as configured (excludes the auto-added primary user). */
  configuredStaffUserIds: string[];
  /** Effective staff set used by every report — configured staff plus the primary user. */
  staffUserIds: string[];
  /** Channels where weekly trainings/resources are expected. */
  resourceChannelIds: string[];
  /** Voice channels used for office hours. */
  officeHourChannelIds: string[];
  /** Hours a staff response may take before a question counts as open. */
  responseWindowHours: number;
  /** Hours a reply/reaction may take before a message counts as unacknowledged. */
  acknowledgementWindowHours: number;
  /** IANA time zone for daily/weekly bucketing (validated). */
  timezone: string;
  /** First day of the week for weekly grouping. */
  weekStart: WeekStart;
  /** Lower-cased keywords that help flag training/resource posts. */
  trainingKeywords: string[];
}

export interface ReportingConfigValidation {
  config: ReportingConfig;
  /** Secret-free problems found while parsing the environment. */
  errors: string[];
}

/** True when `tz` is a time zone the runtime's Intl implementation accepts. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parses a comma-separated snowflake list, reporting (and dropping) bad IDs. */
function parseIdList(name: string, errors: string[]): string[] {
  const raw = (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const id of raw) {
    if (!SNOWFLAKE.test(id)) {
      errors.push(`${name} contains an invalid snowflake ID; it was ignored.`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Parses a positive-hours window, clamped to [1, MAX_WINDOW_HOURS]. */
function parseWindowHours(name: string, fallback: number, errors: string[]): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    errors.push(`${name} must be a positive number of hours; using default ${fallback}.`);
    return fallback;
  }
  if (value > MAX_WINDOW_HOURS) {
    errors.push(`${name} exceeds the safe maximum (${MAX_WINDOW_HOURS}h); clamped.`);
    return MAX_WINDOW_HOURS;
  }
  return value;
}

/** Validates the Phase 3 reporting environment without throwing. */
export function validateReportingConfig(): ReportingConfigValidation {
  const errors: string[] = [];

  const primaryRaw = process.env.DISCORD_ANALYTICS_PRIMARY_USER_ID?.trim();
  let primaryUserId: string | null = null;
  if (primaryRaw) {
    if (SNOWFLAKE.test(primaryRaw)) primaryUserId = primaryRaw;
    else errors.push("DISCORD_ANALYTICS_PRIMARY_USER_ID is not a valid snowflake; ignored.");
  }

  const configuredStaffUserIds = parseIdList("DISCORD_ANALYTICS_STAFF_USER_IDS", errors);
  // The primary user is always part of the effective staff set when configured.
  const staffUserIds = [...configuredStaffUserIds];
  if (primaryUserId && !staffUserIds.includes(primaryUserId)) staffUserIds.push(primaryUserId);

  const resourceChannelIds = parseIdList("DISCORD_ANALYTICS_RESOURCE_CHANNEL_IDS", errors);
  const officeHourChannelIds = parseIdList("DISCORD_ANALYTICS_OFFICE_HOUR_CHANNEL_IDS", errors);

  const responseWindowHours = parseWindowHours(
    "DISCORD_ANALYTICS_RESPONSE_WINDOW_HOURS",
    DEFAULT_RESPONSE_WINDOW_HOURS,
    errors,
  );
  const acknowledgementWindowHours = parseWindowHours(
    "DISCORD_ANALYTICS_ACKNOWLEDGEMENT_WINDOW_HOURS",
    DEFAULT_ACK_WINDOW_HOURS,
    errors,
  );

  let timezone = "UTC";
  const tzRaw = process.env.DISCORD_ANALYTICS_TIMEZONE?.trim();
  if (tzRaw) {
    if (isValidTimeZone(tzRaw)) timezone = tzRaw;
    else errors.push(`DISCORD_ANALYTICS_TIMEZONE "${tzRaw}" is not a valid IANA zone; using UTC.`);
  }

  let weekStart: WeekStart = "MONDAY";
  const weekRaw = process.env.DISCORD_ANALYTICS_WEEK_START?.trim().toUpperCase();
  if (weekRaw) {
    if (weekRaw === "MONDAY" || weekRaw === "SUNDAY") weekStart = weekRaw;
    else errors.push("DISCORD_ANALYTICS_WEEK_START must be MONDAY or SUNDAY; using MONDAY.");
  }

  const kwRaw = process.env.DISCORD_ANALYTICS_TRAINING_KEYWORDS?.trim();
  const trainingKeywords = (
    kwRaw
      ? kwRaw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : DEFAULT_TRAINING_KEYWORDS
  ).filter((v, i, a) => a.indexOf(v) === i);

  return {
    config: {
      primaryUserId,
      configuredStaffUserIds,
      staffUserIds,
      resourceChannelIds,
      officeHourChannelIds,
      responseWindowHours,
      acknowledgementWindowHours,
      timezone,
      weekStart,
      trainingKeywords,
    },
    errors,
  };
}

/** Convenience accessor returning just the parsed reporting config. */
export function getReportingConfig(): ReportingConfig {
  return validateReportingConfig().config;
}
