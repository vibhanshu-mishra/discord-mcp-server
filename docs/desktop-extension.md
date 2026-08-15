# Claude Desktop Extension Guide

This guide covers building, inspecting, installing, configuring, testing,
upgrading, and troubleshooting the Discord MCP Server as a Claude Desktop MCP
bundle (`.mcpb`). It uses only invented example IDs and paths.

## Building the bundle

Requires a developer checkout with dependencies installed (`npm ci`).

```bash
npm run mcpb:build
```

This cleans the staging directory, compiles TypeScript, stages the compiled
server under `server/`, installs **production-only** dependencies, generates the
manifest (with the version synced from `package.json`), copies `LICENSE` and a
bundle README, validates the manifest, packs the bundle, and prints the artifact
filename, size, and SHA-256 checksum. The result is written to:

```
artifacts/Discord-MCP-Server-<version>.mcpb
```

Individual steps are also available: `npm run mcpb:prepare`,
`npm run mcpb:validate`, `npm run mcpb:pack`.

## Inspecting the bundle

```bash
npm run mcpb:inspect
```

This unpacks the newest `artifacts/*.mcpb` and fails (non-zero) if it finds any
forbidden content — a `.env`, a database, backups/exports/logs/locks, git
metadata, tests, TypeScript source, an absolute developer path, a hard-coded
token, a real-looking Discord ID, or a person-specific name — or if a required
file (manifest, server entry point, production dependency, `LICENSE`, bundle
README) is missing, or if the manifest version does not match `package.json`.

## Installing it locally

1. Download `Discord-MCP-Server-<version>.mcpb` (from a GitHub Release, or the
   file you built).
2. Open **Claude Desktop**.
3. Go to **Settings → Extensions → Advanced settings**.
4. Select **Install Extension**.
5. Choose the `.mcpb` file.
6. Complete the configuration form (see below).
7. If tools do not appear, **restart Claude Desktop**.
8. Open the connector/tools menu to confirm the Discord tools are listed.

## Configuring it

The configuration form collects:

- **Discord bot token** — from your Discord Developer Portal application. Stored
  privately; never shown or logged.
- **Discord server (guild) ID** — the numeric server ID (enable Developer Mode in
  Discord, right-click the server, "Copy Server ID").
- **Local data directory** — a folder **outside** the extension for the database,
  lock, backups, and exports. A per-user default under your home folder is
  suggested; pick a private location.
- Optional: primary user ID, staff user IDs, resource/office-hour channel IDs,
  history start date, time zone, and toggles for storing content, allowing
  content output, voice collection, and bot-DM collection.
- **Read-only mode** — defaults to **ON**. When on, Discord write and destructive
  tools are hidden and blocked. Turn it **OFF** only when you want Claude to send
  messages or make changes in Discord.

With **Read-only mode** off, the extension exposes the supported Discord mutation
tools. This does not give the bot any extra Discord permissions: Discord continues
to enforce the permissions and role hierarchy assigned to the bot. Grant only the
permissions needed for the actions you want; **Administrator** is broad and simple
but usually not necessary. Content output is off by default.

To return to the analytics-only profile, turn **Read-only mode** back on and
restart or reload Claude Desktop. The extension starts a new local server for the
updated configuration; open the connector/tools menu to confirm mutation tools
are absent.

## Testing it

Ask Claude, for example:

- "Sync Discord activity since last Monday."
- "Generate the most recently completed weekly metrics report."
- "Show unanswered questions older than 24 hours."
- With **Read-only mode** off: "Send a message in the announcements channel saying
  the workshop starts in 10 minutes."
- With **Read-only mode** off: "Show me what would happen if I run this destructive
  action before executing it."

The first sync reads Discord history into the local database; subsequent metrics
questions read from that database.

Destructive tools remain annotated for clients. Bulk delete, channel delete, bulk
ban, and member pruning preview by default through `dry_run`; other destructive
actions retain their validation and Discord audit-log reasons.

## Upgrading it

There is no auto-updater. To upgrade, obtain a newer `.mcpb`, then in
**Settings → Extensions** remove the old version and install the new one (or use
the update control if Claude Desktop offers one). Your data directory is external,
so your database is preserved across upgrades.

## Uninstalling it

In **Settings → Extensions**, remove **Discord MCP Server**. This removes the
extension but **not** your external data directory — delete that folder manually
if you also want to remove the collected data (while Claude Desktop is not using
the extension).

## Finding extension logs

Claude Desktop writes MCP/extension logs under its application log folder:

- **macOS:** `~/Library/Logs/Claude/`
- **Windows:** `%APPDATA%\Claude\logs\`

Logs contain the server's stderr output. Message content, tokens, and signed URLs
are redacted by the server's logger.

## Troubleshooting missing tools

- Restart Claude Desktop after installing.
- After changing **Read-only mode**, restart or reload Claude Desktop, then reopen
  the connector/tools menu. Write tools appear only when it is off.
- Confirm the required fields (token, server ID, data directory) are filled in.
- Confirm the data directory is writable and **not** inside the extension folder.
- Check the extension logs for a startup error.
- Only **one** process may write to one database — if you also run a CLI `sync`
  or a second instance against the same data directory, the second writer is
  refused by the lock. Use a separate data directory or stop the other writer.

## Sharing the bundle privately

The `.mcpb` is a single self-contained file. Share it directly (e.g. an internal
file share). Recipients install it via **Settings → Extensions → Advanced
settings → Install Extension**. Do not embed a token; each installer enters their
own configuration.

## Creating a GitHub Release manually

1. Build and inspect the bundle (`npm run mcpb:build && npm run mcpb:inspect`).
2. On GitHub, go to **Releases → Draft a new release**, choose a tag (e.g.
   `v<version>`), and add release notes.
3. Attach `artifacts/Discord-MCP-Server-<version>.mcpb` as a release asset.
4. Publish. The `.mcpb` lives as a Release asset, **not** in Git history.

## Verifying the SHA-256 checksum

The build prints the artifact's SHA-256. Recipients can verify it:

```bash
# macOS / Linux
shasum -a 256 Discord-MCP-Server-<version>.mcpb
# Windows (PowerShell)
Get-FileHash .\Discord-MCP-Server-<version>.mcpb -Algorithm SHA256
```

Compare the output to the published checksum.
