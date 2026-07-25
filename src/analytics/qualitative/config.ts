/**
 * Phase 4 qualitative-analysis configuration: the `DISCORD_ANALYTICS_*` variables
 * that govern content-output privacy, redaction/pseudonymisation, excluded
 * channels, and the deterministic topic/question thresholds.
 *
 * Like the other analytics configs, validation never throws and never echoes
 * secrets or message content. Invalid values are reported (secret-free) and
 * safely defaulted, so an analytics-disabled server always starts.
 */

const SNOWFLAKE = /^\d{17,20}$/;

/** Hard bounds so a mis-set value cannot leak more than intended. */
export const MAX_EXCERPT_CHARACTERS_CAP = 1000;
export const MAX_EVIDENCE_MESSAGES_CAP = 500;
export const MAX_TOPIC_LIMIT_CAP = 100;

const DEFAULTS = {
  allowContentOutput: false,
  maxExcerptCharacters: 240,
  maxEvidenceMessages: 100,
  redactMentions: true,
  pseudonymizeUsers: true,
  includeStaff: false,
  topicMinMessages: 3,
  topicLimit: 15,
  questionSimilarityThreshold: 0.65,
} as const;

const TRUE_VALUES = /^(true|1|yes|on)$/i;
const FALSE_VALUES = /^(false|0|no|off)$/i;

export interface QualitativeConfig {
  /** Master gate: may readable excerpts leave the DB through MCP at all? */
  allowContentOutput: boolean;
  maxExcerptCharacters: number;
  maxEvidenceMessages: number;
  redactMentions: boolean;
  pseudonymizeUsers: boolean;
  /** Channels excluded from qualitative content analysis (filtered in SQL). */
  excludedChannelIds: string[];
  /** Include configured-staff messages in topic/feedback analysis. */
  includeStaff: boolean;
  topicMinMessages: number;
  topicLimit: number;
  /** Jaccard similarity threshold (0..1) for recurring-question grouping. */
  questionSimilarityThreshold: number;
}

export interface QualitativeConfigValidation {
  config: QualitativeConfig;
  errors: string[];
}

function parseBool(name: string, fallback: boolean, errors: string[]): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim();
  if (TRUE_VALUES.test(v)) return true;
  if (FALSE_VALUES.test(v)) return false;
  errors.push(`${name} must be true/false; using default ${fallback}.`);
  return fallback;
}

function parseInt_(
  name: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    errors.push(`${name} must be an integer >= ${min}; using default ${fallback}.`);
    return fallback;
  }
  if (value > max) {
    errors.push(`${name} exceeds the safe maximum (${max}); clamped.`);
    return max;
  }
  return value;
}

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

/** Validates the Phase 4 environment without throwing. */
export function validateQualitativeConfig(): QualitativeConfigValidation {
  const errors: string[] = [];

  const allowContentOutput = parseBool(
    "DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT",
    DEFAULTS.allowContentOutput,
    errors,
  );
  const maxExcerptCharacters = parseInt_(
    "DISCORD_ANALYTICS_MAX_EXCERPT_CHARACTERS",
    DEFAULTS.maxExcerptCharacters,
    1,
    MAX_EXCERPT_CHARACTERS_CAP,
    errors,
  );
  const maxEvidenceMessages = parseInt_(
    "DISCORD_ANALYTICS_MAX_EVIDENCE_MESSAGES",
    DEFAULTS.maxEvidenceMessages,
    1,
    MAX_EVIDENCE_MESSAGES_CAP,
    errors,
  );
  const redactMentions = parseBool(
    "DISCORD_ANALYTICS_REDACT_MENTIONS",
    DEFAULTS.redactMentions,
    errors,
  );
  const pseudonymizeUsers = parseBool(
    "DISCORD_ANALYTICS_PSEUDONYMIZE_USERS",
    DEFAULTS.pseudonymizeUsers,
    errors,
  );
  const excludedChannelIds = parseIdList(
    "DISCORD_ANALYTICS_QUALITATIVE_EXCLUDED_CHANNEL_IDS",
    errors,
  );
  const includeStaff = parseBool(
    "DISCORD_ANALYTICS_QUALITATIVE_INCLUDE_STAFF",
    DEFAULTS.includeStaff,
    errors,
  );
  const topicMinMessages = parseInt_(
    "DISCORD_ANALYTICS_TOPIC_MIN_MESSAGES",
    DEFAULTS.topicMinMessages,
    1,
    1000,
    errors,
  );
  const topicLimit = parseInt_(
    "DISCORD_ANALYTICS_TOPIC_LIMIT",
    DEFAULTS.topicLimit,
    1,
    MAX_TOPIC_LIMIT_CAP,
    errors,
  );

  let questionSimilarityThreshold: number = DEFAULTS.questionSimilarityThreshold;
  const simRaw = process.env.DISCORD_ANALYTICS_QUESTION_SIMILARITY_THRESHOLD?.trim();
  if (simRaw) {
    const value = Number(simRaw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(
        `DISCORD_ANALYTICS_QUESTION_SIMILARITY_THRESHOLD must be between 0 and 1; using ${DEFAULTS.questionSimilarityThreshold}.`,
      );
    } else {
      questionSimilarityThreshold = value;
    }
  }

  return {
    config: {
      allowContentOutput,
      maxExcerptCharacters,
      maxEvidenceMessages,
      redactMentions,
      pseudonymizeUsers,
      excludedChannelIds,
      includeStaff,
      topicMinMessages,
      topicLimit,
      questionSimilarityThreshold,
    },
    errors,
  };
}

/** Convenience accessor returning just the parsed qualitative config. */
export function getQualitativeConfig(): QualitativeConfig {
  return validateQualitativeConfig().config;
}
