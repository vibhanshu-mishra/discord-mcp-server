import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");

// 51. README contains MCPB installation instructions.
test("README documents one-click MCPB installation", () => {
  assert.match(readme, /Install Extension/);
  assert.match(readme, /\.mcpb/);
  assert.match(readme, /Settings\s*→\s*Extensions/);
  assert.match(readme, /Advanced settings/);
});

// 52. README contains current limitations.
test("README documents limitations", () => {
  assert.match(readme, /## Limitations/);
  assert.match(readme, /Voice attendance is prospective only/i);
  assert.match(readme, /no auto-updater|auto-updater/i);
});

// 53. README contains a safety/privacy explanation.
test("README documents safety and privacy", () => {
  assert.match(readme, /## Safety and privacy/);
  assert.match(readme, /Content output is disabled by default/i);
  assert.match(readme, /Personal user-to-user Discord DMs cannot be accessed/i);
  assert.match(readme, /no platform sandbox/i);
  assert.match(readme, /One writer per database/i);
});

// 54. README contains example Claude requests.
test("README contains example Claude requests", () => {
  assert.match(readme, /Sync Discord activity since last Monday/);
  assert.match(readme, /weekly metrics report/i);
});

// 55. Desktop-extension guide exists.
test("the desktop-extension guide exists and covers key topics", () => {
  const guidePath = resolve(ROOT, "docs/desktop-extension.md");
  assert.ok(existsSync(guidePath));
  const guide = readFileSync(guidePath, "utf8");
  for (const topic of [
    /Building the bundle/i,
    /Inspecting the bundle/i,
    /Installing it/i,
    /Upgrading/i,
    /Uninstalling/i,
    /logs/i,
    /Troubleshooting/i,
    /GitHub Release/i,
    /SHA-256/i,
  ]) {
    assert.match(guide, topic);
  }
});

// 56. Generated artifacts are Git-ignored.
test("generated bundle artifacts are git-ignored", () => {
  const ignore = readFileSync(resolve(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
  for (const entry of [".mcpb-build/", "artifacts/", "*.mcpb"]) {
    assert.ok(ignore.includes(entry), `.gitignore must contain ${entry}`);
  }
});
