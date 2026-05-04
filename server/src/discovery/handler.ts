import type { FastifyInstance } from "fastify";

export function registerDiscovery(app: FastifyInstance, opts: { publicWsUrl: string }) {
  app.get("/discover", async (_req, reply) => {
    reply.header("Cache-Control", "no-cache");
    return { primary: opts.publicWsUrl };
  });
}
