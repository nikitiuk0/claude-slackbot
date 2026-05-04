# claude-slackbot

A Slack bot that routes `@mention`s to a local Claude Code daemon on your laptop — so you can kick off real software engineering work from any Slack thread.

<img width="410" height="816" alt="Screenshot 2026-04-20 at 2 15 41 AM" src="https://github.com/user-attachments/assets/156cabcb-f568-45bf-8967-64796ad1c4b4" />

---

## Phase B (current) — multi-user relay

Phase B adds a shared relay server that holds the Slack tokens, so multiple engineers on the same workspace can each pair their own laptop. The server fans each mention out over an authenticated WebSocket connection to the right machine.

### Install (client)

```bash
# Step 1 — DM @claude-bot in Slack to get a pairing code, then:
npx -y @nikitiuk0/claude-slackbot pair \
  --profile <name> \
  --server https://<server-url> \
  --code <PAIR-... from DM>

# Step 2 — start the daemon
npx -y @nikitiuk0/claude-slackbot start
```

The `pair` command generates an Ed25519 keypair locally, registers it with the server, and writes a profile under `~/.claude-slackbot/profiles/<name>/`. The daemon connects to the server over a signed WebSocket and processes only the mentions that belong to your Slack user.

### Migrating from Phase A

If you previously ran Phase A (single-user, `data/state.json` in the repo root), pass `--migrate-from auto` to copy threads, milestones, and attachments into the new profile:

```bash
npx -y @nikitiuk0/claude-slackbot pair \
  --profile default \
  --server https://<server-url> \
  --code <PAIR-...> \
  --migrate-from auto
```

### Operator (server setup)

See [`server/README.md`](server/README.md) for Postgres setup, keypair generation, GCP Secret Manager config, and `gcloud run deploy` command.

Full design: [`docs/superpowers/specs/2026-04-20-phase-b-multi-user-design.md`](docs/superpowers/specs/2026-04-20-phase-b-multi-user-design.md).

---

## Phase A (legacy)

Phase A was a single-user daemon: one `.env` + `config.json`, runs directly on your laptop, no server needed. It is tagged at [`v0.1.0-phase-a`](https://github.com/nikitiuk0/claude-slackbot/releases/tag/v0.1.0-phase-a).

To use Phase A, check out that tag and follow the README there. For the original design rationale see [`docs/superpowers/specs/2026-04-19-claude-slackbot-design.md`](docs/superpowers/specs/2026-04-19-claude-slackbot-design.md).

---

## How it works (Phase B)

`@mention` the bot in any channel → the server identifies your Slack user → sends the event over WebSocket to your paired laptop → your machine spawns a local `claude` CLI session pointed at a configured working folder → Claude reads the codebase, edits files, runs tests, pushes branches, opens PRs → milestones stream back in real time → structured summary posted when done.

Key properties:
- **Runs locally.** Your code and credentials never leave your machine. The server only relays Slack events and RPC calls.
- **Multi-user.** Each engineer pairs their own laptop. The server routes mentions to the right machine per Slack user.
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

The relay server is a Node.js + TypeScript process that runs on Cloud Run (always-on, min=max=1 for Socket Mode). Each client daemon connects over a mutual-auth WebSocket (Ed25519 JWT). Pairing state lives in Postgres; the server holds Slack tokens and fan-outs RPC calls to the correct machine.

Full implementation plan: [`docs/superpowers/plans/2026-04-20-phase-b-multi-user.md`](docs/superpowers/plans/2026-04-20-phase-b-multi-user.md).
