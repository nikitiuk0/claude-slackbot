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
  registerWsGateway(app, { pool, registry, jtiStore, serverSigner });

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

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  log.info({ port: cfg.port }, "listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
