import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { JWK } from "jose";
import { claimPairing, ClaimError } from "./service.js";

const Body = z.object({
  code: z.string().min(1),
  machine_public_key: z.string().min(1), // base64
  label: z.string().max(200).optional(),
});

export function registerPairRoute(
  app: FastifyInstance,
  deps: { pool: Pool; publicWsUrl: string; serverPublicKeyJwk: JWK }
) {
  app.post("/pair", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", detail: parsed.error.issues });
    }
    const pub = Buffer.from(parsed.data.machine_public_key, "base64");
    if (pub.length !== 32) {
      return reply.code(400).send({ error: "machine_public_key must be 32 bytes (Ed25519)" });
    }
    try {
      const { machineId, revokedPrevious } = await claimPairing(deps.pool, {
        code: parsed.data.code,
        publicKey: pub,
        label: parsed.data.label,
      });
      return {
        machine_id: machineId,
        server_public_key: deps.serverPublicKeyJwk,
        ws_url: deps.publicWsUrl,
        revoked_previous: revokedPrevious,
      };
    } catch (err) {
      if (err instanceof ClaimError) {
        const code = err.code === "unknown" ? 404 : err.code === "expired" ? 410 : 409;
        return reply.code(code).send({ error: err.message });
      }
      throw err;
    }
  });
}
