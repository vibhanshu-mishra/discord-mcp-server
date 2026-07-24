/**
 * Analytics MCP toolset — a THIN interface over the reusable services in
 * `../analytics`. These tools validate input and format output; all real work
 * (database, sync, queries) lives in the services.
 *
 * Read-only distinction (see `../readonly.ts`):
 *  - Every tool here sets `discordWrite: false` — none of them ever mutate Discord.
 *  - The four inspection tools are honestly `readOnlyHint: true`.
 *  - `discord_sync_message_history` is honestly `readOnlyHint: false` because it
 *    writes LOCAL rows, yet `discordWrite: false` keeps it usable under
 *    `DISCORD_READ_ONLY=true` while genuine Discord-write tools stay blocked.
 */
import { basename } from "node:path";
import { z } from "zod";
import { defineTool, defineModule, snowflake, intIn, structured } from "./define.js";
import type { ToolResult } from "./types.js";
import { getAnalyticsRuntime } from "../analytics/runtime.js";
import { isAnalyticsGuildAuthorised } from "../analytics/config.js";
import { syncMessageHistory } from "../analytics/sync.js";
import type {
  MessageCountFilter,
  MessageCountGroupBy,
  VoiceSessionFilter,
} from "../analytics/repository.js";
import type { SyncRunStatus } from "../analytics/types.js";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a calendar date in YYYY-MM-DD form.");

const guildIdField = snowflake.describe("Discord server (guild) ID (snowflake).");

/** Only reveal the file name when an absolute path is configured (no private dirs). */
function sanitizeDbPath(p: string): string {
  const absolute = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
  return absolute ? basename(p) : p;
}

/** Standard "analytics is off" error result for tools that need a live database. */
function analyticsDisabledError(reason: string): ToolResult {
  return {
    content: [{ type: "text", text: `⚠️ Analytics unavailable: ${reason}` }],
    isError: true,
  };
}

const tools = [
  defineTool({
    name: "discord_analytics_status",
    description:
      "Report the local analytics subsystem status: whether it is enabled, whether live collection is active, the (sanitised) database path, authorised guilds, whether message content is stored, the last successful sync, and stored row counts. Read-only; touches no Discord data.",
    annotations: { title: "Analytics status", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({}),
    handle: async () => {
      const rt = getAnalyticsRuntime();
      const counts = rt.repo?.getStatusCounts() ?? {
        messages: 0,
        channels: 0,
        members: 0,
        reactions: 0,
        voiceSessions: 0,
        openVoiceSessions: 0,
        lastSyncAt: null,
      };
      return structured({
        enabled: rt.enabled,
        liveCollectionActive: rt.active,
        databasePath: sanitizeDbPath(rt.config.dbPath),
        authorisedGuildIds: rt.config.guildIds,
        storeMessageContent: rt.config.storeMessageContent,
        collectVoice: rt.config.collectVoice,
        collectBotDms: rt.config.collectBotDms,
        lastSuccessfulSync: counts.lastSyncAt,
        messageCount: counts.messages,
        channelCount: counts.channels,
        memberCount: counts.members,
        reactionCount: counts.reactions,
        voiceSessionCount: counts.voiceSessions,
        openVoiceSessionCount: counts.openVoiceSessions,
        configurationNotes: rt.errors,
      });
    },
  }),

  defineTool({
    name: "discord_sync_message_history",
    description:
      "Import historical messages from a server's readable channels into the LOCAL analytics database. Reads Discord history only — it never sends, edits, deletes, or otherwise changes Discord. Writes solely to local SQLite, so it works even while DISCORD_READ_ONLY=true. The guild must be authorised by BOTH DISCORD_ANALYTICS_GUILD_IDS and DISCORD_ALLOWED_GUILDS. Returns per-channel progress and errors (never message content).",
    annotations: {
      title: "Sync message history (local DB write)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField,
      start_date: isoDate
        .optional()
        .describe(
          "Import messages no older than this date (YYYY-MM-DD). Defaults to the configured start date.",
        ),
      channel_ids: z
        .array(snowflake)
        .optional()
        .describe(
          "Restrict the sync to these channel/thread IDs. Omit to sync every readable channel.",
        ),
      max_messages_per_channel: intIn(1, 1_000_000)
        .optional()
        .describe("Safety cap on messages fetched per channel."),
      dry_run: z
        .boolean()
        .default(false)
        .describe("Estimate mode: page and count messages without writing to the database."),
    }),
    handle: async ({ guild_id, start_date, channel_ids, max_messages_per_channel, dry_run }) => {
      const rt = getAnalyticsRuntime();
      if (!rt.enabled) {
        return analyticsDisabledError(
          "set DISCORD_ANALYTICS_ENABLED=true (and configure DISCORD_ANALYTICS_GUILD_IDS) to import history.",
        );
      }
      if (!rt.repo || !rt.source) {
        return analyticsDisabledError(
          "the analytics database could not be initialised; check DISCORD_ANALYTICS_DB_PATH.",
        );
      }
      if (!isAnalyticsGuildAuthorised(guild_id, rt.config)) {
        return analyticsDisabledError(
          `guild ${guild_id} must be listed in BOTH DISCORD_ANALYTICS_GUILD_IDS and DISCORD_ALLOWED_GUILDS.`,
        );
      }
      const summary = await syncMessageHistory(
        rt.repo,
        rt.source,
        rt.config,
        {
          guildId: guild_id,
          startDate: start_date ?? null,
          channelIds: channel_ids,
          maxMessagesPerChannel: max_messages_per_channel,
          dryRun: dry_run,
        },
        (msg) => console.error(`[analytics sync] ${msg}`),
      );
      return structured({
        guildId: summary.guildId,
        dryRun: summary.dryRun,
        startDate: summary.startDate,
        totalMessages: summary.totalMessages,
        channels: summary.channels,
      });
    },
  }),

  defineTool({
    name: "discord_get_sync_runs",
    description:
      "List recent history-sync run results from the local database, with sanitised error summaries. Filter by guild, channel, status, and date range. Read-only.",
    annotations: { title: "Get sync runs", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField.optional(),
      channel_id: snowflake.optional().describe("Restrict to one channel/thread ID."),
      status: z
        .enum(["running", "completed", "failed", "skipped"])
        .optional()
        .describe("Filter by run status."),
      start_date: isoDate.optional().describe("Only runs started on/after this date."),
      end_date: isoDate.optional().describe("Only runs started on/before this date."),
      limit: intIn(1, 500).default(50).describe("Maximum rows to return."),
    }),
    handle: async ({ guild_id, channel_id, status, start_date, end_date, limit }) => {
      const rt = getAnalyticsRuntime();
      const runs = rt.repo
        ? rt.repo.getSyncRuns({
            guildId: guild_id,
            channelId: channel_id,
            status: status as SyncRunStatus | undefined,
            startDate: start_date,
            endDate: end_date,
            limit,
          })
        : [];
      return structured({ runs, analyticsEnabled: rt.enabled });
    },
  }),

  defineTool({
    name: "discord_get_stored_message_counts",
    description:
      "Return counts (never content) of locally stored messages, grouped by guild, channel, member, day, or week. Filter by guild, channels, members, date range, and whether to include bots. Read-only.",
    annotations: { title: "Get stored message counts", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      group_by: z
        .enum(["guild", "channel", "member", "day", "week"])
        .describe("How to group the counts."),
      guild_id: guildIdField.optional(),
      channel_ids: z.array(snowflake).optional().describe("Restrict to these channel IDs."),
      member_ids: z.array(snowflake).optional().describe("Restrict to these author IDs."),
      start_date: isoDate.optional().describe("Count messages created on/after this date."),
      end_date: isoDate.optional().describe("Count messages created on/before this date."),
      include_bots: z.boolean().default(true).describe("Include messages authored by bots."),
    }),
    handle: async ({
      group_by,
      guild_id,
      channel_ids,
      member_ids,
      start_date,
      end_date,
      include_bots,
    }) => {
      const rt = getAnalyticsRuntime();
      const filter: MessageCountFilter = {
        guildId: guild_id,
        channelIds: channel_ids,
        memberIds: member_ids,
        startDate: start_date,
        endDate: end_date,
        includeBots: include_bots,
      };
      const counts = rt.repo
        ? rt.repo.getMessageCounts(filter, group_by as MessageCountGroupBy)
        : [];
      return structured({ groupBy: group_by, counts, analyticsEnabled: rt.enabled });
    },
  }),

  defineTool({
    name: "discord_get_voice_sessions",
    description:
      "Return recorded voice-channel attendance sessions from the local database (join time, leave time, duration, channel, member, and whether the session is incomplete). Filter by guild, voice channels, members, date range, bot inclusion, and whether to include incomplete sessions. Read-only. Note: only sessions observed while the bot was online exist — historical attendance cannot be reconstructed.",
    annotations: { title: "Get voice sessions", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField.optional(),
      channel_ids: z.array(snowflake).optional().describe("Restrict to these voice-channel IDs."),
      member_ids: z.array(snowflake).optional().describe("Restrict to these member IDs."),
      start_date: isoDate.optional().describe("Sessions joined on/after this date."),
      end_date: isoDate.optional().describe("Sessions joined on/before this date."),
      include_bots: z.boolean().default(true).describe("Include sessions by bot accounts."),
      include_incomplete: z
        .boolean()
        .default(true)
        .describe("Include sessions with an unknown leave time (interrupted by a restart)."),
    }),
    handle: async ({
      guild_id,
      channel_ids,
      member_ids,
      start_date,
      end_date,
      include_bots,
      include_incomplete,
    }) => {
      const rt = getAnalyticsRuntime();
      const filter: VoiceSessionFilter = {
        guildId: guild_id,
        channelIds: channel_ids,
        memberIds: member_ids,
        startDate: start_date,
        endDate: end_date,
        includeBots: include_bots,
        includeIncomplete: include_incomplete,
      };
      const rows = rt.repo ? rt.repo.getVoiceSessions(filter) : [];
      const sessions = rows.map((s) => ({
        sessionId: s.session_id,
        guildId: s.guild_id,
        channelId: s.channel_id,
        memberId: s.user_id,
        isBot: s.user_is_bot === 1,
        joinedAt: s.joined_at,
        leftAt: s.left_at,
        durationSeconds: s.duration_seconds,
        isIncomplete: s.is_incomplete === 1,
        isOpen: s.is_open === 1,
      }));
      return structured({ sessions, analyticsEnabled: rt.enabled });
    },
  }),
];

export default defineModule(tools);
