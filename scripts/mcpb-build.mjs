#!/usr/bin/env node
/**
 * Builds the Claude Desktop MCP bundle (.mcpb) from the compiled server.
 *
 * Subcommands:
 *   prepare   Clean staging, compile, stage server + prod deps + manifest/docs.
 *   pack      Validate the staged manifest and pack into artifacts/*.mcpb.
 *   build     prepare + pack + report (filename, size, SHA-256). [default]
 *
 * Never prints sensitive configuration. The generated .mcpb is git-ignored.
 */
import {
  rmSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkDir, checkRequired } from "./mcpb-inspect.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const STAGING = join(ROOT, ".mcpb-build");
const ARTIFACTS = join(ROOT, "artifacts");
const MCPB_BIN = join(ROOT, "node_modules", ".bin", "mcpb");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
}

function prepare() {
  console.log("• Cleaning staging directory…");
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(join(STAGING, "server"), { recursive: true });

  console.log("• Compiling TypeScript (npm run build)…");
  run("npm", ["run", "build"]);

  console.log("• Staging compiled server files…");
  cpSync(join(ROOT, "dist"), join(STAGING, "server"), { recursive: true });

  console.log("• Installing production dependencies…");
  copyFileSync(join(ROOT, "package.json"), join(STAGING, "package.json"));
  copyFileSync(join(ROOT, "package-lock.json"), join(STAGING, "package-lock.json"));
  run("npm", ["ci", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts"], { cwd: STAGING });
  rmSync(join(STAGING, "package-lock.json"), { force: true });

  console.log("• Writing generic production package.json…");
  const bundlePkg = {
    name: "discord-mcp-server",
    version: pkg.version,
    description: pkg.description,
    type: pkg.type,
    main: "server/index.js",
    license: pkg.license ?? "MIT",
    author: "Discord MCP Server Contributors",
    dependencies: pkg.dependencies,
  };
  writeFileSync(join(STAGING, "package.json"), JSON.stringify(bundlePkg, null, 2) + "\n");

  console.log("• Generating manifest (version synced to package.json)…");
  const manifest = JSON.parse(readFileSync(join(ROOT, "mcpb", "manifest.json"), "utf8"));
  manifest.version = pkg.version;
  writeFileSync(join(STAGING, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log("• Copying LICENSE and bundle README…");
  copyFileSync(join(ROOT, "LICENSE"), join(STAGING, "LICENSE"));
  copyFileSync(join(ROOT, "mcpb", "README.md"), join(STAGING, "README.md"));

  console.log("• Inspecting staged contents…");
  const problems = [...checkRequired(STAGING), ...checkDir(STAGING)];
  if (problems.length) {
    console.error(`Staging inspection FAILED with ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("  staging inspection passed.");
}

function pack() {
  console.log("• Validating staged manifest…");
  run(MCPB_BIN, ["validate", join(STAGING, "manifest.json")]);

  mkdirSync(ARTIFACTS, { recursive: true });
  const outName = `Discord-MCP-Server-${pkg.version}.mcpb`;
  const outPath = join(ARTIFACTS, outName);
  rmSync(outPath, { force: true });

  console.log("• Packing bundle…");
  run(MCPB_BIN, ["pack", STAGING, outPath]);

  const size = statSync(outPath).size;
  const sha256 = createHash("sha256").update(readFileSync(outPath)).digest("hex");
  console.log("\n── Bundle built ──────────────────────────────");
  console.log(`  artifact: ${outName}`);
  console.log(`  path:     artifacts/${outName}`);
  console.log(`  size:     ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`  sha256:   ${sha256}`);
  console.log("──────────────────────────────────────────────");
  return { outPath, outName, size, sha256 };
}

const sub = process.argv[2] ?? "build";
if (sub === "prepare") prepare();
else if (sub === "pack") pack();
else if (sub === "build") {
  prepare();
  pack();
} else {
  console.error(`Unknown subcommand: ${sub} (use prepare | pack | build)`);
  process.exit(2);
}
