import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import analyticsModule from "../src/tools/analytics.js";

const root = resolve(fileURLToPath(import.meta.url), "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// 88. Phase 5 introduces no new Discord-write capability.
test("no analytics tool becomes a Discord writer", () => {
  for (const def of analyticsModule.definitions) {
    assert.equal(def.discordWrite, false, `${def.name} must not write to Discord`);
    assert.ok(
      !/send|reply|edit|delete|react|ban|kick|create|modify|prune/i.test(def.name) ||
        def.name.startsWith("discord_get") ||
        def.name.startsWith("discord_analytics") ||
        def.name.startsWith("discord_sync") ||
        def.name.startsWith("discord_generate"),
      `${def.name} name check`,
    );
  }
});

// 89. No external AI-provider dependency is introduced.
test("no AI-provider or vector dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  // `@anthropic-ai/mcpb` is the MCP Bundle packaging toolchain (dev-only), NOT an
  // AI-provider SDK; it ships no model client. Everything else must not look like
  // an AI/vector dependency.
  const ALLOWED = new Set(["@anthropic-ai/mcpb"]);
  for (const name of Object.keys(deps)) {
    if (ALLOWED.has(name)) continue;
    assert.ok(
      !/anthropic|openai|@google|google-generative|langchain|pinecone|chromadb|weaviate|@xenova|onnxruntime|transformers|embedding/i.test(
        name,
      ),
      `unexpected AI/vector dependency: ${name}`,
    );
  }
});

// 90. Generic-naming scan of the Phase 5 additions stays clean.
test("Phase 5 files contain no person-specific name", () => {
  // Build the forbidden token at runtime so this scanner's own source does not
  // contain the literal word it searches for.
  const forbidden = ["rhy", "thm"].join("");
  const files = [
    ...walk(join(root, "src/cli")),
    ...walk(join(root, "src/operations")),
    join(root, "Dockerfile"),
    join(root, "docker-compose.example.yml"),
    ...walk(join(root, "test")).filter((f) => f.includes("ops-")),
  ];
  for (const f of files) {
    const text = readFileSync(f, "utf8").toLowerCase();
    assert.ok(!text.includes(forbidden), `person-specific name found in ${f}`);
  }
});
