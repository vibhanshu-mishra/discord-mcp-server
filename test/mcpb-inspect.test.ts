import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The inspector is a plain ESM script; import its pure check functions.
import { checkDir, checkRequired } from "../scripts/mcpb-inspect.mjs";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** Creates a minimal valid staged bundle directory. */
function goodStaging(): string {
  const d = mkdtempSync(join(tmpdir(), "mcpb-good-"));
  mkdirSync(join(d, "server"), { recursive: true });
  writeFileSync(join(d, "server", "index.js"), "// compiled entry\n");
  mkdirSync(join(d, "node_modules", "@modelcontextprotocol", "sdk"), { recursive: true });
  writeFileSync(join(d, "node_modules", "@modelcontextprotocol", "sdk", "index.js"), "");
  writeFileSync(join(d, "LICENSE"), "MIT");
  writeFileSync(join(d, "README.md"), "# bundle");
  writeFileSync(
    join(d, "package.json"),
    JSON.stringify({ name: "discord-mcp-server", version: "2.1.0" }),
  );
  writeFileSync(
    join(d, "manifest.json"),
    JSON.stringify({ name: "discord-mcp-server", version: "2.1.0" }),
  );
  return d;
}

// 40 (positive). A clean bundle passes inspection.
test("a clean staged bundle passes inspection", () => {
  dir = goodStaging();
  assert.deepEqual(checkRequired(dir), []);
  assert.deepEqual(checkDir(dir), []);
});

// 29/31/32/27. Forbidden content is detected.
test("forbidden content is detected", () => {
  dir = goodStaging();
  writeFileSync(join(dir, ".env"), "DISCORD_TOKEN=secret"); // 29
  writeFileSync(join(dir, "server", "data.sqlite"), "x"); // 31
  mkdirSync(join(dir, "backups"), { recursive: true });
  writeFileSync(join(dir, "backups", "b.sqlite"), "x"); // 32
  writeFileSync(join(dir, "server", "thing.test.js"), "test"); // 27
  writeFileSync(join(dir, "server", "src.ts"), "export {}"); // 28 TypeScript source
  writeFileSync(join(dir, "a.lock"), "lock");
  const problems = checkDir(dir).join(" | ");
  assert.match(problems, /env file/);
  assert.match(problems, /database file/);
  assert.match(problems, /test file/);
  assert.match(problems, /TypeScript source/);
  assert.match(problems, /lock file/);
});

// 36/37. Absolute developer paths and tokens are detected in text files.
test("absolute paths and hard-coded tokens are detected", () => {
  dir = goodStaging();
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      x: "/Users/someone/dev/thing",
      server: { mcp_config: { env: { DISCORD_TOKEN: "abc" } } },
    }),
  );
  const problems = checkDir(dir).join(" | ");
  assert.match(problems, /absolute developer path/); // 36
  assert.match(problems, /hard-coded token/); // 37
});

// 38. A real-looking Discord ID in the manifest is detected.
test("a real-looking Discord ID in the manifest is detected", () => {
  dir = goodStaging();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ guild: "123456789012345678" }));
  assert.match(checkDir(dir).join(" | "), /real-looking Discord ID/);
});

// 3 (required). Version mismatch is detected.
test("a manifest/package version mismatch is detected", () => {
  dir = goodStaging();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "9.9.9" }));
  assert.match(checkRequired(dir).join(" | "), /version .* != .* version/);
});

// Missing required files are detected.
test("missing required files are detected", () => {
  dir = mkdtempSync(join(tmpdir(), "mcpb-empty-"));
  const problems = checkRequired(dir).join(" | ");
  assert.match(problems, /missing manifest/);
  assert.match(problems, /missing server entry point/);
  assert.match(problems, /missing LICENSE/);
});
