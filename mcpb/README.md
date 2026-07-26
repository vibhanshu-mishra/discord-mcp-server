# Discord MCP Server (Claude Desktop extension)

A read-only-by-default Discord MCP server with **private local analytics** and
**no external AI provider**. This bundle runs a local stdio MCP server that Claude
Desktop starts on demand.

## What it does

- Reads Discord history and live activity (messages, reactions, threads, voice)
  for one configured server and stores it in a private local SQLite database.
- Computes deterministic community metrics and privacy-controlled qualitative
  candidates (topics, recurring questions, feedback signals, evidence packets).
- **Never** sends, edits, deletes, reacts to, or otherwise modifies Discord.
  Read-only mode is enforced and cannot be turned off through this bundle.

## Privacy

- Message content output is **disabled by default**; enable it only if you accept
  redacted excerpts being returned to the client.
- Users are pseudonymised and mentions are redacted in qualitative outputs.
- The database, backups, and exports live in the **data directory you choose**,
  not inside this extension.
- The bot cannot read private conversations between other Discord users.

## After installing

Complete the configuration form (bot token, server ID, and a local data
directory), then open a Claude conversation and ask, for example:

- "Sync Discord activity since last Monday."
- "Generate the most recently completed weekly metrics report."
- "Show unanswered questions older than 24 hours."

## Notes

- The extension runs only while Claude Desktop invokes it. Live collection happens
  only during that time; historical text messages can be synced later, but voice
  attendance cannot be reconstructed for periods when it was not running.
- Only one process may write to one database at a time (a file lock enforces this).

See the project README and `docs/desktop-extension.md` for full details.
