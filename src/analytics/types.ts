/**
 * Shared TypeScript types for the local analytics subsystem. These mirror the
 * SQLite schema in `migrations.ts` (all Discord IDs are strings/snowflakes, all
 * timestamps are ISO-8601 UTC strings) and the validated configuration shape.
 *
 * Nothing here touches Discord: these are the shapes of the LOCAL records the
 * collector and history sync write, and the analytics tools read back.
 */

/** Validated analytics configuration, derived from environment variables. */
export interface AnalyticsConfig {
  /** Master switch. When false the subsystem never opens a DB or subscribes. */
  enabled: boolean;
  /** Filesystem path to the SQLite database file. */
  dbPath: string;
  /** Guild IDs analytics may collect from (already intersected with the allow-list). */
  guildIds: string[];
  /** Default lower bound for history imports (YYYY-MM-DD) or null when unset. */
  historyStartDate: string | null;
  /** Messages fetched per Discord API page (1–100, Discord's hard cap). */
  syncPageLimit: number;
  /** Record voice-channel joins/leaves while the bot is online. */
  collectVoice: boolean;
  /** Store DMs sent directly to the bot (never guild content). */
  collectBotDms: boolean;
  /** Store readable message text locally (vs. metadata + one-way hash only). */
  storeMessageContent: boolean;
}

/** Result of validating the analytics environment without throwing. */
export interface AnalyticsConfigValidation {
  config: AnalyticsConfig;
  /** Human-readable, secret-free problems found while parsing the environment. */
  errors: string[];
}

export interface GuildRow {
  guild_id: string;
  name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_history_sync_at: string | null;
}

export interface ChannelRow {
  channel_id: string;
  guild_id: string;
  parent_channel_id: string | null;
  name: string | null;
  type: number;
  is_thread: number;
  is_archived: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface MemberRow {
  user_id: string;
  guild_id: string;
  username: string | null;
  display_name: string | null;
  is_bot: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface MessageRow {
  message_id: string;
  guild_id: string | null;
  channel_id: string;
  parent_channel_id: string | null;
  author_id: string | null;
  content: string | null;
  content_hash: string | null;
  created_at: string;
  edited_at: string | null;
  referenced_message_id: string | null;
  is_reply: number;
  is_pinned: number;
  author_is_bot: number;
  message_type: number | null;
  is_deleted: number;
  deleted_observed_at: string | null;
  attachment_count: number;
  reaction_count: number;
}

export interface AttachmentRow {
  attachment_id: string;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  size: number | null;
  url: string | null;
  proxy_url: string | null;
  width: number | null;
  height: number | null;
}

export interface ReactionRow {
  message_id: string;
  emoji_id: string | null;
  emoji_name: string | null;
  user_id: string | null;
  reactor_is_bot: number;
  observed_at: string;
}

export interface VoiceSessionRow {
  session_id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  user_is_bot: number;
  joined_at: string;
  left_at: string | null;
  duration_seconds: number | null;
  is_open: number;
  is_incomplete: number;
}

export type SyncRunStatus = "running" | "completed" | "failed" | "skipped";

export interface SyncRunRow {
  run_id: string;
  guild_id: string;
  channel_id: string | null;
  requested_start_date: string | null;
  requested_max_messages: number | null;
  started_at: string;
  completed_at: string | null;
  status: SyncRunStatus;
  messages_imported: number;
  oldest_message_reached: string | null;
  error_summary: string | null;
}
