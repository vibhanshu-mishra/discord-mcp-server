#!/usr/bin/env node
/**
 * Discord MCP Server — stdio entry point. Server construction lives in
 * `server.ts` (testable via in-memory transport); the Discord client in `client.ts`.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { join } from "path";
import { discord } from "./client.js";
import { createServer } from "./server.js";
import { initAnalytics, shutdownAnalytics } from "./analytics/runtime.js";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const version: string = pkg.version;

async function main() {
  // Initialise analytics before serving. This never throws: if analytics is
  // disabled or misconfigured, the MCP still starts with all reading tools.
  initAnalytics(discord);
  const transport = new StdioServerTransport();
  await createServer(version).connect(transport);
  console.error(`Discord MCP Server v${version} running on stdio.`);
}

function shutdown() {
  console.error("Shutting down Discord MCP Server...");
  shutdownAnalytics();
  discord.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

main().catch((err) => {
  console.error("Fatal:", err);
  discord.destroy();
  process.exit(1);
});
