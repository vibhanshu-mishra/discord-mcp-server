/**
 * `sync` — runs a historical import from Discord into the local database without
 * requiring an MCP client. It REUSES the existing `syncMessageHistory` service
 * (no duplicated importer), reads Discord and writes only to local SQLite, never
 * writes to Discord, works while `DISCORD_READ_ONLY=true`, and holds the writer
 * lock for the duration. Progress is reported as counts only — never content.
 */
import { EXIT, CliError, type ExitCode } from "../exitCodes.js";
import { printJson, printLine, type Args } from "../output.js";
import { getOperationsConfig } from "../../operations/opsConfig.js";
import { acquireLock } from "../../operations/processLock.js";
import { createLogger } from "../../operations/logger.js";
import { openDatabase, closeDatabase } from "../../analytics/database.js";
import { AnalyticsRepository } from "../../analytics/repository.js";
import { getAnalyticsConfig, isAnalyticsGuildAuthorised } from "../../analytics/config.js";
import { syncMessageHistory, type SyncSummary } from "../../analytics/sync.js";

const SNOWFLAKE = /^\d{17,20}$/;

/** Maps a sync summary to an exit code: complete failure, partial, or success. */
export function computeSyncExit(summary: SyncSummary): ExitCode {
  const total = summary.channels.length;
  const failed = summary.channels.filter((c) => c.status === "failed").length;
  if (total > 0 && failed === total) return EXIT.FAILURE;
  if (failed > 0) return EXIT.PARTIAL;
  return EXIT.SUCCESS;
}

export async function run(args: Args): Promise<number> {
  const ops = getOperationsConfig();
  const config = getAnalyticsConfig();
  const json = args.bool("json");
  const dryRun = args.bool("dry-run") || args.bool("estimate");

  const guildId = args.require("guild-id");
  if (!SNOWFLAKE.test(guildId))
    throw new CliError("Invalid --guild-id (must be a snowflake).", EXIT.INVALID_ARG);

  const startDate = args.get("start-date") ?? config.historyStartDate ?? undefined;
  if (!startDate)
    throw new CliError("Missing --start-date (and no configured default).", EXIT.INVALID_ARG);

  if (!isAnalyticsGuildAuthorised(guildId, config)) {
    throw new CliError(
      "Guild is not authorised (must be in both DISCORD_ANALYTICS_GUILD_IDS and DISCORD_ALLOWED_GUILDS).",
      EXIT.CONFIG,
    );
  }

  const channelIds = (args.get("channel-ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const maxRaw = args.get("max-messages");
  const maxMessagesPerChannel = maxRaw !== undefined ? Number(maxRaw) : undefined;
  if (
    maxRaw !== undefined &&
    (!Number.isInteger(maxMessagesPerChannel) || maxMessagesPerChannel! < 1)
  ) {
    throw new CliError("--max-messages must be a positive integer.", EXIT.INVALID_ARG);
  }

  const logger = createLogger({ json });
  // Lazily import the Discord client so offline commands never load discord.js.
  const { discord, ensureConnected } = await import("../../client.js");
  const { createDiscordSource } = await import("../../analytics/discordSource.js");

  try {
    await ensureConnected();
  } catch (err) {
    throw new CliError(
      `Discord connection failed: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.DISCORD,
    );
  }

  // Actual syncs acquire the writer lock; a dry run performs no DB writes.
  const lock = dryRun ? null : acquireLock(ops.lockPath, ops.dbPath, "sync");
  const db = openDatabase(ops.dbPath);
  const repo = new AnalyticsRepository(db, config.storeMessageContent);
  let summary: SyncSummary;
  try {
    summary = await syncMessageHistory(
      repo,
      createDiscordSource(discord),
      config,
      {
        guildId,
        startDate,
        channelIds: channelIds.length ? channelIds : undefined,
        maxMessagesPerChannel,
        dryRun,
      },
      (msg) => logger.info(`[sync] ${msg}`),
    );
  } catch (err) {
    throw new CliError(
      `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.DISCORD,
    );
  } finally {
    closeDatabase(db);
    lock?.release();
  }

  const exit = computeSyncExit(summary);
  if (json) {
    printJson({ ...summary, dryRun, exit });
  } else {
    printLine(
      `Sync ${dryRun ? "(dry-run) " : ""}for guild ${summary.guildId}: ${summary.totalMessages} messages across ${summary.channels.length} channel(s).`,
    );
    for (const c of summary.channels) {
      printLine(
        `  ${c.status.padEnd(9)} ${c.channelId} — ${c.messagesImported} message(s)${c.error ? ` (error: ${c.error})` : ""}`,
      );
    }
  }
  return exit;
}
