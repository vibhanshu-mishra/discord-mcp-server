/**
 * Analytics configuration: reads and validates the `DISCORD_ANALYTICS_*`
 * environment variables into a typed {@link AnalyticsConfig}.
 *
 * Design rules enforced here:
 *  - Analytics is DISABLED by default; only an explicit truthy value enables it.
 *  - Validation never throws and never echoes secrets. It returns a config plus a
 *    list of secret-free error strings so the caller can fail *safely* (degrade to
 *    disabled) instead of crashing the MCP server.
 *  - A guild is authorised only when it is listed in BOTH `DISCORD_ANALYTICS_GUILD_IDS`
 *    and the Phase 1 `DISCORD_ALLOWED_GUILDS` allow-list. One without the other is
 *    rejected — the two settings are ANDed, never ORed.
 *  - Discord IDs are always strings; the page limit is clamped to a safe bound.
 */
import { isGuildAllowed, allowListActive } from "../client.js";
import type { AnalyticsConfig, AnalyticsConfigValidation } from "./types.js";

/** Default on-disk location of the SQLite database (git-ignored via `data/`). */
export const DEFAULT_DB_PATH = "data/discord-analytics.sqlite";

/** Discord's hard cap for messages per fetch page; also our safe upper bound. */
export const MAX_SYNC_PAGE_LIMIT = 100;
const DEFAULT_SYNC_PAGE_LIMIT = 100;

const SNOWFLAKE = /^\d{17,20}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TRUE_VALUES = /^(true|1|yes|on)$/i;
const FALSE_VALUES = /^(false|0|no|off)$/i;

/**
 * Parses a boolean env flag. Unset or blank uses `fallback`; recognised
 * true/false spellings win; anything else is reported as an error and treated as
 * `fallback` so a typo fails safely rather than silently flipping behaviour.
 */
function parseBool(name: string, fallback: boolean, errors: string[]): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim();
  if (TRUE_VALUES.test(v)) return true;
  if (FALSE_VALUES.test(v)) return false;
  errors.push(`${name} must be true/false (got an unrecognised value); using default ${fallback}.`);
  return fallback;
}

/** True when analytics is switched on. Cheap check that reads only the master flag. */
export function isAnalyticsEnabled(): boolean {
  return parseBool("DISCORD_ANALYTICS_ENABLED", false, []);
}

/**
 * Validates the full analytics environment without throwing. Returns the parsed
 * config and any problems found. Callers that need a guaranteed-valid config when
 * analytics is enabled should inspect `errors` and refuse to start collection if
 * it is non-empty — but the MCP server itself must keep running regardless.
 */
export function validateAnalyticsConfig(): AnalyticsConfigValidation {
  const errors: string[] = [];

  const enabled = parseBool("DISCORD_ANALYTICS_ENABLED", false, errors);

  const dbPathRaw = process.env.DISCORD_ANALYTICS_DB_PATH?.trim();
  const dbPath = dbPathRaw && dbPathRaw.length > 0 ? dbPathRaw : DEFAULT_DB_PATH;

  // Guild IDs: split, validate as snowflakes, then AND with the allow-list.
  const rawGuildIds = (process.env.DISCORD_ANALYTICS_GUILD_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const guildIds: string[] = [];
  for (const id of rawGuildIds) {
    if (!SNOWFLAKE.test(id)) {
      errors.push(`DISCORD_ANALYTICS_GUILD_IDS contains an invalid snowflake ID; it was ignored.`);
      continue;
    }
    if (!isGuildAllowed(id)) {
      errors.push(
        `Guild ${id} is in DISCORD_ANALYTICS_GUILD_IDS but not in DISCORD_ALLOWED_GUILDS; ` +
          `analytics requires both, so it was rejected.`,
      );
      continue;
    }
    if (!guildIds.includes(id)) guildIds.push(id);
  }
  if (enabled && rawGuildIds.length === 0) {
    errors.push(
      "DISCORD_ANALYTICS_ENABLED=true but DISCORD_ANALYTICS_GUILD_IDS is empty; " +
        "no guild is authorised, so nothing will be collected.",
    );
  }

  // History start date (optional): must be YYYY-MM-DD and a real calendar date.
  let historyStartDate: string | null = null;
  const dateRaw = process.env.DISCORD_ANALYTICS_HISTORY_START_DATE?.trim();
  if (dateRaw && dateRaw.length > 0) {
    if (!ISO_DATE.test(dateRaw) || Number.isNaN(Date.parse(`${dateRaw}T00:00:00Z`))) {
      errors.push("DISCORD_ANALYTICS_HISTORY_START_DATE must be a valid YYYY-MM-DD date; ignored.");
    } else {
      historyStartDate = dateRaw;
    }
  }

  // Page limit: positive integer, clamped to [1, MAX_SYNC_PAGE_LIMIT].
  let syncPageLimit = DEFAULT_SYNC_PAGE_LIMIT;
  const pageRaw = process.env.DISCORD_ANALYTICS_SYNC_PAGE_LIMIT?.trim();
  if (pageRaw && pageRaw.length > 0) {
    const parsed = Number(pageRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push(
        `DISCORD_ANALYTICS_SYNC_PAGE_LIMIT must be a positive integer; using ${DEFAULT_SYNC_PAGE_LIMIT}.`,
      );
    } else {
      syncPageLimit = Math.min(parsed, MAX_SYNC_PAGE_LIMIT);
    }
  }

  const collectVoice = parseBool("DISCORD_ANALYTICS_COLLECT_VOICE", true, errors);
  const collectBotDms = parseBool("DISCORD_ANALYTICS_COLLECT_BOT_DMS", false, errors);
  const storeMessageContent = parseBool("DISCORD_ANALYTICS_STORE_MESSAGE_CONTENT", true, errors);

  const config: AnalyticsConfig = {
    enabled,
    dbPath,
    guildIds,
    historyStartDate,
    syncPageLimit,
    collectVoice,
    collectBotDms,
    storeMessageContent,
  };
  return { config, errors };
}

/** Convenience accessor returning just the parsed config (ignoring the error list). */
export function getAnalyticsConfig(): AnalyticsConfig {
  return validateAnalyticsConfig().config;
}

/**
 * True only when a guild is authorised by BOTH the analytics guild list and the
 * Phase 1 `DISCORD_ALLOWED_GUILDS` allow-list. This is the single gate every
 * analytics code path must use before touching a guild's data.
 */
export function isAnalyticsGuildAuthorised(guildId: string, config?: AnalyticsConfig): boolean {
  const cfg = config ?? getAnalyticsConfig();
  return cfg.guildIds.includes(guildId) && isGuildAllowed(guildId);
}

/** Whether a Phase 1 guild allow-list is active (surfaced in status output). */
export { allowListActive };
