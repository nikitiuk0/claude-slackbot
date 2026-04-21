# Claude Slackbot Phase B — Multi-User, Deployed Service

**Date:** 2026-04-20
**Status:** Approved (brainstorming complete)
**Phase:** B — multi-user via central relay server, GCP-first with on-prem path
**Builds on:** [Phase A spec](2026-04-19-claude-slackbot-design.md) (single-user MVP, completed and tagged at `v0.1.0-phase-a`).

## Goal

Run a small central server that talks to one shared `@claude-bot` Slack app
on behalf of multiple operators. Each operator pairs their machine to the
server once; from then on, mentions in Slack get routed to the right
operator's machine, where Phase A's daemon executes them. The server is a
**transport relay**, not a brain — operators' state stays on operators'
machines.

Same value proposition as Phase A (Slack thread → Claude does the work →
PRs land), now usable by every member of a workspace, with one Slack app
visible to everyone instead of N per-user apps.

## Scope

### In scope (Phase B)

- A single shared Slack app per workspace; the server holds the bot token.
- A central relay server that receives Slack events, routes them to the
  paired machine of the originating user, and posts back to Slack on
  behalf of the bot.
- Pairing flow: any trigger from an unpaired user (channel `@mention` or
  DM) prompts the bot to DM a one-shot pairing code + `npx` install
  command. User runs it on their machine; the machine is registered.
  Each Slack user has **at most one active machine at a time** —
  re-pairing replaces the previous machine.
- Server↔machine transport: WebSocket over TLS, authenticated with
  JWT/EdDSA per connection.
- Postgres for durable identity (users, machines, pairing codes). No Slack
  content stored at rest.
- Machines re-use Phase A's orchestrator unchanged. Only the
  `SlackAdapter` and `SlackClientFacade` are swapped for remote
  equivalents; everything else (state store, milestones, attachments,
  watchdog, commands) keeps working.
- Discovery indirection — a `/discover` endpoint hosted on the same
  server — so the operator can move the backend without DNS surgery.
  The server URL defaults to the Cloud Run auto-generated hostname
  (e.g. `https://claude-slackbot-xyz-uc.a.run.app`); a custom domain
  can be attached later without touching the design.
- Live in-band migration signal that moves connected clients to a new
  backend within seconds.
- Client auto-update via npm: the npm-published package self-replaces in
  place when the server announces a new version.
- Multi-workspace support per machine via local profiles
  (`~/.claude-slackbot/profiles/<name>/`).
- Server runs on GCP (single instance Cloud Run Job or VM) with a clear
  on-prem migration playbook.

### Out of scope (Phase B)

- **Offline-machine queuing.** Slack events for offline machines get a
  "your machine isn't online" reply; nothing is queued. Considered and
  scoped out as future work.
- Web admin UI / dashboard (post-MVP).
- Per-mention permission relay back to Slack (was A3 in Phase A; same
  decision: not now).
- Cross-workspace routing on the server side (server is single-workspace
  for MVP; the data model already supports multi-workspace as a future
  expansion).
- mTLS or per-message signing (we determined TLS + handshake JWT is
  sufficient).
- E2E content encryption (server has the Slack token and must see
  plaintext to do its job; we accept this as the security boundary).
- Compiled binary distributions (Homebrew tap, OS-specific binaries) —
  npm only for MVP.
- Server key rotation tooling (operator can rotate manually if needed
  during Phase B; automated rotation is post-MVP).

### Out of scope forever (or: explicit non-goals)

- Storing Slack thread content / message bodies / Claude outputs on
  the server, in any DB or log, ever. Memory-only transit.
- Server doing any work *for* a machine other than passing messages
  through (e.g. server doesn't run Claude itself).
- Routing one user's mentions to another user's machine.

## Threat model and security posture

What we're protecting against:

| Threat | Mitigation |
|---|---|
| On-path / network attacker reads Slack events or Claude outputs in transit | TLS 1.3 on every hop (server↔Slack, server↔machine, machine↔git). The `claude` CLI on the machine is what talks to the Anthropic API — the server never does. |
| Server-side data breach exposes historical Slack content | Server stores no Slack content. State files (sessions, milestones, attachments) live on machines; server's Postgres holds only identity rows. |
| Stolen pairing code lets attacker pair their own machine to my Slack identity | Code is one-shot, ~15-min TTL, bound to the Slack user that requested it. The legitimate Slack user gets a "Paired: this machine" DM they didn't initiate, providing immediate visible alarm and a one-tap unpair flow. Every new pair auto-revokes the user's previous machines, so a stolen code can't sit unnoticed behind a legitimate active machine. |
| Stolen client private key (machine theft) | Operator runs `@claude-bot unpair` from Slack; server marks `status='revoked'`; further connections from that key are refused. |
| npm publish account compromise pushes hostile update | Auto-update validates the published-by account against a hardcoded allowlist. (Defense is not perfect — see "Open security questions" below.) |

What we're explicitly NOT protecting against:

- **A compromised server.** If the server process is compromised, the
  attacker can modify routing code, read Slack events in memory as
  they arrive, craft arbitrary `slack_event` messages to any paired
  machine (including instructions that look like they came from a
  real Slack mention), and post anything they want to Slack as the
  bot. The pairing JWT auth prevents an attacker without the server
  from impersonating a machine, but it does not help against a
  malicious server itself. Operator controls (audit logging of
  server-side actions, minimal deploy access, cloud-provider IAM)
  are the real defense here.
- A determined Slack workspace admin reading messages: they already can.
  We don't add a second policy layer on top of Slack's own.
- A compromised machine running Claude doing harm in the operator's
  configured workdir: blast radius is bounded by `--dangerously-skip-permissions`
  + the workdir + draft PR mode, same as Phase A.
- A determined user installing the agent in a sandbox to bypass their
  own employer's policy: out of scope.

## Architecture

```
                                        ┌─────────────────────┐
                                        │ Slack workspace     │
                                        │   (e.g. Tumblr)     │
                                        │                     │
                                        │   @claude-bot       │
                                        └──────────┬──────────┘
                                                   │
                              Bolt Socket Mode     │
                              (server-side)        │
                                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│ Relay server (Cloud Run Job / on-prem container)                │
│  ┌──────────────────────────────┐                                │
│  │ Slack adapter (Bolt)         │                                │
│  │ Routing (DB + sockets)       │                                │
│  │ Pairing API                  │                                │
│  │ Discovery endpoint /discover │                                │
│  │ Auto-update announce         │                                │
│  │ WebSocket server             │                                │
│  └──────────────────────────────┘                                │
│  ┌──────────────────────────────┐                                │
│  │ Postgres (identity only)     │                                │
│  └──────────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────┘
          ▲
          │ WebSocket over TLS (one per paired machine / profile)
          ▼
┌─────────────────────────────────────────────────────────────────┐
│ Machine daemon (Phase A core + thin transport layer)            │
│  ┌────────────────────────┐                                      │
│  │ ServerAdapter + JWT    │                                      │
│  │ RemoteSlackFacade       │                                      │
│  └───────────┬────────────┘                                      │
│              ▼                                                    │
│  ┌────────────────────────────────────────┐                      │
│  │ Orchestrator (UNCHANGED from Phase A)  │                      │
│  │ + StateStore + Milestones              │                      │
│  │ + AttachmentsStore                     │                      │
│  │ + Watchdog + Commands                  │                      │
│  └───────────┬────────────────────────────┘                      │
│              ▼                                                    │
│  ┌────────────────────────┐                                      │
│  │ ClaudeRunner            │                                      │
│  │      │ spawns           │                                      │
│  │      ▼                  │                                      │
│  │ ┌──────────────┐        │─── git push ──▶ GitHub (PRs)        │
│  │ │ claude CLI   │──────────── HTTPS ──────▶ Anthropic API      │
│  │ └──────────────┘        │                                      │
│  └────────────────────────┘                                      │
│                                                                    │
│ Profile dir per workspace at ~/.claude-slackbot/profiles/<name>/  │
└─────────────────────────────────────────────────────────────────┘
```

Only the `claude` CLI on the machine talks to the Anthropic API — the
relay server never does.

**Two processes**: `relay-server` (one running anywhere — GCP/on-prem) and
`machine-agent` (one per operator, running on their machine). Slack app
talks only to the server; Anthropic API talks only to machines; nothing
about Slack content or Claude output transits the server's disk.

## Component responsibilities

### Server side

**SlackAdapter (server, mirrors Phase A's adapter shape).**
Owns Bolt + Socket Mode. Receives `app_mention` events. Hands them to
the router.

**Router.**
For an incoming Slack event, looks up `(workspace_id, user_id)` → the
user's single active machine in Postgres → checks it's currently
connected → forwards the event through that connection. If the user
has no active machine, triggers the install DM flow. If the machine
exists but isn't connected, replies in-thread with a reconnect
prompt.

**Pairing service.**
Issues short-TTL pairing codes via DM, validates them when a machine
calls `pair`, writes the machine row.

**WebSocket gateway.**
Accepts authenticated WebSocket connections from machines. Owns the
in-memory `connections` map and dispatches inbound messages to the
right handler (Slack RPC, heartbeat, ack).

**Slack RPC handler.**
Receives `slack_rpc_request` messages from machines, executes the named
Slack API call (`postReply`, `editMessage`, `addReaction`,
`removeReaction`, `deleteMessage`, `permalink`, `users.info`,
`conversations.replies`, `files.download`), returns the result via
`slack_rpc_response`.

**Discovery handler.**
`GET /discover` → `{ "primary": "https://.../ws" }`. Plain JSON over
HTTPS. Configurable via env / file.

**Auto-update announcer.**
Periodically checks `npm view @nikitiuk0/claude-slackbot version`; if
newer than the previously-broadcast version, sends `update_available`
to all connected clients.

**Migrate broadcaster.**
Operator-triggered command (e.g. CLI on the server) that sends
`{ type: "migrate", new_url }` to all connections.

### Machine side

**ServerConnection.**
Manages the WebSocket: connect, reconnect with backoff, JWT minting,
server-key pinning, in-band migrate handling.

**ServerAdapter.**
Replaces Phase A's `SlackAdapter`. Receives `slack_event` messages
from the server, normalises them to the same `IncomingMention` shape
the orchestrator already consumes.

**RemoteSlackFacade.**
Replaces Phase A's `SlackClientFacade`. Each method (`postReply`,
`editMessage`, …) becomes a `slack_rpc_request` over the WebSocket,
awaits the matching `slack_rpc_response`. Identical interface so the
orchestrator doesn't notice the difference.

**Profile manager.**
Loads all profiles from `~/.claude-slackbot/profiles/`, instantiates
one isolated stack (ServerConnection + ServerAdapter + Orchestrator
+ stores) per profile. Profiles share nothing.

**Updater.**
On `update_available`, defers until no run is in progress, runs
`npm install @nikitiuk0/claude-slackbot@<version>` in a temp dir,
atomically swaps, restarts the daemon.

**(Unchanged from Phase A):** `Orchestrator`, `StateStore`,
`MilestonesStore`, `AttachmentsStore`, `ClaudeRunner`, `IdentityGate`
(or removed — see "Migration" below), `EditCoalescer`, `parseStream`,
`buildInitialInput` / `buildFollowUpInput`, system prompt.

## Data model

### Server: Postgres

```sql
CREATE TABLE users (
  slack_workspace_id   TEXT        NOT NULL,
  slack_user_id        TEXT        NOT NULL,
  display_name         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slack_workspace_id, slack_user_id)
);

CREATE TABLE machines (
  machine_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_workspace_id   TEXT        NOT NULL,
  slack_user_id        TEXT        NOT NULL,
  public_key           BYTEA       NOT NULL,           -- 32 bytes Ed25519 pubkey
  label                TEXT,                            -- hostname, cosmetic
  status               TEXT        NOT NULL,            -- 'active' | 'revoked'
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  FOREIGN KEY (slack_workspace_id, slack_user_id)
    REFERENCES users(slack_workspace_id, slack_user_id)
);
-- Enforces the invariant: at most one active machine per Slack user.
-- New pairings revoke existing active rows before inserting.
CREATE UNIQUE INDEX machines_one_active_per_user
  ON machines (slack_workspace_id, slack_user_id)
  WHERE status = 'active';

CREATE TABLE pairings (
  pairing_code         TEXT        PRIMARY KEY,         -- ~20 chars, single-use
  slack_workspace_id   TEXT        NOT NULL,
  slack_user_id        TEXT        NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,            -- now() + 15min
  consumed_at          TIMESTAMPTZ,                     -- null until claimed
  machine_id            UUID                              -- set when consumed
);
CREATE INDEX pairings_pending
  ON pairings (slack_workspace_id, slack_user_id)
  WHERE consumed_at IS NULL;
```

**That is the entire server-side data model.** No Slack messages, no
session IDs, no milestone history, no attachments — those all live on
machines. The server is a directory + transport.

### Server: in-memory state

Rebuilt on restart in seconds; nothing here is durable.

```ts
// Active connections, keyed by machine_id
activeConnections: Map<UUID, {
  socket: WebSocket;
  connectedAt: number;
  lastPingAt: number;
  workspaceId: string;
  userId: string;
}>

// Reverse index for routing
userLiveMachines: Map<`${workspaceId}:${userId}`, Set<UUID>>

// Replay-prevention LRU for JWT jti claims
seenJtis: LRU<jti, expiry_ms>            // 5-min TTL, cap 4096

// Slack event-id dedupe (Bolt sometimes redelivers)
seenSlackEventIds: LRU<event_id, ts>     // 5-min TTL, cap 1024

// Pending RPC correlation
pendingRpcs: Map<rpc_id, { resolve, reject, timeout }>
```

### Machine: filesystem under `~/.claude-slackbot/`

```
~/.claude-slackbot/
├── profiles.json                          # { "default": "tumblr" }
└── profiles/
    └── <profile_name>/
        ├── identity/
        │   └── keypair.json               # 0600 — Ed25519 keypair
        ├── pinned-server-key.pub          # server's Ed25519 pubkey, captured at pair
        ├── config.json                    # 0644 — local config
        ├── data/
        │   ├── state.json                 # thread_ts → session_id (Phase A)
        │   ├── milestones/<thread_ts>.ndjson
        │   └── attachments/<thread_ts>/<file>
        └── logs/daemon.log
```

`config.json` shape:

```json
{
  "serverUrl": "https://claude-slackbot-xyz-uc.a.run.app",
  "workdir": "/Users/me/work/flavortown",
  "claudeBinary": "claude",
  "maxParallelJobs": 3,
  "stallSoftNoticeMinutes": 5,
  "stallHardStopHours": 24,
  "slackEditCoalesceMs": 3000,
  "archiveIdleDays": 7
}
```

Notably **gone** from Phase A's config: `slackBotToken`, `slackAppToken`,
`allowedUserIds`, `ownerDisplayName` (all server-side now).

## Pairing flow (P1)

### What triggers install

Any one of these, from a user with **no active machine paired**:
- An `@claude-bot` mention in any channel the bot is in.
- A DM to the bot — with any text, including an empty ping or the word
  `install`.

All three paths produce the same response: a friendly in-thread ack
(for the channel mention, so the thread sees the bot responded) plus a
DM with install instructions.

### Sequence

1. **Trigger**: user mentions `@claude-bot fix this bug` in a thread OR
   DMs the bot.
2. **Server** detects the requesting Slack user has no active machine.
   - For a channel mention: post a short, one-time in-thread reply:
     *"👋 You'll need to configure me on your machine first. Check your
     DMs for install instructions."* React 🛠️ on the trigger.
   - Issue a fresh `pairings` row with a 15-min TTL.
   - DM the user:

     > Welcome! To pair this Slack account with your machine, run on the machine you want to use:
     >
     > ```
     > npx -y @nikitiuk0/claude-slackbot pair \
     >   --server https://claude-slackbot-xyz-uc.a.run.app \
     >   --code PAIR-7a3f-9k2e
     > ```
     >
     > Code expires in 15 minutes.
     > Full install guide + troubleshooting: <https://github.com/nikitiuk0/claude-slackbot#readme>

   - If the trigger was a channel mention, the original mention is
     NOT queued or re-processed after pairing — the user re-mentions
     the bot once install is complete.

3. **User runs** the command on their machine.
4. **Machine agent** (`pair` subcommand):
   a. Generates an Ed25519 keypair, writes
      `~/.claude-slackbot/profiles/default/identity/keypair.json` with
      perms `0600`.
   b. Connects to `<server>/pair` over HTTPS:
      `POST /pair { "code": "PAIR-…", "machine_public_key": "<base64>", "label": "<hostname>" }`
   c. Server validates the code is unused + not expired + matches the
      DMing user, then in a single DB transaction:
      - Revokes all existing `active` machines for this
        `(workspace, user_id)` — sets `status='revoked'` and
        `revoked_at = now()`.
      - Inserts the new `machines` row with `status='active'`.
      - Marks `pairings.consumed_at` and `pairings.machine_id`.
      - Returns
        `{ "machine_id": "uuid", "server_public_key": "<base64>", "ws_url": "wss://.../ws", "revoked_previous": <count> }`.
   d. Machine writes `pinned-server-key.pub` and `config.json` (with
      `serverUrl`).
   e. Machine installs an OS auto-start hook (launchd plist on macOS;
      systemd `--user` unit on Linux). Starts the daemon immediately.
5. **Server DMs the user**:
   `✅ Paired this machine ("MacBook-Pro-6"). Mention me in any thread to start.`
   If `revoked_previous > 0`: adds
   *"Your previously paired machine(s) have been revoked — each Slack
   user has one paired machine at a time."*
6. **First connection**: daemon mints a JWT, opens WebSocket to
   `wss://.../ws` with `Authorization: Bearer <jwt>`, server accepts,
   inserts into `activeConnections`. Ready.

### Re-pairing (already-paired user)

Same flow. The `install` trigger works regardless of whether the user
has an existing machine; the revoke-on-pair step in (4c) ensures the
new machine cleanly replaces any old one. This is also the recovery
path for a lost / stolen machine — just pair a new one.

## Server↔machine transport

### Connection

`wss://<server>/ws` — long-lived WebSocket, one per profile per machine.

### Auth (handshake — JWT/EdDSA, RFC 7519 + RFC 8037)

**Client → server, on upgrade:**

```
Authorization: Bearer <jwt>

JWT payload: { "sub": "<machine_id>", "iat": <now>, "exp": <now+5m>, "jti": "<random>" }
JWT header:  { "alg": "EdDSA", "typ": "JWT" }
Signed with the machine's Ed25519 private key.
```

Server peeks at `sub`, fetches `public_key` from Postgres, runs
`jwtVerify` (using the `jose` library). Rejects on bad signature,
expired, missing claims, or `jti` already in `seenJtis` (replay).

**Server → client, first message after upgrade:**

```json
{
  "type": "server_hello",
  "jwt": "<JWT signed by server's Ed25519 key, includes nonce client sent>",
  "server_id": "<opaque>"
}
```

Client verifies against `pinned-server-key.pub`. On mismatch, disconnect
+ error log + (operator alarm).

After both directions are authenticated at handshake time, the TLS
channel's integrity is trusted for the rest of the connection. **No
per-message signatures.**

### Message envelope (after handshake)

Plain JSON over WSS. All messages have a `type` field. Optional `id`
field for request/response correlation.

**Server → client:**

```json
{ "type": "slack_event",
  "event": { "kind": "app_mention", "user_id": "U…", "channel_id": "C…",
             "thread_ts": "…", "trigger_msg_ts": "…", "text": "…", "event_id": "Ev…" } }

{ "type": "slack_rpc_response",
  "id": "req-1234",
  "result": { "ts": "1697059201.000200" } }    // or "error": "…"

{ "type": "migrate",
  "new_url": "wss://onprem.example.com/ws" }

{ "type": "update_available",
  "version": "0.4.1" }

{ "type": "ping" }                              // 30s heartbeat
```

**Client → server:**

```json
{ "type": "slack_rpc_request",
  "id": "req-1234",
  "method": "postReply",
  "params": { "channel": "C…", "thread_ts": "…", "text": "…" } }

{ "type": "event_ack",
  "event_id": "Ev…" }                          // optional, for log/metric correlation

{ "type": "pong" }                              // reply to server's ping

{ "type": "version",
  "current": "0.3.0" }                          // sent on connect
```

### Reconnect strategy (machine)

- Backoff: exponential, 1s → 2s → 4s → 8s → … capped at 60s.
- Reset to 1s after a successful connection.
- On disconnect with code `4403` (auth fail) or `4404` (unknown machine),
  do NOT retry; log + exit with "this machine has been unpaired or
  revoked; re-pair to continue."

### Slack RPC inventory

The server implements one RPC per Slack API call the orchestrator uses.
This is the entire surface area:

| RPC method | Arguments | Returns |
|---|---|---|
| `postReply` | channel, thread_ts, text | `{ ts }` |
| `editMessage` | channel, ts, text | `{}` |
| `deleteMessage` | channel, ts | `{}` |
| `addReaction` | channel, ts, name | `{}` |
| `removeReaction` | channel, ts, name | `{}` |
| `permalink` | channel, ts | `{ url }` |
| `getThread` | channel, thread_ts, time_zone | `{ raw, rendered }` (server does the same `conversations.replies` + `users.info` work the Phase A `fetchThread` does) |
| `downloadFile` | file_id | `{ data: <base64> }` (server fetches from Slack with bot token, returns binary inline; machine writes to `data/attachments/`) |

Server-side method catalogue is fully closed; unknown methods return an
error. No reflection or dynamic dispatch.

## Discovery indirection

`/discover` is a plain HTTPS endpoint on the same relay server:

```
GET https://<server-host>/discover
```

```json
{ "primary": "https://<server-host>/ws" }
```

- `Cache-Control: no-cache` to defeat ISP caching of the response body.
- **Not signed.** Server identity is established at WebSocket handshake
  against the machine's pinned server key; a MITM that redirected the
  discovery response couldn't authenticate as the real server anyway.
- Living on the same process as the WebSocket server keeps the deploy
  story single-binary. In the migration playbook below, the old backend
  keeps serving `/discover` (pointing at the new backend's WS URL) until
  every machine has moved.

### Client URL resolution order

```
1. In-band migrate signal     — instant for live clients
2. Persisted serverUrl        — from config.json (last known good)
3. Discovery fetch            — only if (2) fails to connect; also
                                 re-checked on every reconnect to
                                 self-heal stale config
```

The `serverUrl` a machine was paired with is the URL it hits for
discovery. During a backend migration the old URL must remain reachable
(at least for `/discover`) long enough to redirect its machines to the
new one — see the migration playbook.

## Auto-update (U1: npm)

### When updates happen

- On daemon startup (cold): `npm view @nikitiuk0/claude-slackbot version`,
  compare to installed, install + restart if newer.
- During runtime: server pushes `update_available` when it has detected
  a new published version.
- Updates are **deferred while any orchestrator job is in progress**;
  daemon waits until idle (state == `done`/`errored` for all profiles)
  before swapping.

### How updates happen

1. Daemon receives `update_available { version: "0.4.1" }`.
2. Daemon waits for "all profiles idle" (no `running` jobs).
3. `npm pack @nikitiuk0/claude-slackbot@0.4.1` into a temp dir; verify
   tarball published-by matches the configured npm account
   (`nikitiuk0`).
4. Atomic-swap node_modules (or for npx, prime the npm cache and
   re-exec).
5. Daemon `process.exit(0)`; the OS auto-start (launchd / systemd) brings
   it back, picking up the new code.

### Trust controls

- **Allowed publisher**: the package's `_npmUser` is checked against an
  allowlist in the daemon's compiled-in config. Mismatch = refuse update,
  log warning, surface alarm via Slack DM.
- **Min version pin**: server can include `min_client_version` in the
  discovery response (or via dedicated message); a daemon below that
  version refuses to operate and prints "please upgrade." Defends against
  rollback attacks.
- **Manual override**: `npx -y @nikitiuk0/claude-slackbot disable-auto-update`
  lets a paranoid user pin a version. They get explicit warnings on
  outdated software but the system still works.

## Multi-workspace via profiles

A single machine can pair against multiple servers (e.g. Tumblr internal
+ a personal sandbox). Each server gets its own profile.

### Profile lifecycle

```bash
# First profile: pair (becomes default automatically)
npx -y @nikitiuk0/claude-slackbot pair \
  --profile tumblr \
  --server https://claude-slackbot-xyz-uc.a.run.app \
  --code PAIR-…

# Second profile: pair against a different server
npx -y @nikitiuk0/claude-slackbot pair \
  --profile sandbox \
  --server https://localhost:8443 \
  --code PAIR-…

# List
npx -y @nikitiuk0/claude-slackbot profiles list

# Set default profile (used when --profile is omitted)
npx -y @nikitiuk0/claude-slackbot profiles default tumblr

# Unpair: triggers server-side revocation + local cleanup
npx -y @nikitiuk0/claude-slackbot unpair --profile sandbox

# Daemon (runs all profiles concurrently in one process)
npx -y @nikitiuk0/claude-slackbot start
```

### Process model

**Single daemon process, multiple profile workers.** Each profile is a
self-contained "ServerConnection + ServerAdapter + Orchestrator + state"
unit. Workers share **nothing** — disjoint sockets, disjoint state
directories, disjoint logs. Crash of one profile worker doesn't take down
the others; daemon restarts the failed worker.

### What server doesn't know

The server has no concept of profiles. From its side, each profile is
just "a machine." The fact that two paired-machine entries actually map to
the same physical machine on the operator's desk is invisible (and
uninteresting) to the server.

## Routing rules

For an incoming Slack `app_mention`:

1. Server-side dedupe by `event_id` (in-memory LRU, 5-min TTL).
2. Look up the user's active machine in Postgres (at most one row per
   `(workspace_id, user_id)` because pairing revokes prior machines).
   - 0 rows → trigger the **install flow**: post a short in-thread reply
     *"👋 You'll need to configure me on your machine first. Check
     your DMs for install instructions."* (🛠️ reaction), then issue a
     pairing code and DM the user the install command. The original
     mention isn't queued — user re-mentions after pairing.
   - 1 row → continue.
3. Check `userLiveMachines[workspace:user_id]` (currently connected).
   - Not connected → reply: *"Your machine isn't online. Reconnect and
     re-mention me to retry."* React 🚫. Nothing queued.
   - Connected → continue.
4. Send `slack_event` via that machine's WebSocket. Done.

The machine applies all of Phase A's behaviour from here: identity gate
becomes a no-op (server already gated by `(workspace, user_id)`), then
orchestrator does its single-flight, queue, watchdog, etc.

### What the server explicitly does NOT do

- Track which threads the machine is currently working on.
- Re-route in-flight work to a different machine.
- Persist or reorder events.
- Touch any other Phase A internals.

## Failure handling

| Failure | Detection | Server response |
|---|---|---|
| Machine disconnects mid-RPC | WS close while `pendingRpcs` non-empty | Mark RPC failed; the machine will retry on its next connect (orchestrator's executeJob will see runClaude exit and surface the error) |
| Slack API call fails inside an RPC | `WebClient` exception | Return `slack_rpc_response` with `error` field; machine's `RemoteSlackFacade` rejects the promise; orchestrator handles like any other Slack API error |
| Server restart while machines connected | Process exit | All WSes drop; machines reconnect with backoff; in-memory state rebuilds in seconds; no durable state lost |
| Slack delivers duplicate event | Same `event_id` | Dropped at server-side LRU before routing |
| JWT expired during long disconnect | `jwtVerify` throws | Machine mints a fresh one on reconnect; transparent |
| Machine's server pubkey doesn't match | Client check after `server_hello` | Disconnect, log, surface to user via console output (and on macOS, a Notification Center alert if technically feasible — nice-to-have) |
| Pairing code expired | `pairings.expires_at < now()` | `POST /pair` returns 410 Gone; machine CLI prints "Code expired; DM the bot for a new one." |
| Pairing code already consumed | `pairings.consumed_at IS NOT NULL` | `POST /pair` returns 409 Conflict; same message |
| Auto-update fails (npm down, integrity check fails) | `npm install` non-zero | Log, surface via Slack DM to operator, retry on next announce |
| Server's Postgres unreachable | Connection error | `503` on Slack events ack to Bolt → Bolt retries; server keeps trying to reconnect to DB; if down >5min, surface to operator alarm |
| Slack `files.download` fails (token lacks `files:read`, etc.) | API error | RPC returns `error`; machine renders the file as "[unavailable]" in thread context (same fallback as Phase A) |

## Tech stack

- **Runtime:** Node.js ≥20 (server and machine).
- **Language:** TypeScript (strict).
- **Server framework:** Fastify (small, fast, good WS support; plain HTTP for `/discover` and `/pair`). Bolt for Slack.
- **WebSocket:** `@fastify/websocket` server-side; native `ws` package on the machine.
- **JWT:** `jose` (Node-native crypto, EdDSA support, no deps).
- **Postgres client:** `pg` (boring, well-known); `drizzle-orm` for typed queries (optional but nice).
- **Migrations:** `drizzle-kit` or plain `node-pg-migrate`.
- **Container:** Distroless Node image (`gcr.io/distroless/nodejs20-debian12`).
- **Process manager on machine:** macOS `launchd`, Linux `systemd --user`.
  Plist/unit installed automatically by the `pair` command.
- **Logging:** `pino` everywhere (server has its own log file; each machine
  profile has its own).
- **Tests:** `vitest`. Integration tests for server use `pg-mem` or
  Testcontainers Postgres.

## Project layout

The Phase A code stays in this same repo. We add a `server/` directory
for the relay server and reorganise the machine side under `client/`.

```
slackbot/
├── package.json                         # workspaces: client, server
├── pnpm-workspace.yaml                  # or npm workspaces
├── tsconfig.json
├── client/                              # the npm-published package
│   ├── package.json                     # name: @nikitiuk0/claude-slackbot
│   ├── src/
│   │   ├── index.ts                     # CLI entry: pair / start / profiles / etc.
│   │   ├── cli/
│   │   │   ├── pair.ts
│   │   │   ├── start.ts
│   │   │   ├── profiles.ts
│   │   │   ├── unpair.ts
│   │   │   └── version.ts
│   │   ├── profile/
│   │   │   ├── manager.ts               # loads + supervises profiles
│   │   │   ├── home.ts                  # ~/.claude-slackbot resolution
│   │   │   └── config.ts                # zod-validated per-profile config
│   │   ├── identity/
│   │   │   ├── keypair.ts               # Ed25519 generation + load + perm check
│   │   │   └── jwt.ts                   # JWT mint/verify via jose
│   │   ├── transport/
│   │   │   ├── server-connection.ts     # WS lifecycle, reconnect, migrate
│   │   │   ├── server-adapter.ts        # replaces Phase A SlackAdapter
│   │   │   └── remote-slack-facade.ts   # replaces Phase A SlackClientFacade
│   │   ├── updater/
│   │   │   └── npm-updater.ts
│   │   ├── autostart/
│   │   │   ├── launchd.ts               # macOS plist install
│   │   │   └── systemd.ts               # Linux user unit install
│   │   └── core/                        # Phase A core, moved verbatim
│   │       ├── orchestrator.ts
│   │       ├── state/store.ts
│   │       ├── state/milestones.ts
│   │       ├── claude/runner.ts
│   │       ├── claude/stream-parser.ts
│   │       ├── prompt/build-input.ts
│   │       ├── prompt/system-prompt.txt
│   │       ├── slack/updater.ts          # EditCoalescer stays; facade is now interface only
│   │       ├── slack/attachments.ts      # AttachmentsStore stays
│   │       └── log.ts
│   └── tests/                           # mirrors src/
├── server/                              # the relay server
│   ├── package.json                     # name: @nikitiuk0/claude-slackbot-server (private)
│   ├── src/
│   │   ├── index.ts                     # Fastify bootstrap
│   │   ├── config.ts                    # env + zod
│   │   ├── log.ts                       # pino
│   │   ├── db/
│   │   │   ├── index.ts                 # pg pool
│   │   │   ├── schema.ts                # drizzle schema
│   │   │   ├── migrations/              # SQL migrations
│   │   │   ├── users.ts                 # repo functions
│   │   │   ├── machines.ts
│   │   │   └── pairings.ts
│   │   ├── slack/
│   │   │   ├── adapter.ts               # Bolt + Socket Mode
│   │   │   └── api.ts                   # WebClient wrapper used by RPCs
│   │   ├── pairing/
│   │   │   └── service.ts
│   │   ├── ws/
│   │   │   ├── gateway.ts               # @fastify/websocket
│   │   │   ├── auth.ts                  # JWT verify, server_hello mint
│   │   │   ├── connections.ts           # in-memory map + indexes
│   │   │   ├── router.ts                # event → machine selection
│   │   │   └── rpc-handler.ts           # Slack RPC method catalogue
│   │   ├── discovery/
│   │   │   └── handler.ts
│   │   └── update/
│   │       └── announcer.ts             # npm view loop + broadcast
│   ├── tests/
│   ├── Dockerfile
│   └── README.md                        # operator runbook
├── docs/
│   ├── manual-smoke-test-phase-b.md
│   └── superpowers/
│       ├── specs/
│       │   ├── 2026-04-19-claude-slackbot-design.md
│       │   └── 2026-04-20-phase-b-multi-user-design.md  ← this file
│       └── plans/…
└── slack-app-manifest.yaml              # unchanged from Phase A
```

The Phase A `src/` becomes `client/src/core/`. The shape of files inside
`core/` is preserved, just relocated.

## Configuration

### Server `.env` (operator-side, server-side)

```
# Slack
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…

# Postgres
DATABASE_URL=postgres://…

# Server identity
SERVER_PRIVATE_KEY_PATH=/var/secrets/server-ed25519.key
SERVER_PUBLIC_KEY_PATH=/var/secrets/server-ed25519.pub

# Public URLs the server announces in /discover and /pair
PUBLIC_SERVER_URL=https://claude-slackbot-xyz-uc.a.run.app
PUBLIC_WS_URL=wss://claude-slackbot-xyz-uc.a.run.app/ws

# Allowed npm publisher (for client auto-update validation)
ALLOWED_NPM_PUBLISHER=nikitiuk0

# Logging
LOG_LEVEL=info
LOG_FILE=/var/log/claude-slackbot-server.log
```

Secrets (Slack tokens, server private key, DB password) are mounted as
files / injected via secret manager — never in the image.

### Client config (already shown above) lives at `~/.claude-slackbot/profiles/<name>/config.json`.

## Slack app changes from Phase A

The manifest gains nothing required (existing scopes still work), but
gets one new `bot_event`:

- `message.im` (DMs to the bot — needed for `install` / `unpair` flows
  that happen in DMs).

The `app_mention` event is still the primary trigger. New scope only
because we need to read DM text.

## Deployment

### GCP MVP (single-instance)

**Choice: Cloud Run Job pinned to `min-instances=1, max-instances=1`,
with a Persistent Disk volume for the server private key.**

Why this over alternatives:

- **Cloud Run (regular service)**: not a fit. Slack Bolt's Socket Mode
  needs a long-lived outbound WS to Slack; Cloud Run scales to zero and
  may move pods unpredictably. We want exactly one instance.
- **Compute Engine VM**: works, but heavier ops (OS patching, you own
  more layers).
- **GKE Autopilot**: also works, more knobs than we need.

Cloud Run Job with `min=1 max=1` gives us: managed runtime, zero OS
patching, automatic restart on crash, simple deploy, and a single pinned
instance — which is what Bolt Socket Mode needs.

Postgres: **Cloud SQL Postgres 16, smallest tier** (`db-f1-micro` or
`db-g1-small`). Private IP, accessed via the Cloud SQL Proxy in the
container.

Secret manager: GCP Secret Manager for `SLACK_BOT_TOKEN`,
`SLACK_APP_TOKEN`, server private key, DB password.

Hostname: the Cloud Run service gets an auto-assigned URL like
`https://claude-slackbot-xyz-uc.a.run.app` — use that as the canonical
`PUBLIC_SERVER_URL` for MVP. A custom domain can be mapped later via
Cloud Run's domain mapping (or a Global HTTPS LB for more control).
The `/discover` indirection means switching to a custom domain, or
eventually to on-prem, doesn't require updating any client manually.

### On-prem path

Same container image, different runtime. Designed to be
infra-agnostic so the operator can move with minimal friction:

- **Container**: distroless Node image, ~70 MB. Runs identically on
  Cloud Run, GKE, or any docker host.
- **Postgres**: any Postgres 14+. On-prem: Tumblr's existing managed
  Postgres infra if available; otherwise a VM with `apt install
  postgresql`.
- **Secrets**: same files, different source — Kubernetes Secrets,
  HashiCorp Vault, or even a directory of files mounted from host.
- **TLS**: Cloud Run terminates TLS for us on GCP; on-prem we'd front
  the container with nginx / Caddy / a Tumblr-standard load balancer.

Everything in the spec works identically on both. The migration playbook
(below) is the actual switching procedure.

### Migration playbook (GCP → on-prem)

1. Stand up on-prem deployment at `https://claude-slackbot-onprem.example.com`.
   Same image, same DB schema, copied secrets.
2. Mirror Postgres from Cloud SQL → on-prem (logical replication, then
   freeze writes briefly, switch primary). Or: dump and restore for
   small enough data sets.
3. Update the GCP server's `/discover` response to point `primary` at
   the on-prem URL.
4. Run on-prem with the on-prem URL as its `PUBLIC_WS_URL`.
5. Operator runs `migrate-broadcast --new-url wss://onprem.../ws` on
   the GCP server. Live clients reconnect to on-prem. Total wall clock
   for live clients: seconds.
6. Wait 24 hours for stragglers (machines offline during migration) to
   come back. They hit the GCP discovery endpoint, get redirected to
   on-prem, reconnect there.
7. If a custom domain has been attached (e.g. `claude-slackbot.mycorp.com`),
   repoint its DNS record to on-prem. Accept a short propagation
   window — by now no real traffic is on the GCP URL, only stale-DNS
   cold-starts hitting a now-empty discovery endpoint. If no custom
   domain was ever attached (MVP uses the Cloud Run auto-URL directly):
   keep the GCP service alive long enough for all machines to have
   hit discovery at least once and persisted the new on-prem URL
   (the 24h in step 6 typically covers this), then skip this step.
8. Shut down GCP services + DB.

### Cost ballpark on GCP (for sizing intuition)

- Cloud Run Job: ~$10-30/month for `min=1` always-on with 0.5 vCPU + 512 MB.
- Cloud SQL `db-f1-micro` Postgres: ~$10/month + storage.
- Egress: trivial at expected scale.
- Secret Manager: pennies.

Total: **~$25-50/month for the MVP scale.** Negligible.

## Testing approach

### Unit tests (vitest)

Same discipline as Phase A: focus on pure-logic units, stub the I/O
boundaries.

- Server side:
  - `db/machines.ts`, `db/users.ts`, `db/pairings.ts` — repo functions
    against pg-mem or Testcontainers Postgres.
  - `pairing/service.ts` — happy path, expired code, double-claim,
    wrong-user code claim, revoke-previous-machine-on-new-pair
    transaction atomicity.
  - `ws/auth.ts` — JWT mint + verify, replay rejection, expired
    rejection.
  - `ws/router.ts` — routing decisions (no active machine → install
    flow; active but disconnected → reconnect reply; active and
    connected → forward).
  - `discovery/handler.ts` — config-driven response.
- Client side:
  - All Phase A tests survive verbatim (the orchestrator core didn't
    change).
  - New: `transport/server-connection.ts` (reconnect backoff, migrate
    handling, server pubkey pinning).
  - New: `transport/remote-slack-facade.ts` (RPC ↔ promise correlation,
    timeout, error propagation).
  - New: `identity/keypair.ts` (perm check, generation idempotence).
  - New: `profile/manager.ts` (start/stop/restart per profile, cross-
    profile isolation).

### Integration tests

- **Server end-to-end**: spin up Fastify with a Testcontainers
  Postgres, fake Bolt, fake WS clients. Drive a full pairing flow,
  then a routed Slack event, then a stop command, then disconnect.
- **Pair-end-to-end across boundaries**: stand up a server in one
  process and a daemon in another; pair them via a real WS;
  send a fake Slack event through; verify the daemon's orchestrator
  spawns a stub Claude and the result posts back via RPC. This is
  the most valuable test in the suite.

### Manual smoke

`docs/manual-smoke-test-phase-b.md`. Walks operator through:

1. Stand up the server (Cloud Run or local Docker).
2. Pair a machine. Verify install confirmation DM.
3. Mention from the paired user → verify routing, milestones,
   summary, PR link.
4. Disconnect daemon mid-run → verify Slack message updates with
   appropriate error.
5. Pair a second machine for the same user; verify route-to-most-
   recent.
6. Unpair via DM; verify no further events route.
7. Trigger an `update_available`; verify daemon waits for idle, then
   self-updates and reconnects.
8. Run two profiles on the same machine; verify isolation.
9. Run the migrate broadcast; verify clients move.

## Phase A → Phase B migration

Phase A users (currently: just you) get a single migration command:

```bash
npx -y @nikitiuk0/claude-slackbot pair \
  --profile tumblr \
  --server https://claude-slackbot-xyz-uc.a.run.app \
  --code <PAIR-from-DM>
```

This runs the new pair flow. On detection of a Phase A `data/` directory
in the *cwd from which `pair` was invoked*, it offers to migrate:

```
Detected Phase A state at /Users/me/work/ai/slackbot/data.
Copy session/milestone state into the new profile? [Y/n]
```

If yes: copies `state.json`, `milestones/`, `attachments/` into
`~/.claude-slackbot/profiles/tumblr/data/`. From that point, the new
daemon picks up exactly where Phase A left off, including in-progress
threads (which will be marked `interrupted` on the first orchestrator
run, same as Phase A's restart recovery).

The Phase A `npm run start` daemon should be stopped before pairing
(otherwise both daemons would race on the same Slack thread). The pair
command checks `lsof` / `pgrep` for a running Phase A process and warns
the user.

## Anti-scope (sweep, summarised)

- ❌ Multi-instance horizontal scaling (single server is enough at our
  size).
- ❌ Multi-region (single region is enough).
- ❌ Per-message signing (TLS + handshake JWT is enough).
- ❌ Web UI (CLI is enough).
- ❌ Per-mention permission relay to Slack.
- ❌ Cross-workspace routing (same workspace only for MVP, schema
  forward-compatible).
- ❌ Compiled binary distribution (npm only).
- ❌ Server-to-server federation.
- ❌ Stored Slack content of any kind, anywhere on the server.

## Open security questions (call-outs, not blockers)

These were considered, parked for now, worth revisiting before public
launch:

1. **npm publish account compromise.** Auto-update validates `_npmUser`
   against an allowlist, but that allowlist itself is in the running
   client. A determined attacker who got both npm publish access AND
   can push a fake-allowlist update could slip through. Mitigations
   later: code signing of releases (sigstore / cosign), out-of-band
   version pinning notifications.
2. **Server-side abuse of routing.** A bug in the router could send
   Alice's mention to Bob's machine. Mitigation: every routing query is
   filtered by `(workspace_id, user_id)` at the SQL level; tests
   enforce this; consider adding row-level security policies in
   Postgres post-MVP.
3. **Machine public key replacement.** If an attacker can write to a
   user's `keypair.json`, they can replace it and the next connection
   uses the attacker's key. We rely on OS file permissions (0600).
   Stronger: store private key in OS keychain (macOS Keychain, Linux
   Secret Service). Post-MVP work.
4. **DM spoofing in Slack.** The `install` / `unpair` flow trusts that
   the Slack `user_id` of the DM sender is correct. This is true under
   normal Slack guarantees. A workspace admin who hijacks an account
   could trigger pairing of a machine they control. Out of scope; same
   as Phase A.

## Roadmap (post-Phase B, separate specs)

- **Offline-machine queuing** with at-rest crypto (`crypto_box_seal`).
- **Per-mention permission relay** (interactive Slack approve/deny).
- **Web admin UI** for the operator (live ops view, revoke machines,
  see queue depth).
- **Cost tracking** per session via Anthropic billing integration.
- **launchd / systemd auto-install hardening** (signed plists,
  dependency on network being up).
- **Compiled binary distribution** (Homebrew tap, signed macOS .pkg).
- **Server key rotation** with dual-signing window.
- **Multi-region server** with leader election if scale demands.
- **Multi-workspace from a single server** (the schema supports it
  already; just need Slack app installed in multiple workspaces and
  config to associate tokens to workspace IDs).
