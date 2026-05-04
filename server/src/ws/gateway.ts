import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { WebSocket } from "ws";
import { importJWK, type KeyLike } from "jose";
import { createJwtVerifier, type JtiStore, type JwtSigner } from "../identity/jwt.js";
import type { ConnectionRegistry } from "./connections.js";
import * as machines from "../db/machines.js";

type Deps = {
  pool: Pool;
  registry: ConnectionRegistry;
  jtiStore: JtiStore;
  serverSigner: JwtSigner;
};

export function registerWsGateway(app: FastifyInstance, deps: Deps) {
  const verifier = createJwtVerifier({ store: deps.jtiStore });

  app.get("/ws", { websocket: true }, async (socket, req) => {
    const ws = socket as unknown as WebSocket;
    const header = (req.headers["authorization"] ?? req.headers["Authorization"]) as string | undefined;
    if (!header || !header.startsWith("Bearer ")) {
      ws.close(4401, "missing Authorization");
      return;
    }
    const jwt = header.slice("Bearer ".length);

    // Peek at sub without verifying — we need to look up the pubkey first.
    const parts = jwt.split(".");
    const bodyB64 = parts[1];
    if (!bodyB64) { ws.close(4401, "malformed JWT"); return; }
    let sub: string;
    try {
      const body = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8"));
      sub = body.sub;
    } catch {
      ws.close(4401, "malformed JWT body"); return;
    }
    if (typeof sub !== "string") { ws.close(4401, "missing sub"); return; }

    let machine;
    try {
      machine = await machines.findActiveById(deps.pool, sub);
    } catch {
      machine = null;
    }
    if (!machine) {
      ws.close(4404, "unknown or revoked machine");
      return;
    }
    let pubKey: KeyLike;
    try {
      const jwk = JSON.parse(machine.publicKey.toString("utf8"));
      pubKey = (await importJWK(jwk, "EdDSA")) as KeyLike;
    } catch {
      ws.close(4500, "corrupt public_key"); return;
    }

    try {
      await verifier.verify(jwt, pubKey);
    } catch (err: any) {
      ws.close(4403, `auth failed: ${err.message}`);
      return;
    }

    // Accepted. Send server_hello, register connection.
    const helloJwt = await deps.serverSigner.sign({
      iss: "claude-slackbot-server",
      sub: "server",
      exp_seconds: 60,
      extra: { machine_id: machine.machineId },
    });
    ws.send(JSON.stringify({ type: "server_hello", jwt: helloJwt }));

    const conn = {
      machineId: machine.machineId,
      workspaceId: machine.slackWorkspaceId,
      userId: machine.slackUserId,
      socket: ws,
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
    };
    deps.registry.add(conn);

    ws.on("close", () => deps.registry.remove(machine.machineId));
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === "pong") conn.lastPingAt = Date.now();
        // Other message types handled by the RPC handler (Phase 5).
      } catch { /* ignore malformed */ }
    });
    void machines.touchLastSeen(deps.pool, machine.machineId);
  });
}
