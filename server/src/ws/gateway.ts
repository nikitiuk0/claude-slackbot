import type { FastifyInstance } from "fastify";
import type { Db } from "../db/pool.js";
import type { WebSocket } from "ws";
import { importJWK, type KeyLike } from "jose";
import { createJwtVerifier, type JtiStore, type JwtSigner } from "../identity/jwt.js";
import type { ConnectionRegistry } from "./connections.js";
import * as machines from "../db/machines.js";
import { handleRpcRequest } from "./rpc-handler.js";
import type { Metrics } from "../metrics/registry.js";
import { clientAddr } from "../log-utils/client-addr.js";
import type { Logger } from "../log.js";

type Deps = {
  db: Db;
  registry: ConnectionRegistry;
  jtiStore: JtiStore;
  serverSigner: JwtSigner;
  slackApi?: any;
  botToken?: string;
  metrics?: Metrics;
  log?: Logger;
};

function recordClose(deps: Deps, code: number) {
  deps.metrics?.wsCloseTotal.inc({ code: String(code) });
}

export function registerWsGateway(app: FastifyInstance, deps: Deps) {
  const verifier = createJwtVerifier({ store: deps.jtiStore });

  app.get("/ws", { websocket: true }, async (socket, req) => {
    const ws = socket as unknown as WebSocket;
    const peer = clientAddr(req);
    const header = (req.headers["authorization"] ?? req.headers["Authorization"]) as string | undefined;
    if (!header || !header.startsWith("Bearer ")) {
      ws.close(4401, "missing Authorization");
      recordClose(deps, 4401);
      return;
    }
    const jwt = header.slice("Bearer ".length);

    // Peek at sub without verifying — we need to look up the pubkey first.
    const parts = jwt.split(".");
    const bodyB64 = parts[1];
    if (!bodyB64) { ws.close(4401, "malformed JWT"); recordClose(deps, 4401); return; }
    let sub: string;
    try {
      const body = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8"));
      sub = body.sub;
    } catch {
      ws.close(4401, "malformed JWT body"); recordClose(deps, 4401); return;
    }
    if (typeof sub !== "string") { ws.close(4401, "missing sub"); recordClose(deps, 4401); return; }

    let machine;
    try {
      machine = machines.findActiveById(deps.db, sub);
    } catch {
      machine = null;
    }
    if (!machine) {
      ws.close(4404, "unknown or revoked machine");
      recordClose(deps, 4404);
      return;
    }
    let pubKey: KeyLike;
    try {
      const jwk = JSON.parse(machine.publicKey.toString("utf8"));
      pubKey = (await importJWK(jwk, "EdDSA")) as KeyLike;
    } catch {
      ws.close(4500, "corrupt public_key"); recordClose(deps, 4500); return;
    }

    try {
      await verifier.verify(jwt, pubKey);
    } catch (err: any) {
      ws.close(4403, `auth failed: ${err.message}`);
      recordClose(deps, 4403);
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

    deps.log?.info({ machine_id: machine.machineId, client: peer }, "ws connected");
    deps.metrics?.wsConnections.inc();
    deps.metrics?.wsConnectionsTotal.inc();

    const conn = {
      machineId: machine.machineId,
      workspaceId: machine.slackWorkspaceId,
      userId: machine.slackUserId,
      socket: ws,
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
    };
    deps.registry.add(conn);

    ws.on("close", (code) => {
      deps.registry.remove(machine.machineId);
      deps.metrics?.wsConnections.dec();
      recordClose(deps, code);
      deps.log?.info({ machine_id: machine.machineId, client: peer, code }, "ws disconnected");
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === "pong") {
          conn.lastPingAt = Date.now();
        } else if (msg.type === "slack_rpc_request" && typeof msg.id === "string") {
          void (async () => {
            if (!deps.slackApi || !deps.botToken) {
              ws.send(JSON.stringify({
                type: "slack_rpc_response",
                id: msg.id,
                error: { message: "server slack client not configured" },
              }));
              return;
            }
            try {
              const result = await handleRpcRequest({
                slackClient: deps.slackApi,
                botToken: deps.botToken,
                method: msg.method,
                params: msg.params ?? {},
              });
              ws.send(JSON.stringify({ type: "slack_rpc_response", id: msg.id, result }));
              deps.metrics?.slackRpcTotal.inc({ method: String(msg.method ?? "unknown"), status: "ok" });
            } catch (err: any) {
              ws.send(JSON.stringify({
                type: "slack_rpc_response",
                id: msg.id,
                error: { message: err?.message ?? String(err), code: err?.data?.error },
              }));
              deps.metrics?.slackRpcTotal.inc({ method: String(msg.method ?? "unknown"), status: "error" });
            }
          })();
        }
      } catch { /* ignore malformed */ }
    });
    machines.touchLastSeen(deps.db, machine.machineId);
  });
}
