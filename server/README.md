# claude-slackbot relay server — operator runbook

The relay server holds the Slack tokens and fans messages out over authenticated WebSocket connections to each user's paired client daemon. It can run anywhere that supports a long-lived Node.js process; reverse proxies (nginx, Caddy, Cloudflare, internal A8C-style proxies, …) are explicitly supported.

Storage is a single SQLite file. There is no external database to provision.

---

## 1. Prerequisites

- **Node.js 22+** (only needed at build/dev time — production runs on `gcr.io/distroless/nodejs24-debian12`).
- **Slack workspace** with a custom app in Socket Mode (the server holds the bot + app tokens).
- A host that can keep a process alive 24/7 (Bolt Socket Mode needs a persistent outbound WebSocket to Slack).
- A persistent volume for the SQLite database.

---

## 2. Generate the service keypair (one-time bootstrap)

The server signs JWTs and authenticates to clients using an Ed25519 keypair.

```bash
# From repo root:
tsx -e "
import { generateAndSaveServiceKey } from './server/src/identity/service-key.js';
await generateAndSaveServiceKey({
  privatePath: './data/server-ed25519.key',
  publicPath:  './data/server-ed25519.pub',
});
console.log('done');
"
```

This writes `./data/server-ed25519.key` (mode 0600) and `./data/server-ed25519.pub` (mode 0644). Store the private key in your secret manager and set `SERVER_PRIVATE_KEY_PATH` / `SERVER_PUBLIC_KEY_PATH` accordingly. The public key is safe to expose — it is returned to clients on `/pair` so they can pin it.

---

## 3. Storage

SQLite. Schema lives in `server/src/db/migrations/0001_init.sql` and is bundled into the image; the server runs it idempotently on every startup.

Set `DATABASE_PATH` to a file on a persistent volume (e.g. `/var/lib/claude-slackbot/db.sqlite`). The default is `./data/claude-slackbot.sqlite` relative to the working directory.

WAL journaling is enabled on open, so a single sidecar volume is enough — no separate DB instance to run or back up.

---

## 4. Environment variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | `xoxb-…` bot user OAuth token |
| `SLACK_APP_TOKEN` | yes | `xapp-…` Socket Mode app token (`connections:write`) |
| `SERVER_PRIVATE_KEY_PATH` | yes | Path to the Ed25519 private key (JWK JSON) |
| `SERVER_PUBLIC_KEY_PATH` | yes | Path to the Ed25519 public key |
| `PUBLIC_SERVER_URL` | yes | Public HTTPS URL of this server (used in DM install instructions) |
| `PUBLIC_WS_URL` | yes | Public WSS URL clients connect to (`wss://host/ws`) |
| `ALLOWED_NPM_PUBLISHER` | yes | npm username whose client publishes are trusted for auto-update |
| `DATABASE_PATH` | no | Path to the SQLite file. Defaults to `./data/claude-slackbot.sqlite` |
| `PORT` | no | HTTP listen port. Defaults to `8443` |
| `LOG_LEVEL` | no | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal`. Defaults to `info` |
| `LOG_FILE` | no | Optional path to a JSONL log file mirroring stdout |

A complete annotated example lives at `.env.example` in the repo root.

---

## 5. HTTP endpoints

| Path | Purpose |
|---|---|
| `POST /pair` | Consume a pairing code; return `machine_id`, server public key (pinned by clients), `ws_url` |
| `GET /ws` | Authenticated WebSocket gateway (Bearer JWT signed by the machine private key) |
| `GET /healthz` | Liveness probe — `200 {"status":"ok"}` |
| `GET /metrics` | Prometheus scrape endpoint |

Exposed metrics (in addition to default node/process metrics):

- `ws_connections` (gauge) — currently connected clients
- `ws_connections_total` (counter)
- `ws_close_total{code}` (counter) — close codes bucketed (4401/4403/4404/…)
- `slack_events_total{kind}` (counter)
- `slack_rpc_total{method,status}` (counter)
- `pairings_created_total` / `pairings_consumed_total`

---

## 6. Deployment

### As a plain container

```bash
docker build -f server/Dockerfile -t claude-slackbot-server:latest .
docker run -d --name claude-slackbot-server \
  -p 8443:8443 \
  -v /srv/claude-slackbot/data:/app/data \
  --env-file ./server.env \
  claude-slackbot-server:latest
```

### Behind a reverse proxy (recommended)

Front the service with whatever reverse proxy you already operate (nginx, Caddy, Cloudflare, an internal proxy, etc.). The server reads `X-Forwarded-For` for log lines only — there is no proxy-trust setting to flip; client IPs are auto-detected and logged as `203.0.113.5 (via 10.0.0.7)` when a proxy is present, or as the direct peer IP when not.

The proxy is recommended for production: it dramatically reduces the public attack surface (TLS termination, IP allowlists / WAFs, request rate limiting) on a service that — once compromised — can dispatch commands to every paired laptop.

The proxy must allow WebSocket upgrades on the `/ws` path and forward the `Authorization` header.

### Cloud Run (or similar always-on container hosts)

```bash
gcloud run deploy claude-slackbot-server \
  --image=gcr.io/<PROJECT>/claude-slackbot-server:latest \
  --region=us-central1 \
  --min-instances=1 --max-instances=1 \
  --set-secrets="SLACK_BOT_TOKEN=slack-bot-token:latest,..." \
  --port=8443
```

`--min-instances=1 --max-instances=1` is mandatory — Bolt Socket Mode keeps a persistent outbound WebSocket open to Slack, so request-based scale-to-zero would drop the connection.

For SQLite persistence on Cloud Run, mount a Cloud Storage FUSE volume or attach a persistent disk via the Cloud Run jobs/services persistent-volume integration; do not rely on the local container filesystem.

---

## 7. Slack app setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**.
2. Paste `slack-app-manifest.yaml` from the repo root.
3. Enable **Socket Mode** and generate an `xapp-…` App-Level Token with `connections:write` scope.
4. Under **OAuth & Permissions**, install the app to your workspace and copy the `xoxb-…` Bot User OAuth Token.
5. Wire both tokens into your secret manager and reference them via the env vars above.

The bot does **not** require a public inbound URL from Slack — Socket Mode is purely outbound.
