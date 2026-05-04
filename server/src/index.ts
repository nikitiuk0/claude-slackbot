import { config as loadDotEnv } from "dotenv";
import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createPool, migrate } from "./db/pool.js";
import { loadServiceKey } from "./identity/service-key.js";
import { registerDiscovery } from "./discovery/handler.js";

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

  registerDiscovery(app, { publicWsUrl: cfg.publicWsUrl });

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  log.info({ port: cfg.port }, "listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
