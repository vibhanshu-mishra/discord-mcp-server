<div align="center">

# Discord MCP Server

**A lightweight, multi-guild Discord MCP server with 95+ tools**

[![npm](https://img.shields.io/npm/v/@pasympa/discord-mcp)](https://www.npmjs.com/package/@pasympa/discord-mcp)
[![License](https://img.shields.io/github/license/PaSympa/discord-mcp)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-5865F2)](https://discord.js.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)

[![discord-mcp MCP server](https://glama.ai/mcp/servers/PaSympa/discord-mcp/badges/score.svg)](https://glama.ai/mcp/servers/PaSympa/discord-mcp)

Manage your entire Discord server from **Claude Desktop**, **Claude Code**, **Cursor**, **VS Code Copilot**, or any MCP-compatible client.
Messages, channels, roles, permissions, moderation, forums, webhooks — all through natural language.

</div>

---

## Why this one?

- **95+ tools** — messages, channels, roles, permissions, moderation, forums, webhooks, scheduled events, invites, DMs, embeds, and more
- **Multi-guild** — works across multiple servers, no `GUILD_ID` lock-in
- **Lightweight** — TypeScript + Node.js, ~70kB package, ~73MB Docker image (vs 400MB+ for Java alternatives)
- **Modular** — clean architecture, easy to extend with new tools
- **Two install methods** — npm or Docker, your choice

---

## Quick Start

Add this to your MCP client config and replace `YOUR_TOKEN_HERE` with your bot token:

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "@pasympa/discord-mcp"],
      "env": {
        "DISCORD_TOKEN": "YOUR_TOKEN_HERE"
      }
    }
  }
}
```

No install needed — `npx` handles everything.

> Don't have a bot yet? See [Creating Your Discord Bot](#creating-your-discord-bot).

---

## Configuration

<details>
<summary><strong>Claude Desktop</strong></summary>

Add the config above to your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop after saving.

</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add discord -e DISCORD_TOKEN=YOUR_TOKEN_HERE -- npx -y @pasympa/discord-mcp
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add the config above to `~/.cursor/mcp.json`. See [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol) for details.

</details>

<details>
<summary><strong>VS Code / GitHub Copilot</strong></summary>

Add to your `.vscode/mcp.json`:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "discord-token",
      "description": "Discord Bot Token",
      "password": true
    }
  ],
  "servers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "@pasympa/discord-mcp"],
      "env": {
        "DISCORD_TOKEN": "${input:discord-token}"
      }
    }
  }
}
```

See [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) for details.

</details>

<details>
<summary><strong>Docker</strong></summary>

```json
{
  "mcpServers": {
    "discord": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "DISCORD_TOKEN=YOUR_TOKEN_HERE",
        "pasympa/discord-mcp:latest"
      ]
    }
  }
}
```

</details>

<details>
<summary><strong>From source</strong></summary>

```bash
git clone https://github.com/PaSympa/discord-mcp
cd discord-mcp
npm install && npm run build
```

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/absolute/path/to/discord-mcp/dist/index.js"],
      "env": {
        "DISCORD_TOKEN": "YOUR_TOKEN_HERE"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>.env file (alternative)</strong></summary>

Instead of passing the token in the MCP config, create a `.env` file at the project root:

```
DISCORD_TOKEN=YOUR_TOKEN_HERE
```

The server loads `.env` automatically via `dotenv`.

</details>

### Environment variables

| Variable                  | Default | Description                                                                                                                                                                                   |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`           | —       | **Required.** Bot token.                                                                                                                                                                      |
| `DISCORD_READ_ONLY`       | `true`  | Read-only mode. **On by default** (and on for any missing/invalid value). While on, only read/list/search tools are exposed and every write tool is blocked. Set to `false` to enable writes. |
| `DISCORD_MESSAGE_CONTENT` | `true`  | Set to `false` to stop requesting the Message Content privileged gateway intent at connect time.                                                                                              |
| `DISCORD_GUILD_MEMBERS`   | `true`  | Set to `false` to stop requesting the Server Members privileged gateway intent at connect time.                                                                                               |
| `DISCORD_MCP_TOOLSETS`    | `all`   | Comma-separated list of toolsets to expose, to keep the tool list small. Unset or `all` exposes every tool.                                                                                   |
| `DISCORD_ALLOWED_GUILDS`  | all     | Comma-separated guild IDs the server may act on. When set, tool calls targeting any other guild are rejected — whether addressed by guild ID, channel ID, thread ID, webhook, or invite code. |

These flags only control which gateway intents the server requests when identifying. Requesting a privileged intent that is **not** enabled in the Developer Portal makes the connection fail at the first tool call (close code `4014`) — set the flag to `false` to connect anyway.

Data access is governed by the **portal toggles**, not by these flags: this server reads everything over the REST API, which Discord gates on the portal setting alone. So with the portal toggles on, setting these flags to `false` loses nothing. With a portal toggle **off**, the corresponding data is restricted regardless of the flags: message bodies come back empty (`content`, `embeds`, `attachments` — except the bot's own messages, DMs, and messages that mention the bot) and member listing fails — enable the toggle in the portal to restore it.

**Toolsets** (`DISCORD_MCP_TOOLSETS`): `discovery`, `messages`, `channels`, `permissions`, `members`, `roles`, `moderation`, `screening`, `stats`, `forums`, `webhooks`, `scheduled_events`, `invites`, `dm`. Example — `DISCORD_MCP_TOOLSETS=discovery,messages,members` exposes only the discovery, message, and member tools. Note: a toolset ships its whole module, including its destructive tools (`messages` includes bulk delete; `members` includes kick/ban) — use `DISCORD_ALLOWED_GUILDS` and the dry-run defaults to bound them. Only the listed toolsets' tools are advertised and callable. Unknown names make the server fail at startup instead of silently exposing everything (an empty value counts as unset and exposes all).

---

## Read-Only Mode

**Read-only mode is enabled by default.** You do not need to configure anything to get it — if `DISCORD_READ_ONLY` is missing, empty, or set to an unrecognised value, the server treats it as `true` and stays read-only. This is a deliberate safety default.

What it does:

- **All existing tools remain in the source code.** Nothing is deleted or removed. Every messaging, moderation, role, channel, webhook, forum, event, invite, and DM tool is still there.
- **While read-only mode is on, only tools that read, list, search, inspect, fetch, or retrieve Discord information are exposed to the AI client.** Tools that would send, reply, edit, delete, create, modify, moderate, ban, kick, timeout, react, pin, invite, schedule, upload, change permissions, manage roles, or create webhooks are **hidden**.
- **Write tools are also blocked at runtime as a second layer.** Even if a write tool were somehow advertised or called by name, the server refuses to run it and returns a clear error explaining that the action is blocked because read-only mode is enabled. No change reaches Discord.
- **Setting `DISCORD_READ_ONLY=false` restores the original tool availability** — every tool is exposed and callable exactly as before (still subject to `DISCORD_MCP_TOOLSETS`, `DISCORD_ALLOWED_GUILDS`, and the per-tool dry-run defaults).

To enable write tools, set the variable explicitly and restart the server:

```env
DISCORD_READ_ONLY=false
```

Accepted "off" values (case-insensitive): `false`, `0`, `no`, `off`. Any other value keeps read-only mode on.

### Important safety notes

- **The Discord bot token must never be committed to Git.** Keep it in your MCP client config or a local `.env` file (which is git-ignored). Never paste a real token into `.env.example`, the README, or any tracked file.
- **The bot cannot read private conversations between normal Discord user accounts.** It is a bot, not a user account. It can only read server content it has permission to access and DMs that users send directly to the bot. This server does not — and cannot legitimately — access personal user-account DMs.

---

## Local Discord Analytics

The analytics subsystem builds a **private, local** database of your server's activity so you can run engagement reports later. It is **read-only toward Discord** — it never sends, edits, deletes, reacts to, pins, acknowledges, or otherwise changes anything on Discord. It only reads, and it writes solely to a local SQLite file on your own machine. Because it never mutates Discord, it works even while `DISCORD_READ_ONLY=true`.

### Disabled by default

Analytics is **off unless you turn it on**. Set `DISCORD_ANALYTICS_ENABLED=true` and list the guilds it may collect from. A guild is only collected when it appears in **both** `DISCORD_ANALYTICS_GUILD_IDS` **and** `DISCORD_ALLOWED_GUILDS` — one without the other is rejected.

### Enabling it

```env
DISCORD_ANALYTICS_ENABLED=true
DISCORD_ANALYTICS_GUILD_IDS=123456789012345678
DISCORD_ALLOWED_GUILDS=123456789012345678
```

The analytics MCP tools live in the `analytics` toolset. If you use `DISCORD_MCP_TOOLSETS` to trim the tool list, include `analytics`:

```env
DISCORD_MCP_TOOLSETS=discovery,messages,analytics
```

The tools it adds: `discord_analytics_status`, `discord_sync_message_history`, `discord_get_sync_runs`, `discord_get_stored_message_counts`, and `discord_get_voice_sessions`.

### Where the data lives

The database is created at `data/discord-analytics.sqlite` by default (configurable with `DISCORD_ANALYTICS_DB_PATH`). The `data/` folder and all `*.sqlite`/`*.db` files are **git-ignored**, so the database is never committed.

### What is collected

- Messages from server channels the bot can read (including threads and forum posts)
- Message metadata (author, timestamps, reply/pin flags, edited/deleted status)
- Attachment **metadata only** (filename, type, size, URLs) — files are never downloaded
- Reactions available through the API
- Members seen in those channels (ID, username, display name, bot flag) — no unnecessary profile data
- Voice-channel join/leave sessions observed **while the bot is online**
- Optionally, DMs sent **directly to the bot** (only when `DISCORD_ANALYTICS_COLLECT_BOT_DMS=true`)

### What is NOT collected

- Nothing is sent, edited, deleted, acknowledged, or reacted to on Discord — ever.
- **Private conversations between two normal Discord user accounts are never accessed.** The bot is not a user; it cannot see DMs it is not part of. "Bot DMs" means messages a user chooses to send to the bot itself.
- Historical voice attendance **cannot be reconstructed.** Voice tracking only begins while the bot is online; there is no way to recover who attended before that.

### Server messages vs. personal DMs

"Server messages" are posts in channels the bot has been added to and given permission to read. "Personal user-to-user DMs" are private conversations between two people — the bot has no access to those and this project makes no attempt to obtain it.

### Privacy of stored content

With `DISCORD_ANALYTICS_STORE_MESSAGE_CONTENT=true` (the default, needed for later topic and unanswered-question analysis), **readable message text from your community is stored on your local machine.** Treat the database as sensitive. When set to `false`, only metadata and a one-way hash are stored — counts and voice metrics still work, but message text is neither stored nor returned. **The database must never be committed to Git.**

### First historical sync

Once analytics is enabled, run the sync tool through your MCP client (it reads Discord history and writes only to the local DB):

- Call `discord_sync_message_history` with a `guild_id` (and optionally `start_date`, `channel_ids`, `max_messages_per_channel`, or `dry_run: true` to estimate first).
- Inspect results with `discord_get_sync_runs`, and current totals with `discord_analytics_status`.

### Backing up and deleting the database

- **Back up:** while the MCP is stopped, copy the file, e.g. `cp data/discord-analytics.sqlite backups/analytics-backup.sqlite`.
- **Delete:** while the MCP is stopped, remove the file and its journal, e.g. `rm data/discord-analytics.sqlite data/discord-analytics.sqlite-*`. A fresh empty database is created on the next start. (There is intentionally **no** MCP tool that deletes analytics data.)

---

## Community Metrics and Reporting

Once analytics has collected data, eight **read-only** reporting tools turn the local database into community metrics. **They all read only the local SQLite database — none of them ever send, edit, delete, react to, acknowledge, or otherwise modify anything on Discord**, and they work while `DISCORD_READ_ONLY=true`. Message content is never returned by the aggregate tools; the two "open item" tools can return short opt-in excerpts (≤240 characters).

### Configuration

Set these in your `.env` (all optional except where a tool requires them; see `.env.example` for the full list):

| Variable                                         | Purpose                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `DISCORD_ANALYTICS_PRIMARY_USER_ID`              | **Optional.** A primary user (community owner/admin) for the weekly report. |
| `DISCORD_ANALYTICS_STAFF_USER_IDS`               | Comma-separated staff IDs. The primary user is auto-added when set.         |
| `DISCORD_ANALYTICS_RESOURCE_CHANNEL_IDS`         | Channels where trainings/resources are expected (cadence).                  |
| `DISCORD_ANALYTICS_OFFICE_HOUR_CHANNEL_IDS`      | Voice channels used for office hours (attendance).                          |
| `DISCORD_ANALYTICS_RESPONSE_WINDOW_HOURS`        | Hours before an unanswered question counts as open (default 24).            |
| `DISCORD_ANALYTICS_ACKNOWLEDGEMENT_WINDOW_HOURS` | Hours before a message counts as unacknowledged (default 24).               |
| `DISCORD_ANALYTICS_TIMEZONE`                     | IANA time zone for daily/weekly grouping (default UTC).                     |
| `DISCORD_ANALYTICS_WEEK_START`                   | `MONDAY` or `SUNDAY` (default MONDAY).                                      |
| `DISCORD_ANALYTICS_TRAINING_KEYWORDS`            | Words that help flag training posts.                                        |

### The eight reporting tools

- `discord_get_member_engagement` — per-member raw counts (messages, active days, replies sent/received, reactions received, candidate questions).
- `discord_get_user_activity` — a supplied user's posting cadence, who they reply to, and first-response speed (works for any `user_id`).
- `discord_get_staff_response_metrics` — response rate, within-window rate, and average/median/p90 first-response time.
- `discord_get_unanswered_questions` — candidate questions with no staff response, oldest first.
- `discord_get_unacknowledged_messages` — candidate member messages with no staff reply/reaction/thread response.
- `discord_get_training_cadence` — which resource-channel-weeks contain a probable training post, and which are missing.
- `discord_get_office_hour_metrics` — office-hour voice attendance (unique/first-time/repeat, durations, incomplete sessions).
- `discord_generate_weekly_metrics` — one structured weekly report combining all of the above, with previous-week comparisons.

### Example tool requests

- Member engagement for a week:
  `discord_get_member_engagement` with `{ "guild_id": "<id>", "start_date": "2024-06-03", "end_date": "2024-06-09", "sort_by": "messages" }`
- The most recent completed week's full report:
  `discord_generate_weekly_metrics` with `{ "guild_id": "<id>" }`
- Open questions older than the response window:
  `discord_get_unanswered_questions` with `{ "guild_id": "<id>" }`
- Activity for any single user:
  `discord_get_user_activity` with `{ "guild_id": "<id>", "user_id": "<id>", "start_date": "2024-06-03", "end_date": "2024-06-09" }`

### The optional primary user

`DISCORD_ANALYTICS_PRIMARY_USER_ID` is **optional**. It may identify the community owner, lead administrator, or any other user whose activity should appear as a dedicated section in `discord_generate_weekly_metrics`. When set, the ID is validated as a snowflake and added to the effective staff set; when unset, the weekly report simply marks that section as not configured (never fabricating a user). It is **not** required by `discord_get_user_activity`, which reports on any `user_id` you pass it. Do not put real Discord IDs in this public repository — configure them only in your local `.env`.

### Methodology and honesty

- **Candidate questions** are detected by a transparent heuristic: a member (non-bot, non-staff) message containing `?` or a common question phrase (e.g. "how do", "can someone"). It requires stored content. These are **candidates for human review**, not guaranteed questions.
- **Candidate unacknowledged messages** are member messages with no staff reply, staff reaction, or staff thread response within the acknowledgement window. Also **heuristic candidates** — a message can be acknowledged without its question being fully answered.
- **A staff response** is a direct reply, a staff post in a thread started from the question, or a staff post in the same thread — never merely a later message in a shared channel.
- **Training posts** qualify when posted by a configured staff author with an attachment, an http(s) link, or a training keyword. With content storage off, only attachment-based detection works.
- **Office-hour attendance** is only ever counted from sessions observed while the bot was online. **Historical attendance cannot be reconstructed**, and first-time-attendee status reports whether earlier history is available so nobody is falsely labelled a first-timer.
- **"New member"** in the weekly report means a member whose **first stored message** falls in that week — **not** necessarily when they joined the Discord server (join dates are not stored).
- All time grouping uses the configured time zone; weekly boundaries are half-open in UTC so midnight is never double-counted. Percentages expose numerator and denominator and return `null` when the denominator is zero; comparisons return `null` percentage change (never infinity) when the previous value is zero.

---

## Qualitative Analysis and Content Privacy

Six additional **read-only** tools turn the local database into structured qualitative evidence — what members discuss, which questions recur, and what requests/problems/feedback appear. **The MCP server itself never calls Claude, OpenAI, Gemini, or any other AI provider.** It reads stored data, selects and ranks evidence deterministically, redacts/pseudonymises it, and returns bounded structured JSON. **Your connected MCP client** performs any summarisation or interpretation. Every Phase 4 tool is read-only toward **both Discord and the local database** and works while `DISCORD_READ_ONLY=true`.

### The six tools

- `discord_get_conversation_context` — bounded context around one message (before/after, direct replies, thread), assembled only from local data (never fetched from Discord).
- `discord_get_topic_candidates` — lexical topic candidates (repeated words/phrases) with distinct member/channel counts and previous-period trends.
- `discord_get_recurring_question_candidates` — groups of similar candidate questions (deterministic Jaccard token-set similarity — no embeddings).
- `discord_get_feedback_signals` — messages classified into lexical candidate categories (request, problem, blocker, confusion, positive_outcome, suggestion, help_request).
- `discord_get_channel_conversation_summary_packet` — a deterministic evidence packet for one channel for an MCP client to summarise (no AI summary is generated).
- `discord_generate_qualitative_analysis_packet` — a guild-wide structured packet combining lexical analysis with reused Phase 3 metrics.

### Content privacy — two separate gates

Storing message content and **returning** it through MCP are different decisions:

- `DISCORD_ANALYTICS_STORE_MESSAGE_CONTENT` controls whether text is **stored** locally.
- `DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT` (**default `false`**) controls whether stored text may be **returned** through MCP.

**Both must be `true`** (and the per-call `include_*`/`include_evidence` flag set) before any readable excerpt leaves the database. When output is disabled, tools return IDs, timestamps, counts, channel info, content hashes, and deterministic lexical labels, and clearly report that content output is disabled — tools that need readable content return a limitation instead of fabricating results. Message content never appears in logs, errors, or startup output.

### Redaction, pseudonymisation, links, excerpts

- **Pseudonymisation** (`DISCORD_ANALYTICS_PSEUDONYMIZE_USERS`, default on): user IDs, usernames, and display names are replaced with stable generic labels within one response (`Member 1`, `Staff 1`, `Primary User`); the staff-vs-member distinction is preserved. Labels are not stable across unrelated calls. With pseudonymisation off, raw user IDs are returned only when content output is also enabled.
- **Mention redaction** (`DISCORD_ANALYTICS_REDACT_MENTIONS`, default on): user/role/channel mentions and `@everyone`/`@here` become `[member]`/`[role]`/`[channel]`/`[everyone]`/`[here]`; raw mention IDs are never returned.
- **Links** are reduced to their bare `scheme://host`, dropping paths, query strings, and fragments (so signed/auth tokens are removed). Attachment URLs are never returned by qualitative tools.
- **Excerpts** are opt-in, truncated to `DISCORD_ANALYTICS_MAX_EXCERPT_CHARACTERS` (default 240, with a truncation marker), and evidence items are capped by `DISCORD_ANALYTICS_MAX_EVIDENCE_MESSAGES` (default 100).
- **Excluded channels** (`DISCORD_ANALYTICS_QUALITATIVE_EXCLUDED_CHANNEL_IDS`) are filtered out in SQL before any content leaves the database.

### Methodology (all lexical — not AI)

- **Topics** are counted from unigrams/bigrams after stop-word removal, ranked by **distinct message count** (then distinct members); bigrams are preferred and near-duplicate labels merged. This is **lexical, not semantic** — never equivalent to an AI topic model.
- **Recurring questions** reuse the Phase 3 candidate-question heuristic and group by **Jaccard similarity** of normalised token sets above `DISCORD_ANALYTICS_QUESTION_SIMILARITY_THRESHOLD`; each message joins at most one group, and a group needs at least two questions.
- **Feedback signals** match central, documented phrase dictionaries; a message may match several categories, and the matched phrases are returned. These are **lexical candidates — not sentiment or emotion.**
- Deleted and bot messages are excluded everywhere; staff are excluded from topic/feedback analysis unless `DISCORD_ANALYTICS_QUALITATIVE_INCLUDE_STAFF=true`.

**All qualitative results are candidates that require human review.** No Phase 4 tool modifies Discord or the local database, and none generates persuasive prose.

### Example requests

- Topic candidates for a week:
  `discord_get_topic_candidates` with `{ "guild_id": "<id>", "start_date": "2024-06-03", "end_date": "2024-06-09" }`
- Recurring questions:
  `discord_get_recurring_question_candidates` with `{ "guild_id": "<id>", "start_date": "2024-06-03", "end_date": "2024-06-09" }`
- A channel evidence packet:
  `discord_get_channel_conversation_summary_packet` with `{ "guild_id": "<id>", "channel_id": "<id>", "start_date": "2024-06-03", "end_date": "2024-06-09" }`
- Context around a message:
  `discord_get_conversation_context` with `{ "guild_id": "<id>", "message_id": "<id>" }`

---

## Creating Your Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** > give it a name
3. **Bot** tab > **Reset Token** > copy the token
4. Enable **Privileged Gateway Intents** (this server requests both by default, but new Discord apps have the portal toggles OFF):
   - Server Members Intent
   - Message Content Intent

   > **Important:** if the bot requests a privileged intent that is not enabled here, Discord closes the connection with code `4014` and every tool call fails. Enable both, or stop requesting the ones you don't need via the [environment variables](#environment-variables) above.

5. **OAuth2 > URL Generator**:
   - Scopes: `bot`
   - Permissions: `Send Messages`, `Read Message History`, `Manage Channels`, `Manage Roles`, `Kick Members`, `Ban Members`, `Moderate Members`, `View Audit Log`, `Manage Messages`, `Manage Threads`, `Add Reactions`, `Manage Guild`, `Manage Webhooks`, `Manage Events`, `Create Events`, `Create Instant Invite`, `Manage Nicknames`, `Pin Messages`, `Embed Links`, `Create Public Threads`, `Send Messages in Threads`
6. Copy the generated URL and invite the bot to your server

---

## Available Tools (97)

### Discovery & Navigation (4 tools)

| Tool                           | Description                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `discord_list_guilds`          | List all servers the bot is connected to                         |
| `discord_get_guild_info`       | Get detailed guild info (name, members, channels, roles, boosts) |
| `discord_list_channels`        | List all channels in a guild grouped by category                 |
| `discord_find_channel_by_name` | Find a channel by name (partial match)                           |

### Messages (18 tools)

| Tool                            | Description                                         |
| ------------------------------- | --------------------------------------------------- |
| `discord_read_messages`         | Read the last N messages from a text channel        |
| `discord_send_message`          | Send a plain text message                           |
| `discord_reply_message`         | Reply to a specific message                         |
| `discord_edit_message`          | Edit a message sent by the bot                      |
| `discord_delete_message`        | Delete a specific message                           |
| `discord_add_reaction`          | Add a reaction emoji to a message                   |
| `discord_remove_reactions`      | Remove reactions (all, by emoji, or by user)        |
| `discord_get_reactions`         | List users who reacted with a specific emoji        |
| `discord_create_thread`         | Create a thread from a message or standalone        |
| `discord_bulk_delete_messages`  | Delete multiple messages at once (2-100)            |
| `discord_send_embed`            | Send a rich embed with all options                  |
| `discord_edit_embed`            | Edit an embed previously sent by the bot            |
| `discord_send_multiple_embeds`  | Send up to 10 embeds in a single message            |
| `discord_pin_message`           | Pin or unpin a message                              |
| `discord_fetch_pinned_messages` | List all pinned messages in a channel               |
| `discord_search_messages`       | Search messages by keyword (last 100)               |
| `discord_crosspost_message`     | Publish a message to announcement channel followers |
| `discord_forward_message`       | Forward a message to another channel                |

### Channels (8 tools)

| Tool                                  | Description                              |
| ------------------------------------- | ---------------------------------------- |
| `discord_create_channel`              | Create a text, voice channel or category |
| `discord_delete_channel`              | Delete a channel                         |
| `discord_edit_channel`                | Edit name, topic, slowmode, NSFW flag    |
| `discord_move_channel`                | Move a channel into/out of a category    |
| `discord_clone_channel`               | Clone a channel with its permissions     |
| `discord_set_channel_position`        | Set display position within a category   |
| `discord_follow_announcement_channel` | Follow an announcement channel           |
| `discord_lock_channel_permissions`    | Sync permissions with parent category    |

### Channel Permissions (6 tools)

| Tool                                | Description                                      |
| ----------------------------------- | ------------------------------------------------ |
| `discord_get_channel_permissions`   | List all permission overwrites on a channel      |
| `discord_set_role_permission`       | Allow/deny permissions for a role on a channel   |
| `discord_set_member_permission`     | Allow/deny permissions for a member on a channel |
| `discord_reset_channel_permissions` | Remove all overwrites (reset to inherited)       |
| `discord_copy_permissions`          | Copy overwrites from one channel to another      |
| `discord_audit_permissions`         | Full permission audit for all channels           |

### Members (11 tools)

| Tool                      | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `discord_list_members`    | List guild members with their roles                  |
| `discord_get_member_info` | Detailed member info (roles, permissions, join date) |
| `discord_search_members`  | Search members by username or nickname               |
| `discord_set_nickname`    | Set or clear a member's nickname                     |
| `discord_kick_member`     | Kick a member                                        |
| `discord_ban_member`      | Ban a member (optionally delete recent messages)     |
| `discord_unban_member`    | Unban a user                                         |
| `discord_bulk_ban`        | Ban multiple users at once (raid mitigation)         |
| `discord_list_bans`       | List all banned users                                |
| `discord_timeout_member`  | Timeout a member (0 to remove)                       |
| `discord_prune_members`   | Remove inactive members (with dry run)               |

### Roles (9 tools)

| Tool                        | Description                                                |
| --------------------------- | ---------------------------------------------------------- |
| `discord_list_roles`        | List all roles with permissions and member count           |
| `discord_create_role`       | Create a new role                                          |
| `discord_edit_role`         | Edit a role (name, color, permissions, hoist, mentionable) |
| `discord_delete_role`       | Delete a role                                              |
| `discord_add_role`          | Assign a role to a member                                  |
| `discord_remove_role`       | Remove a role from a member                                |
| `discord_get_role_members`  | List all members with a specific role                      |
| `discord_set_role_position` | Change a role's position in the hierarchy                  |
| `discord_set_role_icon`     | Set a custom icon or unicode emoji on a role               |

### Forums (10 tools)

| Tool                           | Description                          |
| ------------------------------ | ------------------------------------ |
| `discord_get_forum_channels`   | List all forum channels in a guild   |
| `discord_create_forum_channel` | Create a new forum channel           |
| `discord_create_forum_post`    | Create a post/thread in a forum      |
| `discord_get_forum_post`       | Get a post's details and messages    |
| `discord_list_forum_threads`   | List threads (active + archived)     |
| `discord_reply_to_forum`       | Reply to a forum post                |
| `discord_delete_forum_post`    | Delete a forum thread                |
| `discord_get_forum_tags`       | Get available tags                   |
| `discord_set_forum_tags`       | Set/update tags on a forum           |
| `discord_update_forum_post`    | Update title, archived, locked, tags |

### Webhooks (8 tools)

| Tool                             | Description                                       |
| -------------------------------- | ------------------------------------------------- |
| `discord_create_webhook`         | Create a webhook on a channel                     |
| `discord_send_webhook_message`   | Send via webhook (custom username/avatar, embeds) |
| `discord_edit_webhook`           | Edit a webhook's name, avatar, or channel         |
| `discord_delete_webhook`         | Delete a webhook                                  |
| `discord_list_webhooks`          | List webhooks for a channel or guild              |
| `discord_edit_webhook_message`   | Edit a message sent by a webhook                  |
| `discord_delete_webhook_message` | Delete a message sent by a webhook                |
| `discord_fetch_webhook_message`  | Fetch a specific webhook message                  |

### Scheduled Events (7 tools)

| Tool                             | Description                               |
| -------------------------------- | ----------------------------------------- |
| `discord_list_scheduled_events`  | List all scheduled events in a guild      |
| `discord_get_scheduled_event`    | Get detailed info about a scheduled event |
| `discord_create_scheduled_event` | Create a voice, stage, or external event  |
| `discord_edit_scheduled_event`   | Edit an existing scheduled event          |
| `discord_delete_scheduled_event` | Delete a scheduled event                  |
| `discord_get_event_subscribers`  | Get users who marked "Interested"         |
| `discord_create_event_invite`    | Create an invite linked to an event       |

### Direct Messages (7 tools)

| Tool                    | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `discord_send_dm`       | Send a direct message to a user by their user ID |
| `discord_send_dm_embed` | Send an embed in a DM to a user                  |
| `discord_read_dms`      | Read message history from a DM conversation      |
| `discord_reply_dm`      | Reply to a specific DM message                   |
| `discord_edit_dm`       | Edit a previously sent DM (text)                 |
| `discord_edit_dm_embed` | Edit a previously sent DM embed                  |
| `discord_delete_dm`     | Delete a DM message                              |

### Invites (5 tools)

| Tool                           | Description                             |
| ------------------------------ | --------------------------------------- |
| `discord_list_invites`         | List all active invites in a guild      |
| `discord_list_channel_invites` | List invites for a specific channel     |
| `discord_get_invite`           | Get details about an invite by its code |
| `discord_create_invite`        | Create an invite link for a channel     |
| `discord_delete_invite`        | Revoke an invite                        |

### Moderation & Screening (3 tools)

| Tool                                  | Description                            |
| ------------------------------------- | -------------------------------------- |
| `discord_get_audit_log`               | Fetch the guild audit log              |
| `discord_get_membership_screening`    | Get the membership screening form      |
| `discord_update_membership_screening` | Update screening rules for new members |

### Stats (1 tool)

| Tool                       | Description                                         |
| -------------------------- | --------------------------------------------------- |
| `discord_get_server_stats` | Server stats: members, channels, roles, boost level |

---

## Usage Examples

```
"List all servers the bot is in"
"Read the last 10 messages in #general"
"Send 'Hello everyone!' to the announcements channel"
"Create a forum channel called 'feedback' with tags Bug, Feature, Question"
"Show the full permission audit for the server"
"Create a webhook on #notifications and send a test message"
"Ban user 112233445566778899 and delete their messages from the last 3 days"
"Create an event called 'Game Night' for next Friday at 8pm"
"List all upcoming events in the server"
"Create a permanent invite for #general"
"List all active invites and delete expired ones"
"Send a DM to user 112233445566778899 saying 'Your build passed!'"
"Search for members named 'john'"
"List all banned users in the server"
"Show all pinned messages in #general"
"Forward that message to #announcements"
```

---

## Finding Discord IDs

Enable **Developer Mode** in Discord:
`Settings > Advanced > Developer Mode`

Then **right-click** on a server, channel, or user > **Copy ID**.

---

## Project Structure

```
discord-mcp/
├── src/
│   ├── index.ts             ← Entry point (MCP server + transport)
│   ├── client.ts            ← Discord client + shared helpers
│   ├── constants.ts         ← Shared constants (limits, defaults)
│   ├── embeds.ts            ← Shared embed schema + builder
│   └── tools/
│       ├── index.ts         ← Tool registry (toolset gating, dispatch)
│       ├── define.ts        ← defineTool/defineModule + shared zod fields
│       ├── types.ts         ← Shared TypeScript interfaces
│       ├── discovery.ts     ← Guild/channel discovery
│       ├── messages.ts      ← Message CRUD, reactions, threads, embeds
│       ├── channels.ts      ← Channel management
│       ├── permissions.ts   ← Permission overwrites
│       ├── members.ts       ← Member management
│       ├── roles.ts         ← Role CRUD and assignment
│       ├── moderation.ts    ← Audit log
│       ├── screening.ts     ← Membership screening
│       ├── stats.ts         ← Server statistics
│       ├── forums.ts        ← Forum channels, posts, tags
│       ├── webhooks.ts      ← Webhook management
│       ├── scheduledEvents.ts ← Scheduled events
│       ├── invites.ts        ← Invite management
│       └── dm.ts             ← Direct messages
├── test/                     ← node:test suite (schemas, gating, allow-list)
├── scripts/                  ← sync-version.js (npm version hook)
├── .github/workflows/        ← CI/CD (build check + auto release)
├── Dockerfile
├── .dockerignore
├── .env.example
├── package.json
├── tsconfig.json
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── README.md
```

### Adding a new tool

1. Create a new file in `src/tools/` (e.g. `events.ts`)
2. Declare each tool with `defineTool({ name, description, annotations, schema, handle })` and export `defineModule([...])` as the default
3. Import it and add it to `allToolsets` in `src/tools/index.ts` (the key is its `DISCORD_MCP_TOOLSETS` name)

---

## Security

- Never commit your Discord token to Git
- Use environment variables or a `.env` file (not versioned)
- Give the bot only the permissions it needs
- Restrict the server to specific servers with `DISCORD_ALLOWED_GUILDS`
- Irreversible mass actions (`bulk_ban`, `prune_members`, `bulk_delete_messages`, `delete_channel`) default to a `dry_run` preview — pass `dry_run:false` to apply

---

## Contributing

Contributions are welcome!

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Follow the modular structure — see [Adding a new tool](#adding-a-new-tool)
4. Commit your changes and open a pull request

---

## License

MIT — see [LICENSE](LICENSE) for details.
