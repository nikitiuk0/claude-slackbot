# Claude Slackbot

## Overview

Claude Slackbot is a Node.js + TypeScript daemon that runs on your laptop, connects to Slack via Socket Mode, and puts Claude to work whenever you `@mention` it in a thread. Mention the bot in any channel it belongs to, and it spawns a local `claude` CLI session pointed at a configured working folder on your machine — Claude reads the codebase, edits files, runs tests, pushes branches, and opens draft PRs. When the work is done, the bot posts a structured summary back in the thread with a one-sentence recap, key decisions, and PR links. Follow-up mentions in the same thread resume the same Claude session, so you can iterate in place. For full design rationale, architecture decisions, and failure-handling details, see [`docs/superpowers/specs/2026-04-19-claude-slackbot-design.md`](docs/superpowers/specs/2026-04-19-claude-slackbot-design.md).

---

## 1. Prerequisites

- **Node.js ≥ 20** (`node --version` to check).
- **The `claude` CLI** installed and authenticated on this machine. The daemon shells out to it directly. Run `claude --version` to verify.
- **A working folder** you want Claude to operate in — e.g. a local clone of `Tumblr/flavortown`. Your `gh` auth and git config should already be set up there (Claude will create branches, push commits, and open PRs as you).
- **A Slack workspace** where you can install custom apps. The [Slack Developer Sandbox](https://api.slack.com/developer-program) (`api.slack.com/developer-program`) is recommended for initial testing — it gives you an isolated workspace where you are the admin. See the spec §"Workspace admin involvement" for notes on enterprise-controlled workspaces.

---

## 2. Slack app setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **"Create New App"** → **"From an app manifest"**.
2. Choose your workspace, paste the full contents of [`slack-app-manifest.yaml`](slack-app-manifest.yaml) from this repo, and click **Create**.
3. Under **"Basic Information"** → **"App-Level Tokens"** → **"Generate New Token"**: give it any name, add the `connections:write` scope, and save. This is your `xapp-…` token for Socket Mode.
4. Under **"OAuth & Permissions"** → **"Install to Workspace"** → click **Allow**. (In enterprise workspaces your admin may need to approve the install — see spec §"Workspace admin involvement".)
5. Copy two tokens — you'll need both in `.env`:
   - **Bot User OAuth Token** (`xoxb-…`) — from "OAuth & Permissions".
   - **App-Level Token** (`xapp-…`) — from "Basic Information" → "App-Level Tokens".
6. Invite the bot to every channel you want it active in: `/invite @claude-bot`.

---

## 3. Local setup

```bash
git clone <repo-url> slackbot
cd slackbot
npm install
cp .env.example .env
# Edit .env: paste your xoxb- and xapp- tokens, set ALLOWED_USER_IDS to your Slack user ID(s)
cp config.example.json config.json
# Edit config.json: set workdir to the absolute path of your working folder,
#                   set ownerDisplayName to your name
```

**Finding your Slack user ID:** open Slack, click your avatar → "View full profile" → the "..." (more actions) menu → "Copy member ID". It looks like `U01234567`.

**`.env` reference:**

```
SLACK_BOT_TOKEN=xoxb-...         # bot user OAuth token
SLACK_APP_TOKEN=xapp-...         # app-level token (Socket Mode)
ALLOWED_USER_IDS=U01234567       # comma-separated; only these users can trigger the bot
LOG_LEVEL=info                   # optional; trace|debug|info|warn|error|fatal
```

**`config.json` reference:**

```json
{
  "workdir": "/absolute/path/to/your/working/folder",
  "claudeBinary": "claude",
  "maxParallelJobs": 3,
  "stallSoftNoticeMinutes": 5,
  "stallHardStopHours": 24,
  "slackEditCoalesceMs": 3000,
  "ownerDisplayName": "your-name"
}
```

Both files are gitignored. The daemon validates them with `zod` on startup and prints a clear error if anything is missing or malformed.

---

## 4. Run

```bash
npm run start     # foreground; structured JSON logs to stdout + ./data/logs/daemon.log
# or
npm run dev       # foreground with watch-on-change (tsx watch)
```

When you see `ready` in the logs, mention the bot in a Slack thread:

```
@claude-bot fix the 500 we're seeing on /api/posts
```

The bot will:
1. React with 🤔 on your message.
2. Post a "Working on it… (planning)" reply in the thread.
3. Update that reply live as Claude makes progress (file edits, commands, todos).
4. When Claude finishes, replace the status message with the structured summary (what was done, decisions, PR links, any blockers) and swap the reaction to ✅.

On error the reaction becomes ❌ and the status message shows the last useful milestone plus the tail of Claude's stderr.

---

## 5. In-thread commands

Mention the bot with one of these commands from anywhere in the thread:

| Command | Effect |
|---|---|
| `@claude-bot stop` | Kill the running subprocess for this thread. Session is preserved — re-mention to resume. Reaction → 🛑. |
| `@claude-bot nudge` (alias: `ping`) | Stop the current run and immediately resume the session with a wake-up turn that asks Claude to reassess what's blocking it. Useful when Claude seems stuck in a loop. |
| `@claude-bot reset` | Wipe the thread's session entirely. The next mention starts a brand-new Claude with no memory of prior turns. PRs Claude already pushed are not touched. Reaction → 🧹. |
| `@claude-bot status` | Reply with the current state (`status`, `started_at`, `last_event_at`) plus a copy-paste `claude --resume <id>` command so you can take the session over in your terminal. |
| `@claude-bot history` | Reply with the milestones from the most recent run on this thread (start, every tool/file event, end + status). Useful when the summary doesn't tell you everything you want to know. |
| `@claude-bot help` | List all of the above. |

Commands always work even if no run is in progress — they respond with a friendly no-op message if there's nothing to act on.

---

## 6. How runs work

**One thread = one Claude session.** Each Slack thread maps to a persistent Claude session ID. Follow-up mentions in the same thread resume that session via `claude --resume`, so Claude remembers everything it has already done.

**Single-flight per thread.** While a run is in progress, follow-up mentions in the same thread are queued (depth 1). If a second follow-up arrives before the first queued one runs, the newer one replaces it with a 🔁 reaction on the displaced message — you implicitly said "this, but better."

**Global parallel cap.** By default, at most 3 Claude subprocesses run at once across all threads (configurable via `maxParallelJobs` in `config.json`). When the cap is full, a new mention gets a ⏳ reaction and a queued notice that lists any currently stale running jobs (no progress in >5 min) with Slack permalinks so you can decide whether to `stop` them.

**Image attachments.** When a message in the thread has an image attached, the bot downloads it (using the bot's OAuth token) to `./data/attachments/<thread_ts>/` and renders the absolute local path into the thread context handed to Claude, so Claude can read the image with its `Read` tool (vision). Non-image attachments are mentioned in the context with a Slack permalink but not downloaded. Requires the `files:read` scope (included in the manifest).

**Archive janitor.** Threads whose last event is older than `archiveIdleDays` (default 7) get their state, milestone history, and downloaded attachments purged. Runs once at daemon startup and every hour thereafter. Set `archiveIdleDays: 0` in `config.json` to disable.

**Watchdog.** If a running job produces no stream output for 5 minutes, the status message gets a one-shot warning: "No progress in 5m — reply `stop` to abort or `nudge` to wake it." After 24 hours with no progress, the job is auto-stopped as a sanity net (session preserved for resume).

---

## 7. Updating

```bash
git pull
npm install     # in case dependencies changed
# Restart the daemon: Ctrl-C the running process, then npm run start
```

On restart, any thread that was mid-run at the time of the previous shutdown gets a "Daemon restarted; that run was interrupted. Re-mention to resume." message posted in its thread, and its state is marked `interrupted`. Re-mention in that thread to pick up where you left off.

---

## 8. Troubleshooting

**Bot doesn't react to my mention.**
Check that your Slack user ID is in `ALLOWED_USER_IDS` in `.env`. If it isn't, you'll see a 🚫 reaction on your message and a polite rejection reply. To find your user ID see the "Local setup" section above.

**Bot can't see thread history / gets no context.**
Make sure the bot is a member of the channel: `/invite @claude-bot`.

**`claude` not found.**
Set `claudeBinary` in `config.json` to the absolute path of your `claude` binary (e.g. `/usr/local/bin/claude` or whatever `which claude` returns).

**Daemon doesn't start / exits immediately.**
Check that both `.env` and `config.json` exist and contain valid values. The daemon validates both files with `zod` on startup and prints a descriptive error message for any missing or malformed field.

**Daemon logs are too noisy / not verbose enough.**
Set `LOG_LEVEL` in `.env` to one of `trace`, `debug`, `info` (default), `warn`, `error`, or `fatal`. Human-readable logs go to stdout in dev mode; structured JSON also writes to `./data/logs/daemon.log`.

---

## 9. Architecture

The daemon is a single long-lived Node.js process. It connects to Slack over Socket Mode (outbound WebSocket only — no public URL needed, no inbound traffic). The main components are:

- **Slack adapter** (`src/slack/adapter.ts`) — owns the Bolt app, normalises `app_mention` events, deduplicates redeliveries.
- **Identity gate** (`src/identity-gate.ts`) — checks user ID against `ALLOWED_USER_IDS`; rate-limits rejection replies to one per user per hour.
- **Job orchestrator** (`src/orchestrator.ts`) — single-flight per thread, per-thread queue (depth 1), global parallel cap, watchdog loop, command dispatch.
- **Claude runner** (`src/claude/runner.ts`) — spawns `claude` subprocess, owns its lifecycle, handles `SIGTERM` on stop/nudge/reset.
- **Stream parser** (`src/claude/stream-parser.ts`) — translates `claude --output-format stream-json` events into human-readable milestones and extracts the final `<slack-summary>` block.
- **Slack updater** (`src/slack/updater.ts`) — rate-limited message edits (max 1 per ~3s), reaction swaps at lifecycle transitions.
- **State store** (`src/state/store.ts`) — persists `thread_ts → session_id + status + timestamps` to `./data/state.json` with atomic writes (write-temp + rename).
- **Prompt builder** (`src/prompt/build-input.ts`) — assembles the `<thread_context>` + `<instruction>` input piped to Claude's stdin, scrubbing any injected tags from thread messages to prevent prompt injection.

For the full architecture diagram, data model, request lifecycle, failure-handling table, and design rationale, see [`docs/superpowers/specs/2026-04-19-claude-slackbot-design.md`](docs/superpowers/specs/2026-04-19-claude-slackbot-design.md). The implementation plan that produced this codebase is at [`docs/superpowers/plans/2026-04-19-claude-slackbot.md`](docs/superpowers/plans/2026-04-19-claude-slackbot.md).
