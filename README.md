# claude-slackbot

A Slack bot that routes `@mention`s to a local Claude Code daemon on your laptop — so you can kick off real software engineering work from any Slack thread.

Multi-user from a single shared `@claude-bot` app: a small relay server holds the Slack tokens and fans each mention out over an authenticated WebSocket to the originating user's paired machine. Your code, credentials, and Claude session stay on your laptop; the server is a thin transport layer.

<img width="410" height="816" alt="Screenshot 2026-04-20 at 2 15 41 AM" src="https://github.com/user-attachments/assets/156cabcb-f568-45bf-8967-64796ad1c4b4" />

---

## Install (client)

```bash
# Step 1 — DM @claude-bot in Slack (or @-mention it once) to get a pairing code, then:
npx -y @nikitiuk0/claude-slackbot pair \
  --profile <name> \
  --server https://<server-url> \
  --code <PAIR-... from DM>

# Step 2 — start the daemon
npx -y @nikitiuk0/claude-slackbot start
```

`cd` into your target working folder before running `pair` — the daemon will spawn `claude` with that directory as cwd.

`pair` generates an Ed25519 keypair locally, registers it with the server, and writes a profile under `~/.claude-slackbot/profiles/<name>/`. The daemon connects over a signed WebSocket and processes only mentions that belong to your Slack user.

### Multiple workspaces (profiles)

A single laptop can pair against multiple servers. Each gets its own profile:

```bash
npx -y @nikitiuk0/claude-slackbot pair --profile work --server https://work-server ...
npx -y @nikitiuk0/claude-slackbot pair --profile personal --server https://personal-server ...
npx -y @nikitiuk0/claude-slackbot start          # runs every profile concurrently
npx -y @nikitiuk0/claude-slackbot profiles list
npx -y @nikitiuk0/claude-slackbot unpair --profile personal
```

---

## Operator (server setup)

See [`server/README.md`](server/README.md) for Postgres setup, keypair generation, GCP Secret Manager config, and the `gcloud run deploy` command. A `docker-compose.yml` at the repo root brings up Postgres + the server for local dev.

Full design: [`docs/superpowers/specs/2026-04-20-phase-b-multi-user-design.md`](docs/superpowers/specs/2026-04-20-phase-b-multi-user-design.md).

---

## How it works

![Architecture overview](docs/architecture-overview.svg)

`@mention` the bot in any channel → the server identifies your Slack user → sends the event over WebSocket to your paired laptop → your machine spawns a local `claude` CLI session pointed at the configured working folder → Claude reads the codebase, edits files, runs tests, pushes branches, opens PRs → milestones stream back in real time → structured summary posted when done.

Key properties:
- **Runs locally.** Your code and credentials never leave your machine. The server only relays Slack events and Slack RPC calls; it never persists Slack content.
- **Multi-user.** Each engineer pairs their own laptop. The server routes mentions to the right machine per Slack user. Re-pairing automatically revokes the previous machine.
- **Uses your Claude Code setup.** The daemon shells out to the `claude` CLI, inheriting your MCP servers, custom skills, settings, and auth.
- **Bounded blast radius.** Claude runs inside one configured folder and opens draft PRs by default.

---

## In-thread commands

| Command | Effect |
|---|---|
| `@claude-bot stop` | Kill the running subprocess. Session preserved — re-mention to resume. |
| `@claude-bot nudge` | Stop and immediately resume with a wake-up turn (useful when Claude is stuck). |
| `@claude-bot reset` | Wipe the thread session entirely. |
| `@claude-bot status` | Report current state + a `claude --resume <id>` command to take over in terminal. |
| `@claude-bot history` | List milestones from the most recent run on this thread. |
| `@claude-bot help` | List all commands. |

---

## Architecture

The relay server is a Node.js + TypeScript process that runs on Cloud Run (always-on, `min=max=1` for Slack Socket Mode). Each client daemon connects over a mutually-authenticated WebSocket (Ed25519 JWT, server-key pinning). Identity rows (`users`, `machines`, `pairings`) live in Postgres — that's the entire server-side data model. The server holds the Slack bot token and dispatches each Slack RPC call (`postReply`, `addReaction`, `getThread`, `downloadFile`, …) on behalf of the connected machine.

For the full picture (system overview, pairing flow, mention/task flow, storage, auth) see [`docs/architecture.md`](docs/architecture.md). Full implementation plan: [`docs/superpowers/plans/2026-04-20-phase-b-multi-user.md`](docs/superpowers/plans/2026-04-20-phase-b-multi-user.md).
