/**
 * Runtime wiring for the analytics subsystem — the single place the live server
 * initialises the database, collector, and Discord read-source, and the accessor
 * the MCP tools use to reach them.
 *
 * Guarantees:
 *  - When analytics is disabled, nothing is opened and the MCP starts normally.
 *  - Initialisation NEVER throws: any config/database failure is logged (without
 *    secrets or content) and leaves analytics in a degraded, inert state so the
 *    existing Discord MCP tools keep working.
 *  - The database is fully migrated before the collector is allowed to write.
 */
import type { Client } from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import { validateAnalyticsConfig } from "./config.js";
import { openDatabase, closeDatabase } from "./database.js";
import { AnalyticsRepository } from "./repository.js";
import { LiveCollector } from "./collector.js";
import { createDiscordSource } from "./discordSource.js";
import { recoverOpenSessions } from "./voice.js";
import type { DiscordSource } from "./sync.js";
import type { AnalyticsConfig } from "./types.js";

export interface AnalyticsRuntime {
  /** Config says analytics should run. */
  enabled: boolean;
  /** Live collection is actually attached (enabled AND init succeeded). */
  active: boolean;
  config: AnalyticsConfig;
  /** Secret-free configuration/initialisation problems, for the status tool. */
  errors: string[];
  db: DatabaseSync | null;
  repo: AnalyticsRepository | null;
  source: DiscordSource | null;
  collector: LiveCollector | null;
}

let runtime: AnalyticsRuntime | null = null;

/** Builds an inert runtime (nothing opened) from the current environment. */
function disabledRuntime(extraErrors: string[] = []): AnalyticsRuntime {
  const { config, errors } = validateAnalyticsConfig();
  return {
    enabled: config.enabled,
    active: false,
    config,
    errors: [...errors, ...extraErrors],
    db: null,
    repo: null,
    source: null,
    collector: null,
  };
}

/**
 * Initialises analytics for the live server. Safe to call once at startup; it
 * never throws. When disabled, it records an inert runtime and returns.
 */
export function initAnalytics(client: Client): void {
  const { config, errors } = validateAnalyticsConfig();

  if (!config.enabled) {
    runtime = disabledRuntime();
    return;
  }

  try {
    const db = openDatabase(config.dbPath);
    const repo = new AnalyticsRepository(db, config.storeMessageContent);
    // A previous process may have left voice sessions open — flag them incomplete.
    const recovered = recoverOpenSessions(repo);
    if (recovered > 0) {
      console.error(`[analytics] flagged ${recovered} interrupted voice session(s) as incomplete.`);
    }
    const source = createDiscordSource(client);
    const collector = new LiveCollector(client, repo, config);
    collector.start();
    runtime = { enabled: true, active: true, config, errors, db, repo, source, collector };
    console.error(
      `[analytics] enabled — collecting from ${config.guildIds.length} guild(s); ` +
        `content storage ${config.storeMessageContent ? "ON" : "OFF"}.`,
    );
  } catch (err) {
    // Fail safe: analytics off, MCP unaffected. Never print token/content.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[analytics] disabled after initialisation error: ${message}`);
    runtime = disabledRuntime([message]);
  }
}

/** Stops the collector and closes the database. Safe to call multiple times. */
export function shutdownAnalytics(): void {
  if (!runtime) return;
  try {
    runtime.collector?.stop();
  } catch {
    /* ignore */
  }
  closeDatabase(runtime.db);
  runtime = { ...runtime, active: false, db: null, repo: null, collector: null };
}

/** Returns the current runtime, lazily deriving an inert one from the environment. */
export function getAnalyticsRuntime(): AnalyticsRuntime {
  return runtime ?? (runtime = disabledRuntime());
}

/**
 * Test-only: inject a runtime (e.g. backed by an in-memory database) or reset to
 * null so the next accessor rebuilds from the environment. Never used in prod.
 */
export function setAnalyticsRuntimeForTest(next: AnalyticsRuntime | null): void {
  runtime = next;
}
