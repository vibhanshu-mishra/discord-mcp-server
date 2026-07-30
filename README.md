<div align="center">

# Discord MCP Server

**A read-only-by-default Discord MCP server with private local analytics, installable as a one-click Claude Desktop extension.**

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2)](https://discord.js.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)

</div>

---

## Project overview

Discord MCP Server connects an MCP client (such as Claude Desktop) to a Discord bot and turns your community's activity into **structured, auditable analytics** while never changing anything on Discord.

- **Read-only by default.** Write tools remain in the source but are hidden and blocked at runtime unless you explicitly opt out; the desktop extension never opts out.
- **Private local SQLite analytics.** Messages, reactions, threads, and voice sessions are stored in a database on your own machine.
- **Deterministic metrics.** Member engagement, per-user activity, staff response health, unanswered/unacknowledged candidates, training cadence, office-hour attendance, and weekly reports — all reproducible, no black box.
- **Privacy-controlled qualitative analysis.** Lexical topic candidates, recurring-question groups, feedback signals, conversation context, and evidence packets. Message content output is **off by default**, and the server calls **no external AI provider** — your MCP client does any interpretation.
- **Operations CLI.** Diagnose (`doctor`), check the database, sync history, back up, export, and prune from the terminal, no MCP client required.
- **Claude Desktop extension.** Package everything as a single `.mcpb` for one-click local installation (recommended for non-developers).

---

## Recommended installation — Claude Desktop extension (no coding)

The easiest way to use Discord MCP Server is the one-click desktop extension. You do **not** need to clone this repository, install Node.js, run npm, or edit any JSON.

1. **Download** `Discord-MCP-Server-<version>.mcpb` from the project's GitHub **Releases** page.
2. Open **Claude Desktop**.
3. Go to **Settings → Extensions → Advanced settings**.
4. Select **Install Extension**.
5. Choose the downloaded `.mcpb` file.
6. **Complete the configuration form:**
   - **Discord bot token** (from the Discord Developer Portal).
   - **Discord server (guild) ID** (enable Developer Mode in Discord → right-click the server → _Copy Server ID_).
   - **Local data directory** (a private folder outside the extension; a per-user default is suggested).
   - Optional: primary user ID, staff user IDs, resource/office-hour channel IDs, history start date, time zone, and privacy toggles.
7. If the tools do not appear, **restart Claude Desktop**.
8. Open the **connector/tools** menu to confirm the Discord tools are listed.
9. Ask Claude to **synchronise Discord** (see examples below).
10. Ask Claude for **metrics**.

Claude Desktop starts the local server automatically when a conversation needs it and stops it when it is no longer needed. See [docs/desktop-extension.md](docs/desktop-extension.md) for building, upgrading, uninstalling, logs, and troubleshooting.

### Example Claude requests

- "Sync Discord activity since last Monday."
- "Generate the most recently completed weekly metrics report."
- "Show unanswered questions older than 24 hours."
- "Show member engagement for the current month."
- "Check whether training was posted in every configured resource channel."
- "Analyse recurring question candidates."
- "Produce a privacy-safe qualitative analysis packet."

---

## Capabilities

- **Historical message sync** — import past messages from readable text channels, announcements, forum posts, and (where permitted) threads, on demand for any date range. Re-running is idempotent.
- **Live collection (while running only)** — new messages, edits, deletions, reactions, thread changes, and voice-state changes are collected only while the server process is running (i.e. while Claude Desktop is invoking it). Gaps outside that window are filled by historical message sync — **except voice**, which is prospective only.
- **Stored data** — messages, reactions, threads, and voice sessions (metadata; attachment metadata only, never downloaded files).
- **Member engagement** — messages, active days, distinct channels, replies sent/received, unique reply partners, reactions received, and candidate questions per member.
- **Selected-user activity** — the same activity for any supplied user ID (generic; not tied to any named person).
- **Staff response health** — response rate, within-window rate, and average/median/p90 first-response times.
- **Unanswered-question candidates** and **unacknowledged-message candidates** — heuristic lists for human review.
- **Training cadence** — which resource channel-weeks contain a probable training/resource post.
- **Office-hour metrics** — voice attendance (unique/first-time/repeat, durations, incomplete sessions), prospective only.
- **Weekly metrics** — a single structured report combining the above with previous-week comparisons and an optional primary-user section.
- **Topic candidates**, **recurring-question candidates**, and **feedback signals** — deterministic **lexical** candidates (not semantic, not AI).
- **Conversation context** — bounded local context around a message (before/after, replies, thread).
- **Privacy-safe evidence packets** — deterministic evidence for a client to summarise (the server never writes prose).
- **Backups, exports, and pruning** — via the operations CLI.

---

## Safety and privacy

- **Discord write tools remain in the source but are hidden and blocked by default.** Read-only mode is on unless `DISCORD_READ_ONLY=false`; the desktop extension never disables it, so no send/edit/delete/react/moderation tool is exposed.
- **Personal user-to-user Discord DMs cannot be accessed.** The bot is not a user; it can only see server content it has permission to read and DMs sent directly to it.
- **DMs to the bot are optional** and off by default (`collect_bot_dms`).
- **Stored messages remain local** in your chosen data directory; nothing is uploaded anywhere.
- **Content output is disabled by default.** Returning readable excerpts through MCP requires _both_ content storage and content output to be enabled, plus a per-call flag; otherwise, only counts, IDs, timestamps, and lexical labels are returned.
- **Pseudonymisation and mention redaction** apply to qualitative outputs (user IDs/names become generic labels; mentions and signed URL parameters are stripped).
- **No external AI-provider calls** and no embeddings/vector storage — the server is provider-neutral.
- **Never commit a token.** The bot token belongs in the extension config or a local `.env`, both of which are ignored by Git.
- **The `.mcpb` format has no platform sandbox**, so the _server itself_ enforces these restrictions (read-only mode, content gates, one-writer locking); they are not delegated to the host.
- **One writer per database.** A file lock prevents two collectors (or a collector plus a CLI writer) from using one database at a time.

---

## Developer installation

For development, direct MCP use, or CLI operation.

```bash
git clone <your-fork-url> discord-mcp-server
cd discord-mcp-server
npm install
npm run build
npm test
```

Run the MCP server directly over stdio (add it to any MCP client config as a `node dist/index.js` command with a `DISCORD_TOKEN` env):

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp-server/dist/index.js"],
      "env": { "DISCORD_TOKEN": "your_bot_token_here" }
    }
  }
}
```

Or with Docker (see [Operations](#operations)):

```bash
docker build -t discord-mcp .
docker run --rm -i -e DISCORD_TOKEN=your_bot_token_here -v discord-analytics-data:/app/data discord-mcp
```

### Creating your Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token (keep it private).
3. Enable the **Server Members** and **Message Content** privileged gateway intents (the server requests both by default).
4. **OAuth2 → URL Generator**: scope `bot`, with at least `Read Messages/View Channels`, `Read Message History`, and `Connect` (voice) for the features you use. **No write permissions are required for analytics.**
5. Invite the bot to your server with the generated URL.

---

## Configuration reference

### Extension (MCPB) fields → environment variables

The desktop extension collects friendly fields and maps them to environment variables. Fixed safe defaults are applied by the bundle:

| Fixed by the bundle                                 | Value                   |
| --------------------------------------------------- | ----------------------- |
| `DISCORD_READ_ONLY`                                 | `true` (never disabled) |
| `DISCORD_ANALYTICS_ENABLED`                         | `true`                  |
| `DISCORD_MESSAGE_CONTENT` / `DISCORD_GUILD_MEMBERS` | `true`                  |

| Form field                                                             | Environment variable(s)                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discord bot token (required, sensitive)                                | `DISCORD_TOKEN`                                                                                                                                                                                                                            |
| Discord server (guild) ID (required)                                   | `DISCORD_ALLOWED_GUILDS` **and** `DISCORD_ANALYTICS_GUILD_IDS`                                                                                                                                                                             |
| Local data directory (required)                                        | `DISCORD_ANALYTICS_DB_PATH`, `DISCORD_ANALYTICS_LOCK_PATH`, `DISCORD_ANALYTICS_BACKUP_DIR`, `DISCORD_ANALYTICS_EXPORT_DIR` (derived as `<dir>/discord-analytics.sqlite`, `<dir>/discord-analytics.lock`, `<dir>/backups`, `<dir>/exports`) |
| Store message content                                                  | `DISCORD_ANALYTICS_STORE_MESSAGE_CONTENT`                                                                                                                                                                                                  |
| Allow content output                                                   | `DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT`                                                                                                                                                                                                   |
| Collect voice                                                          | `DISCORD_ANALYTICS_COLLECT_VOICE`                                                                                                                                                                                                          |
| Collect bot DMs                                                        | `DISCORD_ANALYTICS_COLLECT_BOT_DMS`                                                                                                                                                                                                        |
| Primary/staff/resource/office IDs, history start, time zone, log level | the matching `DISCORD_ANALYTICS_*` / `DISCORD_MCP_LOG_LEVEL` variables                                                                                                                                                                     |

### Key environment variables (developer/CLI use)

| Variable                                                            | Default                          | Description                                                                                           |
| ------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`                                                     | —                                | **Required.** Bot token. Never commit it.                                                             |
| `DISCORD_READ_ONLY`                                                 | `true`                           | Read-only mode. Any missing/invalid value stays read-only. Set to `false` only to expose write tools. |
| `DISCORD_ALLOWED_GUILDS`                                            | all                              | Comma-separated guild IDs the server may act on.                                                      |
| `DISCORD_ANALYTICS_ENABLED`                                         | `false`                          | Enable local analytics collection.                                                                    |
| `DISCORD_ANALYTICS_GUILD_IDS`                                       | —                                | Guilds analytics may collect from (must intersect `DISCORD_ALLOWED_GUILDS`).                          |
| `DISCORD_ANALYTICS_DB_PATH`                                         | `data/discord-analytics.sqlite`  | Local database path.                                                                                  |
| `DISCORD_ANALYTICS_STORE_MESSAGE_CONTENT`                           | `true`                           | Store readable message text locally.                                                                  |
| `DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT`                            | `false`                          | Allow redacted excerpts to be returned through MCP (needs storage too).                               |
| `DISCORD_ANALYTICS_COLLECT_VOICE`                                   | `true`                           | Record voice joins/leaves while running.                                                              |
| `DISCORD_ANALYTICS_COLLECT_BOT_DMS`                                 | `false`                          | Store DMs sent directly to the bot.                                                                   |
| `DISCORD_ANALYTICS_PRIMARY_USER_ID`                                 | —                                | Optional primary user for the weekly report.                                                          |
| `DISCORD_ANALYTICS_STAFF_USER_IDS`                                  | —                                | Comma-separated staff IDs.                                                                            |
| `DISCORD_ANALYTICS_RESOURCE_CHANNEL_IDS`                            | —                                | Comma-separated resource channels (training cadence).                                                 |
| `DISCORD_ANALYTICS_OFFICE_HOUR_CHANNEL_IDS`                         | —                                | Comma-separated office-hour voice channels.                                                           |
| `DISCORD_ANALYTICS_TIMEZONE`                                        | `UTC`                            | IANA time zone for grouping.                                                                          |
| `DISCORD_MCP_LOG_LEVEL`                                             | `info`                           | `error`, `warning`, `info`, or `debug`.                                                               |
| `DISCORD_ANALYTICS_LOCK_PATH` / `..._BACKUP_DIR` / `..._EXPORT_DIR` | `data/…` / `backups` / `exports` | Operational paths.                                                                                    |
| `DISCORD_ANALYTICS_RETENTION_DAYS`                                  | `0`                              | Default prune cutoff in days; `0` disables (nothing is auto-pruned).                                  |

See [.env.example](.env.example) for the complete, commented list (including qualitative-analysis thresholds).

---

## Operations

A generic operations CLI (`node dist/cli/index.js <command>`, or the `npm run` scripts) makes the server safe to run without an MCP client. **No operational command writes to Discord.**

| Command    | Purpose                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `doctor`   | Diagnose config and readiness. Offline by default; `--online` adds read-only Discord checks.          |
| `db-check` | Read-only database health (`--json`, `--clear-stale-lock`).                                           |
| `sync`     | Import Discord history (`--guild-id`, `--start-date`, …).                                             |
| `backup`   | Consistent, verified backup with a secret-free manifest.                                              |
| `export`   | Privacy-safe report export (JSON always; CSV for tabular reports).                                    |
| `prune`    | Delete old records — dry-run by default; `--confirm` to delete (backs up first unless `--no-backup`). |

Exit codes: `0` success · `1` failure · `2` invalid argument · `3` config · `4` database · `5` Discord · `6` lock conflict · `7` partial.

Docker: multi-stage build, non-root user, no port exposed, `/app/data` volume, `HEALTHCHECK` runs the offline `doctor`. See [docker-compose.example.yml](docker-compose.example.yml). Run **one collector per database**.

**Troubleshooting:** run `doctor` for a full diagnosis; a stale lock after a hard crash is recovered with `db-check --clear-stale-lock`; on Windows, stop the process cleanly so the lock releases.

---

## Limitations

- The desktop extension **runs only while Claude Desktop invokes it**; it is not a background daemon.
- It is **local** to the computer where it is installed; there is no remote/cloud access in this project.
- **Voice attendance is prospective only** — it cannot be reconstructed for periods when the collector was not running.
- **Historical message sync** depends on the bot's channel access and on Discord's retention.
- **Private user-to-user DMs are inaccessible** to the bot.
- **Privately distributed extensions require manual installation** of new bundle versions (there is no auto-updater).
- **Remote MCP transport, OAuth, and a web dashboard are not included.**

---

## Development status

The project was built in phases, all complete and covered by automated tests:

1. Read-only mode by default and central Discord-write protection.
2. Local SQLite analytics: historical sync and live message/reaction/thread/voice collection.
3. Deterministic community metrics: engagement, selected-user activity, staff response, training cadence, office-hour and weekly metrics.
4. Privacy-controlled qualitative analysis: topics, recurring questions, feedback signals, conversation context, and evidence packets — with no external AI provider.
5. Operations CLI: doctor, database checks, process locks, backups, exports, pruning, and Docker readiness.
6. Claude Desktop MCP bundle packaging (this phase).

---

## Licence and attribution

Released under the [MIT License](LICENSE). This project builds on the open-source
Discord MCP server ecosystem; see the `LICENSE` file for the full terms and
attribution. Bundle metadata uses the generic author "Discord MCP Server
Contributors".

---

## Acknowledgement

This project is originally forked from [PaSympa/discord-mcp](https://github.com/PaSympa/discord-mcp).

The current implementation includes substantial modifications and additional functionality, including read-only protections, local SQLite analytics, reporting tools, privacy controls, operational tooling, and Claude Desktop extension packaging.
