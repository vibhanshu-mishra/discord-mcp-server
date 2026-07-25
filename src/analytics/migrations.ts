/**
 * Database schema, expressed as ordered, versioned migrations. Migrations run
 * inside `runMigrations` (see `database.ts`) before any collection begins; the
 * current schema version is tracked with SQLite's `PRAGMA user_version`, so
 * re-running is a no-op and adding a migration later is a matter of appending to
 * the array.
 *
 * Every Discord ID is stored as TEXT (snowflakes exceed JS safe-integer range),
 * every timestamp as an ISO-8601 UTC string, and every boolean as 0/1 INTEGER.
 */
import type { DatabaseSync } from "node:sqlite";

/** One schema step. `up` receives the open database and applies its DDL. */
export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/**
 * Ordered migrations. Never edit or reorder a released migration — append a new
 * one instead, so existing databases upgrade deterministically.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    up(db) {
      db.exec(`
        CREATE TABLE guilds (
          guild_id             TEXT PRIMARY KEY,
          name                 TEXT,
          first_seen_at        TEXT NOT NULL,
          last_seen_at         TEXT NOT NULL,
          last_history_sync_at TEXT
        );

        CREATE TABLE channels (
          channel_id        TEXT PRIMARY KEY,
          guild_id          TEXT NOT NULL,
          parent_channel_id TEXT,
          name              TEXT,
          type              INTEGER NOT NULL,
          is_thread         INTEGER NOT NULL DEFAULT 0,
          is_archived       INTEGER NOT NULL DEFAULT 0,
          first_seen_at     TEXT NOT NULL,
          last_seen_at      TEXT NOT NULL
        );
        CREATE INDEX idx_channels_guild ON channels (guild_id);

        CREATE TABLE members (
          user_id       TEXT NOT NULL,
          guild_id      TEXT NOT NULL,
          username      TEXT,
          display_name  TEXT,
          is_bot        INTEGER NOT NULL DEFAULT 0,
          first_seen_at TEXT NOT NULL,
          last_seen_at  TEXT NOT NULL,
          PRIMARY KEY (guild_id, user_id)
        );
        CREATE INDEX idx_members_guild ON members (guild_id);

        CREATE TABLE messages (
          message_id            TEXT PRIMARY KEY,
          guild_id              TEXT,
          channel_id            TEXT NOT NULL,
          parent_channel_id     TEXT,
          author_id             TEXT,
          content               TEXT,
          content_hash          TEXT,
          created_at            TEXT NOT NULL,
          edited_at             TEXT,
          referenced_message_id TEXT,
          is_reply              INTEGER NOT NULL DEFAULT 0,
          is_pinned             INTEGER NOT NULL DEFAULT 0,
          author_is_bot         INTEGER NOT NULL DEFAULT 0,
          message_type          INTEGER,
          is_deleted            INTEGER NOT NULL DEFAULT 0,
          deleted_observed_at   TEXT,
          attachment_count      INTEGER NOT NULL DEFAULT 0,
          reaction_count        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_messages_guild        ON messages (guild_id);
        CREATE INDEX idx_messages_channel      ON messages (channel_id);
        CREATE INDEX idx_messages_author       ON messages (author_id);
        CREATE INDEX idx_messages_created      ON messages (created_at);
        CREATE INDEX idx_messages_referenced   ON messages (referenced_message_id);
        CREATE INDEX idx_messages_deleted      ON messages (is_deleted);

        CREATE TABLE attachments (
          attachment_id TEXT PRIMARY KEY,
          message_id    TEXT NOT NULL,
          filename      TEXT,
          content_type  TEXT,
          size          INTEGER,
          url           TEXT,
          proxy_url     TEXT,
          width         INTEGER,
          height        INTEGER
        );
        CREATE INDEX idx_attachments_message ON attachments (message_id);

        CREATE TABLE reactions (
          message_id     TEXT NOT NULL,
          emoji_id       TEXT,
          emoji_name     TEXT,
          user_id        TEXT,
          reactor_is_bot INTEGER NOT NULL DEFAULT 0,
          observed_at    TEXT NOT NULL
        );
        CREATE INDEX idx_reactions_message ON reactions (message_id);
        -- Uniqueness rule: one row per (message, emoji, user). COALESCE keeps the
        -- rule working when the API omits the emoji ID (unicode) or the user ID,
        -- because SQLite otherwise treats each NULL as distinct.
        CREATE UNIQUE INDEX idx_reactions_unique ON reactions (
          message_id,
          COALESCE(emoji_id, emoji_name, ''),
          COALESCE(user_id, '')
        );

        CREATE TABLE voice_sessions (
          session_id       TEXT PRIMARY KEY,
          guild_id         TEXT NOT NULL,
          channel_id       TEXT NOT NULL,
          user_id          TEXT NOT NULL,
          user_is_bot      INTEGER NOT NULL DEFAULT 0,
          joined_at        TEXT NOT NULL,
          left_at          TEXT,
          duration_seconds INTEGER,
          is_open          INTEGER NOT NULL DEFAULT 1,
          is_incomplete    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_voice_open         ON voice_sessions (is_open);
        CREATE INDEX idx_voice_user         ON voice_sessions (user_id);
        CREATE INDEX idx_voice_channel_date ON voice_sessions (channel_id, joined_at);
        CREATE UNIQUE INDEX idx_voice_one_open_per_user
          ON voice_sessions (guild_id, user_id) WHERE is_open = 1;

        CREATE TABLE sync_runs (
          run_id                 TEXT PRIMARY KEY,
          guild_id               TEXT NOT NULL,
          channel_id             TEXT,
          requested_start_date   TEXT,
          requested_max_messages INTEGER,
          started_at             TEXT NOT NULL,
          completed_at           TEXT,
          status                 TEXT NOT NULL,
          messages_imported      INTEGER NOT NULL DEFAULT 0,
          oldest_message_reached TEXT,
          error_summary          TEXT
        );
        CREATE INDEX idx_sync_runs_guild   ON sync_runs (guild_id);
        CREATE INDEX idx_sync_runs_channel ON sync_runs (channel_id);
        CREATE INDEX idx_sync_runs_status  ON sync_runs (status);
        CREATE INDEX idx_sync_runs_date    ON sync_runs (started_at);
      `);
    },
  },
  {
    version: 2,
    name: "qualitative-analysis-indexes",
    up(db) {
      // Phase 4's qualitative queries scan messages by guild + channel(s) within a
      // date range (topics, feedback, per-channel packets). The v1 single-column
      // indexes (channel_id, created_at) cannot serve that as one covering range
      // scan, so a composite index is added. It is additive only — no data is
      // touched and existing rows are preserved.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_guild_channel_created
          ON messages (guild_id, channel_id, created_at);
        -- Thread context retrieval looks up threads by their parent channel.
        CREATE INDEX IF NOT EXISTS idx_channels_parent
          ON channels (parent_channel_id);
      `);
    },
  },
];
