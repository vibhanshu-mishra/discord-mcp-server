import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, runMigrations } from "../src/analytics/database.js";
import { AnalyticsRepository } from "../src/analytics/repository.js";
import { Q } from "./qualitative-helpers.js";

// The v2 migration adds indexes only; it must run, be idempotent, and preserve data.
test("migration v2 adds the qualitative indexes and is idempotent", () => {
  const db = openDatabase(":memory:");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  assert.ok(version >= 2, "schema is at v2 or later");

  const indexes = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
  ).map((r) => r.name);
  assert.ok(
    indexes.includes("idx_messages_guild_channel_created"),
    "composite message index exists",
  );
  assert.ok(indexes.includes("idx_channels_parent"), "channels-by-parent index exists");

  // Re-running migrations is a no-op and does not error.
  assert.equal(runMigrations(db), version);
});

test("migration preserves existing rows", () => {
  const db = openDatabase(":memory:");
  const repo = new AnalyticsRepository(db, true);
  repo.upsertGuild(Q.guild, "G");
  repo.upsertMessage({
    message_id: "770000000000000001",
    guild_id: Q.guild,
    channel_id: Q.channel,
    author_id: Q.member1,
    content: "hello",
    created_at: "2024-06-01T00:00:00.000Z",
  });
  // Running migrations again must not disturb stored data.
  runMigrations(db);
  const row = repo.getMessage("770000000000000001");
  assert.equal(row?.content, "hello");
});
