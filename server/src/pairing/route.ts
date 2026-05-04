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
    let jwk: { kty?: unknown; crv?: unknown; x?: unknown };
    try {
      const decoded = Buffer.from(parsed.data.machine_public_key, "base64").toString("utf8");
      jwk = JSON.parse(decoded);
    } catch {
      return reply.code(400).send({ error: "machine_public_key must be base64-encoded JWK JSON" });
    }
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || jwk.x.length === 0) {
      return reply.code(400).send({ error: "machine_public_key must be an Ed25519 OKP JWK" });
    }
    const pubKeyBytes = Buffer.from(JSON.stringify(jwk), "utf8");
    try {
      const { machineId, revokedPrevious } = await claimPairing(deps.pool, {
        code: parsed.data.code,
        publicKey: pubKeyBytes,
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
