import type { FastifyInstance } from "fastify";
import type { Metrics } from "./registry.js";

export function registerMetricsRoutes(app: FastifyInstance, metrics: Metrics) {
  app.get("/healthz", async (_req, reply) => {
    reply.header("Cache-Control", "no-cache");
    return { status: "ok" };
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", metrics.registry.contentType);
    reply.header("Cache-Control", "no-cache");
    return metrics.registry.metrics();
  });
}
