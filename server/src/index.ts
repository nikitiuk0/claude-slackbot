import { config as loadDotEnv } from "dotenv";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createPool, migrate } from "./db/pool.js";
import { loadServiceKey } from "./identity/service-key.js";
import { createJwtSigner, InMemoryJtiStore } from "./identity/jwt.js";
import { registerDiscovery } from "./discovery/handler.js";
import { registerPairRoute } from "./pairing/route.js";
import { ConnectionRegistry } from "./ws/connections.js";
import { registerWsGateway } from "./ws/gateway.js";
import { broadcastMigrate } from "./ws/broadcasts.js";
import { startUpdateAnnouncer } from "./update/announcer.js";
import { SlackAdapter } from "./slack/adapter.js";
import { routeSlackEvent } from "./ws/router.js";
import { runInstallFlow } from "./install-dm/flow.js";

async function main() {
  loadDotEnv();
  const cfg = loadConfig(process.env);
  const log = createLogger({ level: cfg.logLevel, logFile: cfg.logFile });
  log.info({ port: cfg.port }, "claude-slackbot server starting");

  const pool = createPool(cfg.databaseUrl);
  await migrate(pool);
  log.info("postgres migrations applied");

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

  registerDiscovery(app, { publicWsUrl: cfg.publicWsUrl });
  registerPairRoute(app, {
    pool,
    publicWsUrl: cfg.publicWsUrl,
    serverPublicKeyJwk: serviceKey.publicKeyJwk,
  });
  let slackAdapter: SlackAdapter;

  registerWsGateway(app, {
    pool,
    registry,
    jtiStore,
    serverSigner,
    get slackApi() { return slackAdapter?.client(); },
    get botToken() { return cfg.slackBotToken; },
  });

  const opsSecret = process.env.OPS_ADMIN_SECRET;
  if (opsSecret) {
    app.post("/ops/migrate", async (req, reply) => {
      if (req.headers["x-ops-admin"] !== opsSecret) return reply.code(403).send({ error: "forbidden" });
      const body = req.body as any;
      const newUrl = body?.new_url;
      if (typeof newUrl !== "string") return reply.code(400).send({ error: "missing new_url" });
      const count = broadcastMigrate(registry, newUrl);
      return { sent: count };
    });
  }

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
        await routeSlackEvent({
          pool, registry,
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
          installFlow: (e) => runInstallFlow({
            pool,
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
          }),
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
