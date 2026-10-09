import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { createLogger, redact } from "../src/operations/logger.js";

afterEach(() => {
  delete process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_MCP_LOG_LEVEL;
});

// 12 (logging). Redaction removes token, home dir, and URL query strings.
test("redact removes token, home directory, and URL query strings", () => {
  process.env.DISCORD_TOKEN = "SECRET.BOT.TOKEN.1234567890";
  const home = homedir();
  const input = `token=SECRET.BOT.TOKEN.1234567890 path=${home}/x link=https://cdn.example.com/a/b?ex=abc&hm=SIGNED#frag`;
  const out = redact(input);
  assert.ok(!out.includes("SECRET.BOT.TOKEN.1234567890"), "token removed");
  assert.ok(!out.includes(home), "home directory collapsed");
  assert.ok(!out.includes("SIGNED"), "signed URL query removed");

  const linkPart = out.split("link=")[1]?.split(/\s+/)[0];
  assert.ok(linkPart, "redacted output contains link");
  const parsed = new URL(linkPart!);
  assert.equal(parsed.origin, "https://cdn.example.com", "URL origin preserved");
  assert.equal(parsed.pathname, "/a/b", "URL path preserved");
  assert.equal(parsed.search, "", "URL query removed");
});

// Logger respects the configured level and routes through redaction.
test("logger respects level and redacts output", () => {
  process.env.DISCORD_TOKEN = "TOK-EN-VALUE-000000";
  process.env.DISCORD_MCP_LOG_LEVEL = "warning";
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  log.info("this info should be suppressed at warning level");
  log.warning("visible with TOK-EN-VALUE-000000 inside");
  assert.equal(lines.length, 1, "info suppressed at warning level");
  assert.ok(!lines[0].includes("TOK-EN-VALUE-000000"), "token redacted in output");
  assert.match(lines[0], /^WARNING/);
});

test("json logger emits valid JSON lines", () => {
  const lines: string[] = [];
  const log = createLogger({ json: true, sink: (l) => lines.push(l) });
  log.error("something failed");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, "error");
  assert.equal(parsed.message, "something failed");
});
