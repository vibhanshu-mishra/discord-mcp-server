# Discord MCP Server (Claude Desktop extension)

A Discord read/write MCP server with **private local analytics** and **no external
AI provider**. This bundle runs a local stdio MCP server that Claude Desktop starts
on demand.

## What it does

- Reads Discord history and live activity (messages, reactions, threads, voice)
  for one configured server and stores it in a private local SQLite database.
- Computes deterministic community metrics and privacy-controlled qualitative
  candidates (topics, recurring questions, feedback signals, evidence packets).
- Enables existing supported message, channel, role, member, moderation, webhook,
  invite, event, forum, and bot-DM tools by default. Discord server permissions
  and role hierarchy still determine what can succeed.

## Privacy

- Message content output is **disabled by default**; enable it only if you accept
  redacted excerpts being returned to the client.
- Users are pseudonymised and mentions are redacted in qualitative outputs.
- The database, backups, and exports live in the **data directory you choose**,
  not inside this extension.
- The bot cannot read private conversations between other Discord users.

## After installing

Complete the configuration form (bot token, server ID, and local data directory),
then open a Claude conversation and ask, for example:

- "Sync Discord activity since last Monday."
- "Generate the most recently completed weekly metrics report."
- "Show unanswered questions older than 24 hours."

Discord write tools are already enabled in this bundle. Grant the bot only the
Discord permissions required for the intended actions; MCP visibility does not
override Discord permissions. For posting, use **View Channel**, **Send Messages**,
**Read Message History**, **Add Reactions**, **Embed Links**, **Attach Files**, and
thread permissions as needed. Forum creation requires **Send Messages** and
**Create Public Threads**; scheduled events use **Create Events** and **Manage
Events** as applicable. Use dry-run previews where provided before executing
destructive actions; bulk delete, channel delete, bulk ban, and member pruning are
dry-run by default.

## Notes

- The extension runs only while Claude Desktop invokes it. Live collection happens
  only during that time; historical text messages can be synced later, but voice
  attendance cannot be reconstructed for periods when it was not running.
- Only one process may write to one database at a time (a file lock enforces this).

See the project README and `docs/desktop-extension.md` for full details.
