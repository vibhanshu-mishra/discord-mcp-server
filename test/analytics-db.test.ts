import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, runMigrations } from "../src/analytics/database.js";
import { contentHash } from "../src/analytics/repository.js";
import { makeRepo, IDS, fakeSourceMessage } from "./analytics-helpers.js";

// 9. Database migrations run successfully.
test("migrations create the expected tables and are idempotent", () => {
  const db = openDatabase(":memory:");
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((r) => r.name);
  for (const t of [
    "guilds",
    "channels",
    "members",
    "messages",
    "attachments",
    "reactions",
    "voice_sessions",
    "sync_runs",
  ]) {
    assert.ok(tables.includes(t), `table ${t} should exist`);
  }
  // Running again is a no-op (version already applied).
  const version = runMigrations(db);
  assert.ok(version >= 1);
});

// 10. Message upserts do not create duplicates.
test("upserting the same message twice keeps one row and updates it", () => {
  const repo = makeRepo();
  const base = {
    message_id: "800000000000000001",
    guild_id: IDS.guild,
    channel_id: IDS.channelA,
    author_id: IDS.user,
    content: "first",
    created_at: "2024-06-01T00:00:00.000Z",
  };
  repo.upsertMessage(base);
  repo.upsertMessage({ ...base, content: "edited", edited_at: "2024-06-01T01:00:00.000Z" });
  const counts = repo.getMessageCounts({ guildId: IDS.guild }, "guild");
  assert.equal(counts[0].count, 1, "exactly one message row");
  assert.equal(repo.getMessage(base.message_id)?.content, "edited");
});

// 25/26. When content storage is disabled, only a one-way hash is kept.
test("content storage OFF stores a hash but no readable content", () => {
  const repo = makeRepo(false);
  repo.upsertMessage({
    message_id: "800000000000000002",
    guild_id: IDS.guild,
    channel_id: IDS.channelA,
    author_id: IDS.user,
    content: "secret community message",
    created_at: "2024-06-01T00:00:00.000Z",
  });
  const row = repo.getMessage("800000000000000002")!;
  assert.equal(row.content, null, "readable content must not be stored");
  assert.equal(row.content_hash, contentHash("secret community message"));
  // The hash is one-way: it is not the plaintext and cannot be decoded back.
  assert.notEqual(row.content_hash, "secret community message");
});

test("content storage ON keeps readable content and a matching hash", () => {
  const repo = makeRepo(true);
  repo.upsertMessage({
    message_id: "800000000000000003",
    guild_id: IDS.guild,
    channel_id: IDS.channelA,
    author_id: IDS.user,
    content: "visible",
    created_at: "2024-06-01T00:00:00.000Z",
  });
  const row = repo.getMessage("800000000000000003")!;
  assert.equal(row.content, "visible");
  assert.equal(row.content_hash, contentHash("visible"));
});

// 17/18. Reactions are stored once; removal deletes the matching row.
test("reactions dedupe on (message, emoji, user) and remove correctly", () => {
  const repo = makeRepo();
  const r = {
    message_id: "800000000000000004",
    emoji_id: null,
    emoji_name: "👍",
    user_id: IDS.user,
  };
  repo.insertReaction(r);
  repo.insertReaction(r); // duplicate — ignored by the unique index
  let count = (
    repo as unknown as { db: { prepare: (s: string) => { get: () => { c: number } } } }
  ).db
    .prepare("SELECT COUNT(*) c FROM reactions")
    .get().c;
  assert.equal(count, 1, "duplicate reaction must not create a second row");

  const removed = repo.removeReaction(r.message_id, { name: "👍" }, IDS.user);
  assert.equal(removed, 1);
  count = (repo as unknown as { db: { prepare: (s: string) => { get: () => { c: number } } } }).db
    .prepare("SELECT COUNT(*) c FROM reactions")
    .get().c;
  assert.equal(count, 0);
});

// 24. Bot accounts are identified correctly at the storage layer.
test("author bot flag is stored", () => {
  const repo = makeRepo();
  const m = fakeSourceMessage({ id: "800000000000000005", authorId: IDS.bot, authorIsBot: true });
  repo.upsertMessage({
    message_id: m.id,
    guild_id: IDS.guild,
    channel_id: IDS.channelA,
    author_id: m.authorId,
    content: m.content,
    created_at: m.createdAt,
    author_is_bot: m.authorIsBot,
  });
  assert.equal(repo.getMessage(m.id)?.author_is_bot, 1);
});
