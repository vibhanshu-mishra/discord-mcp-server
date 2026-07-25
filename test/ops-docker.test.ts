import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

// 77. Docker build context excludes .env, databases, backups, exports, logs.
test(".dockerignore excludes secrets, databases, backups, exports, and logs", () => {
  const ig = read(".dockerignore");
  for (const entry of [
    ".env",
    "data",
    "backups",
    "exports",
    "logs",
    "*.db",
    "*.sqlite",
    "test",
    "node_modules",
  ]) {
    assert.ok(ig.split(/\r?\n/).includes(entry), `.dockerignore must list ${entry}`);
  }
});

// 78/79/82. Non-root user, no token, health-check present.
test("Dockerfile runs as non-root, has a health check, and embeds no token", () => {
  const df = read("Dockerfile");
  assert.match(df, /USER nodejs/, "runs as a non-root user"); // 78
  assert.match(df, /HEALTHCHECK/, "has a health check"); // 82
  assert.match(
    df,
    /dist\/cli\/index\.js", "doctor"|dist\/cli\/index\.js doctor/,
    "health check uses the offline doctor",
  );
  assert.ok(!/DISCORD_TOKEN\s*=/.test(df), "no token embedded"); // 79
  assert.match(df, /VOLUME \["\/app\/data"\]/, "provides a data volume");
  assert.match(df, /--omit=dev/, "installs production dependencies only");
});

// 79/80/81. Compose: no token, persistent volume, no exposed port.
test("compose example uses a persistent volume, no port, and no token", () => {
  const compose = read("docker-compose.example.yml");
  assert.match(compose, /volumes:/, "declares volumes");
  assert.match(compose, /discord-analytics-data:\/app\/data/, "mounts a persistent data volume"); // 80
  assert.ok(!/^\s*ports:/m.test(compose), "no port is exposed"); // 81
  assert.ok(!/DISCORD_TOKEN:\s*["']?[A-Za-z0-9.]/.test(compose), "no literal token value"); // 79
  assert.match(compose, /restart:\s*unless-stopped/);
  assert.match(compose, /one\s+.*collector per database/i, "documents one writer per database");
});
