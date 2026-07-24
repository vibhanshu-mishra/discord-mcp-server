import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Events, type Client } from "discord.js";
import { LiveCollector } from "../src/analytics/collector.js";
import { handleVoiceStateChange, recoverOpenSessions } from "../src/analytics/voice.js";
import type { VoiceStateLike } from "../src/analytics/voice.js";
import { makeRepo, makeConfig, IDS } from "./analytics-helpers.js";

afterEach(() => {
  delete process.env.DISCORD_ALLOWED_GUILDS;
  mock.restoreAll();
});

/** Records any Discord-write attempts so tests can prove none happen. */
function writeSpies() {
  const calls: string[] = [];
  const trap = (name: string) => () => {
    calls.push(name);
    throw new Error(`Discord write "${name}" must never be called by the collector`);
  };
  return {
    calls,
    reply: trap("reply"),
    react: trap("react"),
    delete: trap("delete"),
    edit: trap("edit"),
    pin: trap("pin"),
  };
}

/** Builds a fake guild message. `content` defaults to an obvious secret marker. */
function fakeMessage(over: Record<string, unknown> = {}) {
  const spies = writeSpies();
  return {
    id: "820000000000000001",
    guildId: IDS.guild,
    channelId: IDS.channelA,
    createdAt: new Date("2024-06-01T00:00:00.000Z"),
    editedAt: null,
    author: { id: IDS.user, username: "alice", globalName: "Alice", bot: false },
    member: { displayName: "Alice" },
    content: "PLAINTEXT-SECRET",
    reference: null,
    pinned: false,
    type: 0,
    attachments: new Map(),
    reactions: { cache: new Map() },
    guild: { name: "Test Guild" },
    channel: { type: 0, name: "general", isThread: () => false, parentId: null },
    ...spies,
    ...over,
  };
}

function startCollector(repo = makeRepo(), config = makeConfig()) {
  const emitter = new EventEmitter();
  const collector = new LiveCollector(emitter as unknown as Client, repo, config);
  collector.start();
  return { emitter, collector, repo };
}

// 15. Message edits update the existing record.
test("MessageUpdate updates the stored message in place", () => {
  const { emitter, repo } = startCollector();
  const msg = fakeMessage({ content: "first" });
  emitter.emit(Events.MessageCreate, msg);
  emitter.emit(
    Events.MessageUpdate,
    fakeMessage({ content: "first" }),
    fakeMessage({
      content: "second",
      editedAt: new Date("2024-06-01T01:00:00.000Z"),
    }),
  );
  assert.equal(repo.getMessage(msg.id)?.content, "second");
  assert.equal(repo.getMessageCounts({ guildId: IDS.guild }, "guild")[0].count, 1);
});

// 16. Message deletions mark the existing record as deleted.
test("MessageDelete flags the stored message deleted", () => {
  const { emitter, repo } = startCollector();
  const msg = fakeMessage();
  emitter.emit(Events.MessageCreate, msg);
  emitter.emit(Events.MessageDelete, { id: msg.id, guildId: IDS.guild, channelId: IDS.channelA });
  assert.equal(repo.getMessage(msg.id)?.is_deleted, 1);
  assert.ok(repo.getMessage(msg.id)?.deleted_observed_at, "records when deletion was observed");
});

// 17/18. Reaction add stores one row; remove deletes it.
test("MessageReactionAdd then Remove stores then removes one row", () => {
  const { emitter, repo } = startCollector();
  const reaction = {
    message: { id: "820000000000000009", guildId: IDS.guild },
    emoji: { id: null, name: "🎉" },
  };
  emitter.emit(Events.MessageReactionAdd, reaction, { id: IDS.user, bot: false });
  emitter.emit(Events.MessageReactionAdd, reaction, { id: IDS.user, bot: false }); // duplicate
  const rowCount = () =>
    (repo as unknown as { db: { prepare: (s: string) => { get: () => { c: number } } } }).db
      .prepare("SELECT COUNT(*) c FROM reactions")
      .get().c;
  assert.equal(rowCount(), 1, "duplicate reaction ignored");
  emitter.emit(Events.MessageReactionRemove, reaction, { id: IDS.user, bot: false });
  assert.equal(rowCount(), 0);
});

// 28. Live collection never calls a Discord write method.
test("collector never invokes Discord write methods", () => {
  const { emitter } = startCollector();
  const msg = fakeMessage();
  emitter.emit(Events.MessageCreate, msg);
  emitter.emit(Events.MessageUpdate, msg, fakeMessage({ content: "x" }));
  assert.deepEqual(
    (msg as unknown as { calls: string[] }).calls,
    [],
    "no reply/react/edit/delete/pin",
  );
});

// Unauthorised guilds are ignored.
test("collector ignores messages from unauthorised guilds", () => {
  const { emitter, repo } = startCollector();
  emitter.emit(Events.MessageCreate, fakeMessage({ guildId: IDS.otherGuild }));
  assert.equal(repo.getMessageCounts({}, "guild").length, 0);
});

// Bot DMs ignored unless explicitly enabled.
test("bot DMs are ignored unless collect-bot-DMs is enabled", () => {
  const off = startCollector(makeRepo(), makeConfig({ collectBotDms: false }));
  off.emitter.emit(Events.MessageCreate, fakeMessage({ guildId: null, guild: null }));
  assert.equal(off.repo.getMessageCounts({}, "guild").length, 0, "DM dropped when disabled");

  const on = startCollector(makeRepo(), makeConfig({ collectBotDms: true }));
  on.emitter.emit(
    Events.MessageCreate,
    fakeMessage({ id: "820000000000000050", guildId: null, guild: null }),
  );
  const stored = on.repo.getMessage("820000000000000050");
  assert.ok(stored, "DM stored when enabled");
  assert.equal(stored?.guild_id, null, "a DM is never recorded as a guild message");
});

// 26. No full message content appears in logs, even when a handler throws.
test("a handler error never logs message content", () => {
  const logged: string[] = [];
  mock.method(console, "error", (...args: unknown[]) => logged.push(args.join(" ")));
  const { emitter } = startCollector();
  // A message whose attachment access throws forces the handler into its catch.
  const boom = fakeMessage({
    content: "PLAINTEXT-SECRET",
    attachments: {
      get size() {
        return 1;
      },
      values() {
        throw new Error("boom");
      },
    },
  });
  emitter.emit(Events.MessageCreate, boom);
  const all = logged.join("\n");
  assert.ok(all.includes("MessageCreate"), "the event name is logged");
  assert.ok(!all.includes("PLAINTEXT-SECRET"), "message content must never be logged");
});

// ─── Voice attendance (pure logic + repository) ────────────────────────────

const authorised = () => true;
const state = (channelId: string | null, isBot = false): VoiceStateLike => ({
  guildId: IDS.guild,
  channelId,
  userId: isBot ? IDS.bot : IDS.user,
  isBot,
});

// 19. Voice joins create open sessions.
test("joining a voice channel opens a session", () => {
  const repo = makeRepo();
  handleVoiceStateChange(repo, state(null), state(IDS.voiceChannel), {
    isAuthorised: authorised,
    collectVoice: true,
  });
  const open = repo.findOpenVoiceSession(IDS.guild, IDS.user);
  assert.ok(open, "an open session exists");
  assert.equal(open?.channel_id, IDS.voiceChannel);
  assert.equal(open?.is_open, 1);
});

// 20. Voice leaves close sessions and calculate duration.
test("leaving closes the session and computes duration", () => {
  const repo = makeRepo();
  handleVoiceStateChange(repo, state(null), state(IDS.voiceChannel), {
    isAuthorised: authorised,
    collectVoice: true,
    at: "2024-06-01T00:00:00.000Z",
  });
  handleVoiceStateChange(repo, state(IDS.voiceChannel), state(null), {
    isAuthorised: authorised,
    collectVoice: true,
    at: "2024-06-01T00:05:00.000Z",
  });
  assert.equal(repo.findOpenVoiceSession(IDS.guild, IDS.user), undefined, "no longer open");
  const [session] = repo.getVoiceSessions({ guildId: IDS.guild });
  assert.equal(session.duration_seconds, 300, "five minutes = 300 seconds");
  assert.equal(session.is_open, 0);
});

// 21. Moving voice channels closes one session and opens another.
test("moving channels closes the old session and opens a new one", () => {
  const repo = makeRepo();
  handleVoiceStateChange(repo, state(null), state(IDS.voiceChannel), {
    isAuthorised: authorised,
    collectVoice: true,
  });
  handleVoiceStateChange(repo, state(IDS.voiceChannel), state(IDS.voiceChannel2), {
    isAuthorised: authorised,
    collectVoice: true,
  });
  const open = repo.findOpenVoiceSession(IDS.guild, IDS.user);
  assert.equal(open?.channel_id, IDS.voiceChannel2, "now in the second channel");
  const all = repo.getVoiceSessions({ guildId: IDS.guild });
  assert.equal(all.length, 2, "one closed + one open");
  assert.equal(all.filter((s) => s.is_open === 1).length, 1, "exactly one open");
});

// 22. Duplicate voice events do not create duplicate open sessions.
test("a duplicate join does not open a second session", () => {
  const repo = makeRepo();
  handleVoiceStateChange(repo, state(null), state(IDS.voiceChannel), {
    isAuthorised: authorised,
    collectVoice: true,
  });
  handleVoiceStateChange(repo, state(null), state(IDS.voiceChannel), {
    isAuthorised: authorised,
    collectVoice: true,
  });
  const open = repo.getVoiceSessions({ guildId: IDS.guild }).filter((s) => s.is_open === 1);
  assert.equal(open.length, 1, "still exactly one open session");
});

// 23. Process-restart recovery marks old open sessions incomplete (no invented leave time).
test("restart recovery flags open sessions incomplete without inventing a leave time", () => {
  const repo = makeRepo();
  handleVoiceStateChange(repo, state(null), state(IDS.voiceChannel), {
    isAuthorised: authorised,
    collectVoice: true,
  });
  const fixed = recoverOpenSessions(repo);
  assert.equal(fixed, 1);
  const [session] = repo.getVoiceSessions({ guildId: IDS.guild });
  assert.equal(session.is_open, 0);
  assert.equal(session.is_incomplete, 1);
  assert.equal(session.left_at, null, "leave time is unknown, not fabricated");
  assert.equal(session.duration_seconds, null, "duration is unknown, not fabricated");
});

// 24. Bot accounts are identified correctly in voice sessions.
test("voice sessions record whether the member is a bot", () => {
  const repo = makeRepo();
  handleVoiceStateChange(repo, state(null, true), state(IDS.voiceChannel, true), {
    isAuthorised: authorised,
    collectVoice: true,
  });
  const [session] = repo.getVoiceSessions({ guildId: IDS.guild });
  assert.equal(session.user_is_bot, 1);
});

// Voice collection can be switched off.
test("voice changes are ignored when collectVoice is false", () => {
  const repo = makeRepo();
  handleVoiceStateChange(repo, state(null), state(IDS.voiceChannel), {
    isAuthorised: authorised,
    collectVoice: false,
  });
  assert.equal(repo.getVoiceSessions({ guildId: IDS.guild }).length, 0);
});
