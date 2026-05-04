# Architecture

## How it works (the short version)

You **@-mention the bot in Slack** with a task. The task runs on **your own laptop**, using **your own Claude Code** — the same one you use day-to-day. Claude posts progress and results back in the Slack thread.

![Architecture overview](architecture-overview.svg)

**Why this design**

- **Your code never leaves your laptop.** The relay only forwards Slack messages back and forth.
- **One bot, many people.** The relay knows which laptop is paired to which Slack user, so your @mention only ever runs on *your* laptop — never anyone else's.
- **Encrypted, authenticated links.** Each laptop pairs once with a code; after that, every connection between the laptop and the relay is encrypted and cryptographically signed, so the relay can only deliver your events to the laptop you actually paired.
- **Same Claude you already have.** Same login, same access, same tools as when you run `claude` at your desk.
- **Works while you're away from your desk** (as long as your laptop is on and connected). Kick off a task from your phone in Slack, come back to the result.

**One-time setup**

1. Install the small daemon on your laptop (`npx @nikitiuk0/claude-slackbot pair …`).
2. The server gives you a short pairing code over Slack DM.
3. Once paired, your laptop stays connected to the relay so the bot knows where to send your tasks.

**What it is not**
- Not a hosted Claude. Anthropic's models are still called, but only from your laptop, just like when you run `claude` locally.
- Not a way for someone else to run code on your machine. Only tasks tied to *your* Slack user reach *your* laptop.
- Not always-on AI roaming your codebase. It only acts when you @-mention it.

---

## For engineers — system overview

The bot is a **two-tier relay**: a small always-on **server** brokers Slack events to one or more **clients** running on engineers' laptops, where the user's local `claude` CLI does the actual work. The server never executes Claude — it only routes events to the right paired machine.

### Components

```mermaid
flowchart LR
    subgraph Slack["Slack Workspace"]
        SlackAPI[("Slack API<br/>Socket Mode")]
    end

    subgraph Cloud["Server (Cloud Run, always-on)"]
        Fastify["Fastify HTTP<br/>+ WebSocket gateway"]
        SlackAdp["Slack adapter<br/>(Bolt Socket Mode)"]
        Pairing["Pairing service<br/>(POST /pair)"]
        Discover["Discovery<br/>(GET /discover)"]
        Router["WS router<br/>+ connection registry"]
        InstallDM["Install/unpair<br/>DM flow"]
        ServerKey[("Ed25519<br/>server keypair")]
        Postgres[("Postgres<br/>users · machines · pairings")]

        Fastify --- Pairing
        Fastify --- Discover
        Fastify --- Router
        SlackAdp --> InstallDM
        SlackAdp --> Router
        Pairing --> Postgres
        InstallDM --> Postgres
        Router --> Postgres
        Pairing --- ServerKey
        Router --- ServerKey
    end

    subgraph Laptop["Engineer's laptop (client daemon)"]
        CLI["claude-slackbot CLI<br/>pair · start · unpair · profiles"]
        Transport["WS transport<br/>(JWT-signed, pinned server key)"]
        Orchestrator["Orchestrator<br/>spawns claude subprocess<br/>streams milestones"]
        StateStore[("Local state<br/>~/.claude-slackbot/profiles/&lt;name&gt;/")]
        ClientKey[("Ed25519<br/>client keypair")]
        ClaudeCLI[["claude CLI<br/>(user's local install)"]]

        CLI --> Transport
        CLI --> Orchestrator
        Transport --> Orchestrator
        Orchestrator --> ClaudeCLI
        Orchestrator --> StateStore
        Transport --- ClientKey
    end

    NPM[("npm registry<br/>@nikitiuk0/claude-slackbot")]

    SlackAPI <-- "events / chat.postMessage" --> SlackAdp
    Transport <-- "WSS · slack_event / rpc" --> Router
    CLI -- "POST /pair" --> Pairing
    CLI -- "GET /discover" --> Discover
    CLI -- "auto-update check" --> NPM
```

**External dependencies**
- **Slack** — Socket Mode connection (`xapp-…`) for events; bot token (`xoxb-…`) for posting, reactions, opening DMs
- **Claude Code CLI** — invoked as a subprocess by the client; inherits the user's auth, MCP servers, and skills
- **npm registry** — client checks for updates against `ALLOWED_NPM_PUBLISHER`
- **Postgres** — server-side persistence (local dev: [docker-compose.yml](../docker-compose.yml) on `127.0.0.1:5433`)

## Pairing flow (Phase B)

```mermaid
sequenceDiagram
    actor User
    participant SlackAPI as Slack
    participant Server
    participant DB as Postgres
    participant Client as Client CLI

    User->>SlackAPI: DM bot "pair"
    SlackAPI->>Server: message.im event
    Server->>DB: INSERT pairings(code=PAIR-XXXX, expires_at)
    Server->>SlackAPI: chat.postMessage (DM with PAIR-XXXX)
    SlackAPI->>User: "Run: npx … pair --code PAIR-XXXX"

    User->>Client: npx … pair --code PAIR-XXXX --server <url>
    Client->>Client: generate Ed25519 keypair
    Client->>Server: POST /pair {code, public_key}
    Server->>DB: validate code, INSERT machines, mark consumed
    Server-->>Client: {machine_id, server_public_key}
    Client->>Client: persist profile + pinned server key
```

## Mention / task flow

```mermaid
sequenceDiagram
    actor User
    participant SlackAPI as Slack
    participant Server
    participant DB as Postgres
    participant Client
    participant Claude as claude CLI

    User->>SlackAPI: @bot <task> (channel or thread)
    SlackAPI->>Server: app_mention event
    Server->>DB: lookup machine for (workspace, user)
    alt no active machine
        Server->>SlackAPI: DM install instructions
    else paired
        Server->>Client: WS slack_event
        Client->>SlackAPI: fetch thread + attachments
        Client->>Claude: spawn subprocess with prompt
        loop streamed output
            Claude-->>Client: milestone line
            Client->>SlackAPI: chat.postMessage / update (coalesced)
        end
        Client->>Client: persist thread state (session_id, status)
    end
```

Stop / nudge / reset commands follow the same path: `app_mention` → server → client, where the orchestrator signals or kills the running subprocess. Thread state stays on disk so a session can be resumed.

## Storage

| Where | What |
|---|---|
| Server Postgres | `users`, `machines` (machine_id, public_key, status, last_seen_at), `pairings` (code, expires_at, consumed_at) |
| Client `~/.claude-slackbot/profiles/<name>/` | `config.json`, `identity/keypair.json`, `identity/machine_id`, pinned server key, `state.json` (per-thread session_id + status), `milestones/<session>.jsonl`, `attachments/<threadTs>/` |

## Auth

- **WebSocket**: client signs a JWT with its Ed25519 private key and presents it on upgrade; server verifies against the public key stored at pair time. JTI cache prevents replay.
- **Pairing endpoint**: short-lived `PAIR-XXXX` code, single use, scoped to one Slack `(workspace, user)`.
- **Server identity**: client pins the server's public key on first pair so a swapped server can't impersonate.
- **Slack**: Socket Mode app-level token + bot token; no per-user Slack OAuth.

---

Key files: [server/src/index.ts](../server/src/index.ts), [server/src/ws/router.ts](../server/src/ws/router.ts), [server/src/db/schema.ts](../server/src/db/schema.ts), [client/src/core/orchestrator.ts](../client/src/core/orchestrator.ts), [client/src/cli/pair.ts](../client/src/cli/pair.ts), [slack-app-manifest.yaml](../slack-app-manifest.yaml), [docker-compose.yml](../docker-compose.yml).
