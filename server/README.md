# claude-slackbot server — operator runbook

> Phase B multi-user relay server. Clients pair via `npx @nikitiuk0/claude-slackbot pair`; the server holds the Slack tokens and fans messages out over authenticated WebSocket connections.

---

## 1. Prerequisites

- **Node.js 20** (build only — the container uses distroless/nodejs20).
- **Postgres 14+** reachable from the server process (Cloud SQL, RDS, on-prem).
- **GCP project** (or any container host that supports always-on long-lived processes). Cloud Run with `--min-instances=1 --max-instances=1` is the recommended target.
- **Slack workspace** with a custom app in Socket Mode (same as Phase A; the server now holds the tokens).

---

## 2. Generate the service keypair (one-time bootstrap)

The server signs JWTs and authenticates to clients using an Ed25519 keypair. Generate it once and keep the private key secret.

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

This writes `./data/server-ed25519.key` (mode 0600) and `./data/server-ed25519.pub` (mode 0644). Store the private key in Secret Manager (see §4) and set `SERVER_PRIVATE_KEY_PATH` / `SERVER_PUBLIC_KEY_PATH` accordingly. The public key is safe to expose — it is returned to clients on `/pair` so they can pin it.

---

## 3. Postgres setup

```sql
CREATE DATABASE claudeslackbot;
\c claudeslackbot
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

`pgcrypto` is also created automatically by the first migration, but creating it manually first avoids a race on shared Postgres instances. The full DDL lives in `server/src/db/migrations/0001_init.sql` and runs automatically on every server startup.

---

## 4. Environment variables / GCP Secret Manager

All sensitive values should be stored in GCP Secret Manager and mounted as environment variables (or files) at runtime.

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` bot user OAuth token from Slack app settings |
| `SLACK_APP_TOKEN` | `xapp-…` app-level token (Socket Mode) |
| `SERVER_PRIVATE_KEY_PATH` | Absolute path to the Ed25519 private key file (JWK JSON) |
| `SERVER_PUBLIC_KEY_PATH` | Absolute path to the Ed25519 public key file |
| `DATABASE_URL` | `postgres://user:pass@host:5432/dbname` |
| `PUBLIC_SERVER_URL` | Public HTTPS URL of this server (returned by `/discover`) |
| `PUBLIC_WS_URL` | Public WSS URL for clients (e.g. `wss://your-host/ws`) |
| `ALLOWED_NPM_PUBLISHER` | npm username whose client packages are trusted for auto-update |
| `PORT` | HTTP listen port (default `8443`) |
| `LOG_LEVEL` | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal` (default `info`) |

Recommended Secret Manager approach: store `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DATABASE_URL`, and the private key file content as secrets, then mount them as environment variables or volume files via Cloud Run secret references.

---

## 5. Deploy to Cloud Run

```bash
# Build and push the image
docker build -f server/Dockerfile -t gcr.io/<PROJECT>/claude-slackbot-server:latest .
docker push gcr.io/<PROJECT>/claude-slackbot-server:latest

# Deploy
gcloud run deploy claude-slackbot-server \
  --image=gcr.io/<PROJECT>/claude-slackbot-server:latest \
  --region=us-central1 \
  --min-instances=1 \
  --max-instances=1 \
  --set-secrets="SLACK_BOT_TOKEN=slack-bot-token:latest,..." \
  --port=8443
```

**Important:** Bolt Socket Mode requires a long-lived WebSocket connection to Slack — the process must stay alive. Set `--min-instances=1 --max-instances=1` (always-on, single instance). Cloud Run's request-based scale-to-zero will kill the Socket Mode connection; always-on prevents this.

---

## 6. Slack app setup

Same as Phase A:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**.
2. Paste `slack-app-manifest.yaml` from the repo root (the Phase B manifest adds the `message.im` event for DM-based install/unpair flows).
3. Enable **Socket Mode** under **Settings → Socket Mode** and generate an `xapp-…` App-Level Token with `connections:write` scope.
4. Under **OAuth & Permissions** → install the app to workspace and copy the `xoxb-…` Bot User OAuth Token.
5. Both tokens go into Secret Manager as above.

The bot does **not** require a public inbound URL — Socket Mode is purely outbound.

---

## 7. Migration playbook (server relocation)

Reference: [`docs/superpowers/specs/2026-04-20-phase-b-multi-user-design.md`](../docs/superpowers/specs/2026-04-20-phase-b-multi-user-design.md) §"Migration playbook (GCP → on-prem)" (lines 925-948).

Summary:

1. **Stand up the new server** at the new URL with same image + secrets + DB schema.
2. **Mirror Postgres**: logical replication or dump-and-restore, then freeze writes briefly and promote the replica.
3. **Update `/discover`** on the old server to return `primary: <new-url>`. Cold-starting clients will auto-redirect.
4. **Broadcast migrate** from the old server:
   ```bash
   tsx server/src/ops/migrate-broadcast.ts --new-url wss://<new-host>/ws
   ```
   Live clients reconnect to the new URL within seconds and persist the new URL in their local `config.json`.
5. Wait 24 h for offline machines to come back, hit discovery, and reconnect to the new server.
6. Shut down the old server and DB once traffic has drained.
