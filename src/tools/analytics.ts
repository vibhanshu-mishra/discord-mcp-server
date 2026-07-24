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
import { ReportingStore } from "../analytics/reporting/store.js";
import { getReportingConfig } from "../analytics/reporting/config.js";
import type { ReportContext } from "../analytics/reporting/types.js";
import { buildMemberEngagement } from "../analytics/reporting/memberEngagement.js";
import { buildUserActivity } from "../analytics/reporting/userActivity.js";
import { buildStaffResponseMetrics } from "../analytics/reporting/responseMetrics.js";
import {
  buildUnansweredQuestions,
  buildUnacknowledgedMessages,
} from "../analytics/reporting/openItems.js";
import { buildTrainingCadence } from "../analytics/reporting/trainingCadence.js";
import { buildOfficeHourMetrics } from "../analytics/reporting/officeHours.js";
import { buildWeeklyMetrics } from "../analytics/reporting/weeklyMetrics.js";

/**
 * Builds a read-only reporting context for a guild, or returns a clear error when
 * analytics is off, the database is unavailable, or the guild is not authorised.
 * All Phase 3 reporting tools funnel through this so the guardrails are uniform.
 */
function reportContext(guildId: string): { ctx: ReportContext } | { error: ToolResult } {
  const rt = getAnalyticsRuntime();
  if (!rt.enabled) {
    return {
      error: analyticsDisabledError("set DISCORD_ANALYTICS_ENABLED=true to use reporting."),
    };
  }
  if (!rt.repo) {
    return {
      error: analyticsDisabledError(
        "the analytics database is not available; check DISCORD_ANALYTICS_DB_PATH.",
      ),
    };
  }
  if (!isAnalyticsGuildAuthorised(guildId, rt.config)) {
    return {
      error: analyticsDisabledError(
        `guild ${guildId} must be listed in BOTH DISCORD_ANALYTICS_GUILD_IDS and DISCORD_ALLOWED_GUILDS.`,
      ),
    };
  }
  const store = new ReportingStore(rt.repo.connection, rt.repo.storeContent);
  return { ctx: { store, reporting: getReportingConfig() } };
}

/** Optional array-of-snowflakes input, reused by several reporting tools. */
const idArray = z.array(snowflake);
const windowHours = intIn(1, 24 * 365);

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

  // ─── Phase 3: community metrics & reporting (read-only, local DB only) ──────

  defineTool({
    name: "discord_get_member_engagement",
    description:
      "Per-member community engagement over a date range: messages, active days, distinct channels, direct replies sent/received, unique reply partners, reactions received, and candidate questions. Reads only the local database; raw auditable counts (no engagement score).",
    annotations: { title: "Member engagement", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField,
      start_date: isoDate,
      end_date: isoDate,
      channel_ids: idArray.optional(),
      member_ids: idArray.optional(),
      include_bots: z.boolean().default(false),
      include_staff: z.boolean().default(true),
      limit: intIn(1, 1000).optional(),
      sort_by: z
        .enum([
          "messages",
          "active_days",
          "replies_sent",
          "replies_received",
          "reactions_received",
          "questions_asked",
          "last_activity",
        ])
        .optional(),
    }),
    handle: async (a) => {
      const rc = reportContext(a.guild_id);
      if ("error" in rc) return rc.error;
      return structured(
        buildMemberEngagement(rc.ctx, {
          guildId: a.guild_id,
          startDate: a.start_date,
          endDate: a.end_date,
          channelIds: a.channel_ids,
          memberIds: a.member_ids,
          includeBots: a.include_bots,
          includeStaff: a.include_staff,
          limit: a.limit,
          sortBy: a.sort_by,
        }),
      );
    },
  }),

  defineTool({
    name: "discord_get_user_activity",
    description:
      "A single user's posting cadence and reply activity over a date range, with optional daily and channel breakdowns and median first-response time. Works for any user in the authorised guild via the required user_id input. Local database only; no message content returned.",
    annotations: { title: "User activity", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField,
      user_id: snowflake.describe("The Discord user ID to report on."),
      start_date: isoDate,
      end_date: isoDate,
      channel_ids: idArray.optional(),
      include_daily_breakdown: z.boolean().default(true),
      include_channel_breakdown: z.boolean().default(true),
    }),
    handle: async (a) => {
      const rc = reportContext(a.guild_id);
      if ("error" in rc) return rc.error;
      return structured(
        buildUserActivity(rc.ctx, {
          guildId: a.guild_id,
          userId: a.user_id,
          startDate: a.start_date,
          endDate: a.end_date,
          channelIds: a.channel_ids,
          includeDailyBreakdown: a.include_daily_breakdown,
          includeChannelBreakdown: a.include_channel_breakdown,
        }),
      );
    },
  }),

  defineTool({
    name: "discord_get_staff_response_metrics",
    description:
      "Staff responsiveness to candidate member questions over a date range: response rate, within-window rate, average/median/p90 first-response time, and per-staff/per-channel breakdowns. Rates return null when no eligible questions exist. Local database only.",
    annotations: { title: "Staff response metrics", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField,
      start_date: isoDate,
      end_date: isoDate,
      channel_ids: idArray.optional(),
      staff_user_ids: idArray.optional(),
      response_window_hours: windowHours.optional(),
      include_per_staff_breakdown: z.boolean().default(true),
      include_channel_breakdown: z.boolean().default(true),
    }),
    handle: async (a) => {
      const rc = reportContext(a.guild_id);
      if ("error" in rc) return rc.error;
      return structured(
        buildStaffResponseMetrics(rc.ctx, {
          guildId: a.guild_id,
          startDate: a.start_date,
          endDate: a.end_date,
          channelIds: a.channel_ids,
          staffUserIds: a.staff_user_ids,
          responseWindowHours: a.response_window_hours,
          includePerStaffBreakdown: a.include_per_staff_breakdown,
          includeChannelBreakdown: a.include_channel_breakdown,
        }),
      );
    },
  }),

  defineTool({
    name: "discord_get_unanswered_questions",
    description:
      "Candidate member questions with no staff response, older than the response window (heuristic — requires human review). Reads only the local database. Excerpts are opt-in and capped at 240 characters; sorted oldest first.",
    annotations: { title: "Unanswered questions", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField,
      start_date: isoDate.optional(),
      end_date: isoDate.optional(),
      channel_ids: idArray.optional(),
      member_ids: idArray.optional(),
      minimum_age_hours: windowHours.optional(),
      response_window_hours: windowHours.optional(),
      limit: intIn(1, 1000).optional(),
      include_excerpt: z.boolean().default(false),
    }),
    handle: async (a) => {
      const rc = reportContext(a.guild_id);
      if ("error" in rc) return rc.error;
      return structured(
        buildUnansweredQuestions(rc.ctx, {
          guildId: a.guild_id,
          startDate: a.start_date,
          endDate: a.end_date,
          channelIds: a.channel_ids,
          memberIds: a.member_ids,
          minimumAgeHours: a.minimum_age_hours,
          responseWindowHours: a.response_window_hours,
          limit: a.limit,
          includeExcerpt: a.include_excerpt,
        }),
      );
    },
  }),

  defineTool({
    name: "discord_get_unacknowledged_messages",
    description:
      "Candidate member messages with no staff reply, reaction, or thread response within the acknowledgement window (heuristic — requires human review). Filter by questions/attachments/all. Local database only; excerpts opt-in, capped at 240 characters.",
    annotations: { title: "Unacknowledged messages", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField,
      start_date: isoDate.optional(),
      end_date: isoDate.optional(),
      channel_ids: idArray.optional(),
      member_ids: idArray.optional(),
      minimum_age_hours: windowHours.optional(),
      acknowledgement_window_hours: windowHours.optional(),
      message_filter: z.enum(["questions", "attachments", "all"]).default("all"),
      limit: intIn(1, 1000).optional(),
      include_excerpt: z.boolean().default(false),
    }),
    handle: async (a) => {
      const rc = reportContext(a.guild_id);
      if ("error" in rc) return rc.error;
      return structured(
        buildUnacknowledgedMessages(rc.ctx, {
          guildId: a.guild_id,
          startDate: a.start_date,
          endDate: a.end_date,
          channelIds: a.channel_ids,
          memberIds: a.member_ids,
          minimumAgeHours: a.minimum_age_hours,
          acknowledgementWindowHours: a.acknowledgement_window_hours,
          messageFilter: a.message_filter,
          limit: a.limit,
          includeExcerpt: a.include_excerpt,
        }),
      );
    },
  }),

  defineTool({
    name: "discord_get_training_cadence",
    description:
      "Weekly training/resource posting cadence per resource channel: which channel-weeks contain a probable training post (attachment, link, or keyword by a configured staff author) and which are missing. Local database only; no training content returned.",
    annotations: { title: "Training cadence", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField,
      start_date: isoDate,
      end_date: isoDate,
      resource_channel_ids: idArray.optional(),
      staff_user_ids: idArray.optional(),
      include_post_evidence: z.boolean().default(true),
    }),
    handle: async (a) => {
      const rc = reportContext(a.guild_id);
      if ("error" in rc) return rc.error;
      return structured(
        buildTrainingCadence(rc.ctx, {
          guildId: a.guild_id,
          startDate: a.start_date,
          endDate: a.end_date,
          resourceChannelIds: a.resource_channel_ids,
          staffUserIds: a.staff_user_ids,
          includePostEvidence: a.include_post_evidence,
        }),
      );
    },
  }),

  defineTool({
    name: "discord_get_office_hour_metrics",
    description:
      "Office-hour voice attendance over a date range: unique/first-time/repeat attendees, total and median durations, incomplete sessions, and day/channel/member breakdowns. First-time status reports history availability. Local database only.",
    annotations: { title: "Office-hour metrics", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField,
      start_date: isoDate,
      end_date: isoDate,
      voice_channel_ids: idArray.optional(),
      exclude_staff: z.boolean().default(true),
      include_incomplete_sessions: z.boolean().default(true),
      include_member_breakdown: z.boolean().default(true),
      include_daily_breakdown: z.boolean().default(true),
    }),
    handle: async (a) => {
      const rc = reportContext(a.guild_id);
      if ("error" in rc) return rc.error;
      return structured(
        buildOfficeHourMetrics(rc.ctx, {
          guildId: a.guild_id,
          startDate: a.start_date,
          endDate: a.end_date,
          voiceChannelIds: a.voice_channel_ids,
          excludeStaff: a.exclude_staff,
          includeIncompleteSessions: a.include_incomplete_sessions,
          includeMemberBreakdown: a.include_member_breakdown,
          includeDailyBreakdown: a.include_daily_breakdown,
        }),
      );
    },
  }),

  defineTool({
    name: "discord_generate_weekly_metrics",
    description:
      "One deterministic weekly report combining community activity, optional primary-user activity, response health, acknowledgement health, training cadence, and office hours, with previous-week comparisons and data-quality warnings. Defaults to the most recently completed week. Local database only; structured JSON, no prose or judgement.",
    annotations: { title: "Weekly metrics", readOnlyHint: true, openWorldHint: false },
    discordWrite: false,
    schema: z.object({
      guild_id: guildIdField,
      week_start_date: isoDate.optional(),
      compare_previous_week: z.boolean().default(true),
      resource_channel_ids: idArray.optional(),
      office_hour_channel_ids: idArray.optional(),
      exclude_staff_from_member_metrics: z.boolean().default(true),
    }),
    handle: async (a) => {
      const rc = reportContext(a.guild_id);
      if ("error" in rc) return rc.error;
      return structured(
        buildWeeklyMetrics(rc.ctx, {
          guildId: a.guild_id,
          weekStartDate: a.week_start_date,
          comparePreviousWeek: a.compare_previous_week,
          resourceChannelIds: a.resource_channel_ids,
          officeHourChannelIds: a.office_hour_channel_ids,
          excludeStaffFromMemberMetrics: a.exclude_staff_from_member_metrics,
          collectionActive: getAnalyticsRuntime().active,
        }),
      );
    },
  }),
];

export default defineModule(tools);
