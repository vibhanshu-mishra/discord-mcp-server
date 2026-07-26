#!/usr/bin/env node
/**
 * Inspects a finished .mcpb bundle (or an unpacked/staged directory) for forbidden
 * content and required files. Exits non-zero when anything forbidden is found.
 *
 * Usage:
 *   node scripts/mcpb-inspect.mjs                 # inspect the newest artifacts/*.mcpb
 *   node scripts/mcpb-inspect.mjs <file.mcpb>     # inspect a specific bundle
 *   node scripts/mcpb-inspect.mjs <directory>     # inspect an unpacked/staged dir
 *
 * The `checkDir`/`checkRequired` functions are exported for unit testing without
 * network access or a real bundle.
 */
import { readdirSync, statSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, sep, extname, basename } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
// The person-name token is assembled at runtime so this scanner's own source
// never contains the literal word it searches for.
const FORBIDDEN_NAME = ["rhy", "thm"].join("");

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = full.slice(base.length + 1);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push({ full, rel });
  }
  return out;
}

const underNodeModules = (rel) => rel.split(sep).includes("node_modules");

/** Returns a list of forbidden-content problems found in `dir`. */
export function checkDir(dir) {
  const problems = [];
  const add = (msg) => problems.push(msg);
  for (const { full, rel } of walk(dir)) {
    const bn = basename(rel);
    const ext = extname(rel).toLowerCase();
    const segs = rel.split(sep);

    if (/^\.env(\..+)?$/.test(bn)) add(`env file present: ${rel}`);
    if ([".sqlite", ".sqlite3", ".db", ".db-journal"].includes(ext))
      add(`database file present: ${rel}`);
    if (ext === ".lock") add(`lock file present: ${rel}`);
    if (ext === ".mcpb") add(`nested .mcpb present: ${rel}`);
    if (segs.includes(".git")) add(`git metadata present: ${rel}`);

    if (!underNodeModules(rel)) {
      if (/(^|\/)(backups|exports|logs)(\/|$)/.test(rel.split(sep).join("/")))
        add(`generated data directory present: ${rel}`);
      if (
        /\.test\.(js|ts|mjs|cjs)$/.test(bn) ||
        segs.includes("test") ||
        segs.includes("__tests__")
      )
        add(`test file present: ${rel}`);
      if (ext === ".ts" && !bn.endsWith(".d.ts")) add(`TypeScript source present: ${rel}`);
      if (segs.length === 1 && (bn === "Dockerfile" || /^docker-compose.*\.ya?ml$/.test(bn)))
        add(`Docker file present in bundle: ${rel}`);
    }

    // Text scan of small, non-node_modules files for secrets/paths/names/IDs.
    const scanText =
      !underNodeModules(rel) &&
      [".json", ".md", ".js", ".txt", ""].includes(ext) &&
      statSync(full).size < 512 * 1024;
    if (scanText) {
      const text = readFileSync(full, "utf8");
      if (text.includes("/Users/") || (homedir().length > 1 && text.includes(homedir())))
        add(`absolute developer path present: ${rel}`);
      if (text.toLowerCase().includes(FORBIDDEN_NAME)) add(`person-specific name present: ${rel}`);
      if (bn === "manifest.json") {
        if (/\b\d{17,20}\b/.test(text)) add(`real-looking Discord ID in manifest: ${rel}`);
        if (/DISCORD_TOKEN"\s*:\s*"(?!\$\{)/.test(text))
          add(`hard-coded token in manifest: ${rel}`);
      }
    }
  }
  return problems;
}

/** Returns a list of missing-required-file problems in a bundle `dir`. */
export function checkRequired(dir) {
  const problems = [];
  const need = (rel, label) => {
    if (!existsSync(join(dir, rel))) problems.push(`missing ${label}: ${rel}`);
  };
  need("manifest.json", "manifest");
  need("server/index.js", "server entry point");
  need(
    "node_modules/@modelcontextprotocol/sdk",
    "production dependency (@modelcontextprotocol/sdk)",
  );
  need("LICENSE", "LICENSE");
  need("README.md", "bundle README");

  if (existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "package.json"))) {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (manifest.version !== pkg.version) {
      problems.push(
        `manifest version (${manifest.version}) != package.json version (${pkg.version})`,
      );
    }
  }
  return problems;
}

function inspectDirectory(dir) {
  const problems = [...checkRequired(dir), ...checkDir(dir)];
  return problems;
}

function newestArtifact() {
  const dir = join(ROOT, "artifacts");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".mcpb"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? join(dir, files[0].f) : null;
}

function main() {
  const arg = process.argv[2] ?? newestArtifact();
  if (!arg) {
    console.error(
      "No .mcpb found in artifacts/ and no path given. Run `npm run mcpb:build` first.",
    );
    process.exit(1);
  }
  let dir = arg;
  let temp = null;
  if (statSync(arg).isFile()) {
    temp = mkdtempSync(join(tmpdir(), "mcpb-inspect-"));
    execFileSync(join(ROOT, "node_modules", ".bin", "mcpb"), ["unpack", arg, temp], {
      stdio: "ignore",
    });
    dir = temp;
  }
  try {
    const problems = inspectDirectory(dir);
    if (problems.length) {
      console.error(`Bundle inspection FAILED with ${problems.length} problem(s):`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(
      `Bundle inspection passed: ${statSync(arg).isFile() ? basename(arg) : arg} contains no forbidden content and all required files.`,
    );
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
