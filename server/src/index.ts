import { mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { config as loadDotEnv } from "dotenv";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { openDb, migrate } from "./db/pool.js";
import { loadServiceKey } from "./identity/service-key.js";
import { createJwtSigner, InMemoryJtiStore } from "./identity/jwt.js";
import { registerPairRoute } from "./pairing/route.js";
import { ConnectionRegistry } from "./ws/connections.js";
import { registerWsGateway } from "./ws/gateway.js";
import { startUpdateAnnouncer } from "./update/announcer.js";
import { SlackAdapter } from "./slack/adapter.js";
import { routeSlackEvent } from "./ws/router.js";
import { runInstallFlow } from "./install-dm/flow.js";
import { createMetrics } from "./metrics/registry.js";
import { registerMetricsRoutes } from "./metrics/handler.js";

async function main() {
  loadDotEnv();
  const cfg = loadConfig(process.env);
  const log = createLogger({ level: cfg.logLevel, logFile: cfg.logFile });
  log.info({ port: cfg.port }, "claude-slackbot server starting");

  const dbPath = resolvePath(cfg.databasePath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  migrate(db);
  log.info({ path: dbPath }, "sqlite ready");

  const serviceKey = await loadServiceKey({
    privatePath: cfg.serverPrivateKeyPath,
    publicPath: cfg.serverPublicKeyPath,
  });
  log.info({ kid: serviceKey.publicKeyJwk.x?.slice(0, 8) }, "server identity loaded");

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  const registry = new ConnectionRegistry();
  const serverSigner = createJwtSigner({ privateKey: serviceKey.privateKey });
  const jtiStore = new InMemoryJtiStore();
  const metrics = createMetrics();

  registerMetricsRoutes(app, metrics);
  registerPairRoute(app, {
    db,
    publicWsUrl: cfg.publicWsUrl,
    serverPublicKeyJwk: serviceKey.publicKeyJwk,
    metrics,
  });
  let slackAdapter: SlackAdapter;

  registerWsGateway(app, {
    db,
    registry,
    jtiStore,
    serverSigner,
    metrics,
    log,
    get slackApi() { return slackAdapter?.client(); },
    get botToken() { return cfg.slackBotToken; },
  });

  const stopAnnouncer = startUpdateAnnouncer({
    registry,
    packageName: "@nikitiuk0/claude-slackbot",
    log,
  });

  slackAdapter = new SlackAdapter({
    botToken: cfg.slackBotToken,
    appToken: cfg.slackAppToken,
    onEvent: async (event) => {
      try {
        metrics.slackEventsTotal.inc({ kind: event.kind });
        await routeSlackEvent({
          db, registry,
          slack: {
            postReply: async (channel, threadTs, text) => {
              await slackAdapter.client().chat.postMessage({ channel, thread_ts: threadTs, text });
            },
            addReaction: async (channel, ts, name) => {
              try { await slackAdapter.client().reactions.add({ channel, timestamp: ts, name }); }
              catch (err: any) {
                if (err?.data?.error !== "already_reacted" && err?.data?.error !== "invalid_name") throw err;
              }
            },
          },
          installFlow: async (e) => {
            await runInstallFlow({
              db,
              slack: {
                postDm: async (userId, text) => {
                  const im = await slackAdapter.client().conversations.open({ users: userId });
                  const channel = im?.channel?.id;
                  if (!channel) throw new Error("couldn't open DM");
                  await slackAdapter.client().chat.postMessage({ channel, text });
                },
                postReply: async (channel, threadTs, text) => {
                  await slackAdapter.client().chat.postMessage({ channel, thread_ts: threadTs, text });
                },
                addReaction: async (channel, ts, name) => {
                  try { await slackAdapter.client().reactions.add({ channel, timestamp: ts, name }); }
                  catch (err: any) {
                    if (err?.data?.error !== "already_reacted" && err?.data?.error !== "invalid_name") throw err;
                  }
                },
              },
              publicServerUrl: cfg.publicServerUrl,
              npmPackage: "@nikitiuk0/claude-slackbot",
              readmeUrl: "https://github.com/nikitiuk0/claude-slackbot#readme",
              event: e,
            });
            metrics.pairingsCreatedTotal.inc();
          },
          event,
        });
      } catch (err) {
        log.error({ err }, "routeSlackEvent failed");
      }
    },
    onError: (err) => log.error({ err }, "slack adapter error"),
  });
  await slackAdapter.start();

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  log.info({ port: cfg.port }, "listening");

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    stopAnnouncer();
    try { await slackAdapter.stop(); } catch {}
    try { await app.close(); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
