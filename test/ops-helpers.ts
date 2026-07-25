/**
 * Shared fixtures for Phase 5 operations/CLI tests. Everything uses temporary
 * directories and temporary SQLite databases with invented IDs and messages —
 * no real token, network, server, or persistent database is involved.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openDatabase, closeDatabase } from "../src/analytics/database.js";
import { AnalyticsRepository } from "../src/analytics/repository.js";

export const OPS = {
  guild: "111111111111111111",
  otherGuild: "999999999999999999",
  channel: "222222222222222222",
  member: "333333333333333333",
  staff: "444444444444444444",
};

/** A marker string used to prove content never leaks into output or logs. */
export const SECRET_CONTENT = "PRIVATE-SEEDED-BODY";
export const FAKE_TOKEN = "FAKE.TOKEN.VALUE.SHOULD.NOT.APPEAR.1234567890";

const CLI_ENTRY = resolve(fileURLToPath(import.meta.url), "../../src/cli/index.ts");

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "dmcp-ops-"));
}
export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Creates and seeds a temporary database; returns its path. */
export function seedTempDb(
  dir: string,
  opts: { storeContent?: boolean; withOpenVoice?: boolean } = {},
): string {
  const dbPath = join(dir, "analytics.sqlite");
  const db = openDatabase(dbPath);
  const repo = new AnalyticsRepository(db, opts.storeContent ?? true);
  repo.upsertGuild(OPS.guild, "Test Guild");
  repo.upsertChannel({ channel_id: OPS.channel, guild_id: OPS.guild, name: "general", type: 0 });
  repo.upsertMember({
    user_id: OPS.member,
    guild_id: OPS.guild,
    username: "member-one",
    display_name: "Member One",
  });
  // One old message (2024) and one recent (2025), to exercise prune cutoffs.
  repo.upsertMessage({
    message_id: "900000000000000001",
    guild_id: OPS.guild,
    channel_id: OPS.channel,
    author_id: OPS.member,
    content: `${SECRET_CONTENT} deploy failed`,
    created_at: "2024-06-01T10:00:00.000Z",
    attachment_count: 0,
  });
  repo.upsertMessage({
    message_id: "900000000000000002",
    guild_id: OPS.guild,
    channel_id: OPS.channel,
    author_id: OPS.member,
    content: "deploy failed again",
    created_at: "2025-01-02T10:00:00.000Z",
  });
  repo.upsertAttachment({
    attachment_id: "a1",
    message_id: "900000000000000001",
    filename: "f.txt",
    content_type: "text/plain",
    size: 10,
    url: null,
    proxy_url: null,
    width: null,
    height: null,
  });
  repo.insertReaction({
    message_id: "900000000000000001",
    emoji_name: "star",
    user_id: OPS.member,
  });
  repo.upsertMessage({
    message_id: "900000000000000003",
    guild_id: OPS.guild,
    channel_id: OPS.channel,
    author_id: OPS.member,
    content: "how do I reset my password?",
    created_at: "2025-01-03T10:00:00.000Z",
  });
  if (opts.withOpenVoice) {
    repo.openVoiceSession({
      guild_id: OPS.guild,
      channel_id: OPS.channel,
      user_id: OPS.member,
      joined_at: "2024-05-01T10:00:00.000Z",
    });
  }
  closeDatabase(db);
  return dbPath;
}

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in a child process (offline). Returns exit code and output. */
export function runCli(args: string[], env: Record<string, string> = {}, cwd?: string): CliResult {
  const res = spawnSync("node", ["--import", "tsx", CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DISCORD_TOKEN: FAKE_TOKEN, ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
