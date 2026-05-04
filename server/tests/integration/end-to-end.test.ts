/**
 * End-to-end integration test:
 *   POST /pair  →  WS /ws (server_hello)  →  inject slack_event  →  slack_rpc_request  →  slack_rpc_response
 *
 * Uses pg-mem (no real Postgres) and a mock Slack client (no real Bolt).
 */

import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { newDb, DataType } from "pg-mem";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, exportJWK, importJWK, jwtVerify, SignJWT } from "jose";
import type { KeyLike } from "jose";
import WebSocket from "ws";

import { ConnectionRegistry } from "../../src/ws/connections.js";
import { registerWsGateway } from "../../src/ws/gateway.js";
import { registerPairRoute } from "../../src/pairing/route.js";
import { registerDiscovery } from "../../src/discovery/handler.js";
import { createJwtSigner, InMemoryJtiStore } from "../../src/identity/jwt.js";
import { routeSlackEvent } from "../../src/ws/router.js";
import * as users from "../../src/db/users.js";
import * as pairings from "../../src/db/pairings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInMemoryPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });
  mem.registerExtension("pgcrypto", () => {});
  const here = dirname(fileURLToPath(import.meta.url));
  mem.public.none(
    readFileSync(join(here, "..", "..", "src", "db", "migrations", "0001_init.sql"), "utf8")
  );
  return new (mem.adapters.createPg().Pool)();
}

function makeSlackApi() {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ts: "100.1" })),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      getPermalink: vi.fn(async () => ({ permalink: "https://slack/perm/x" })),
    },
    reactions: {
      add: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    },
    conversations: { replies: vi.fn(async () => ({ messages: [] })) },
    users: {
      info: vi.fn(async () => ({ user: { profile: { display_name: "alice" }, real_name: "Alice" } })),
    },
    files: { info: vi.fn(async () => ({ file: { url_private: "x" } })) },
  };
}

async function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(String(data)));
      } catch (e) {
        reject(e);
      }
    });
    ws.once("error", reject);
  });
}

async function mintClientJwt(privateKey: KeyLike, machineId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(machineId)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("End-to-end: pair + WS + RPC round-trip", () => {
  it("full pair + WS + RPC round-trip works end-to-end", async () => {
    // -----------------------------------------------------------------------
    // 1. Setup: in-memory DB + server keypair + Fastify app
    // -----------------------------------------------------------------------
    const pool = makeInMemoryPool();

    // Server EdDSA keypair (never written to disk)
    const serverKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const serverPublicKeyJwk = await exportJWK(serverKp.publicKey);
    const serverSigner = createJwtSigner({ privateKey: serverKp.privateKey });

    // Client (machine) EdDSA keypair — simulates the machine binary
    const clientKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const clientPubJwk = await exportJWK(clientKp.publicKey);
    const machinePubKeyB64 = Buffer.from(JSON.stringify(clientPubJwk), "utf8").toString("base64");

    // Mock Slack client (no real Bolt)
    const slackApi = makeSlackApi();

    // Connection registry — kept in scope so the test can inspect it
    const registry = new ConnectionRegistry();

    // Build Fastify app with all routes
    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);

    // We'll patch ws_url after we know the port; use a placeholder for now and
    // override via a dedicated dependency on registerPairRoute (publicWsUrl).
    // We listen first so we can pass the real port.

    // Register discovery + pair routes (ws_url patched below after listen)
    // Because registerPairRoute takes publicWsUrl at registration time we do:
    //   1. register with a placeholder, start listening, then read port.
    // Actually — we register after listening, which is fine in Fastify because
    // plugins are frozen only after ready(). We call listen which calls ready().
    // So we must register BEFORE listen. Use a known placeholder and overwrite
    // after — but ws_url is captured at registration time in a closure.
    // Work around: use a mutable ref.
    let wsUrl = "ws://placeholder";
    registerDiscovery(app, { publicWsUrl: wsUrl });
    // We pass a getter object — but registerPairRoute uses the string directly.
    // Easier: register routes after we know the port by listening on 0 then
    // calling app.ready() manually.
    // Fastify supports registering routes before listen — let's just register
    // with port=0 placeholder. Since we control the test and ws_url is only
    // used by the client, we can read the real address after listen and use
    // it directly in the test (we don't rely on ws_url from /pair response).

    registerPairRoute(app, {
      pool,
      publicWsUrl: wsUrl,  // will be superseded below
      serverPublicKeyJwk,
    });

    registerWsGateway(app, {
      pool,
      registry,
      jtiStore: new InMemoryJtiStore(),
      serverSigner,
      slackApi,
      botToken: "xoxb-test",
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;

    try {
      // -----------------------------------------------------------------------
      // 2. Pre-create user + pairing code (bypasses Slack install-DM flow)
      // -----------------------------------------------------------------------
      await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
      const { pairingCode } = await pairings.createPairing(pool, { workspaceId: "T1", userId: "U1" });

      // -----------------------------------------------------------------------
      // 3. POST /pair — real HTTP via fetch
      // -----------------------------------------------------------------------
      const pairRes = await fetch(`${base}/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: pairingCode,
          machine_public_key: machinePubKeyB64,
          label: "test-machine",
        }),
      });

      expect(pairRes.status).toBe(200);
      const pairBody = (await pairRes.json()) as {
        machine_id: string;
        server_public_key: Record<string, unknown>;
        ws_url: string;
        revoked_previous: number;
      };
      expect(pairBody.machine_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(pairBody.server_public_key.kty).toBe("OKP");
      expect(pairBody.revoked_previous).toBe(0);

      const { machine_id: machineId, server_public_key: serverPubKeyJwk } = pairBody;

      // -----------------------------------------------------------------------
      // 4. Open WebSocket — client mints a JWT signed by its own private key
      // -----------------------------------------------------------------------
      const clientJwt = await mintClientJwt(clientKp.privateKey, machineId);
      const ws = new WebSocket(`${wsBase}/ws`, {
        headers: { Authorization: `Bearer ${clientJwt}` },
      });

      // -----------------------------------------------------------------------
      // 5. Receive server_hello and verify the embedded JWT against the pinned
      //    server public key returned by /pair
      // -----------------------------------------------------------------------
      const helloMsg = (await nextMessage(ws)) as { type: string; jwt: string };
      expect(helloMsg.type).toBe("server_hello");
      expect(typeof helloMsg.jwt).toBe("string");

      // Verify server JWT against the public key we pinned from /pair
      const serverPubKey = (await importJWK(serverPubKeyJwk as any, "EdDSA")) as KeyLike;
      const { payload: helloPayload } = await jwtVerify(helloMsg.jwt, serverPubKey, {
        algorithms: ["EdDSA"],
      });
      expect(helloPayload.iss).toBe("claude-slackbot-server");
      expect((helloPayload as any).machine_id).toBe(machineId);

      // Give the gateway a moment to register the connection in the registry
      await new Promise<void>((r) => setTimeout(r, 100));
      expect(registry.getByMachine(machineId)).toBeDefined();

      // -----------------------------------------------------------------------
      // 6. Inject a synthetic slack_event via routeSlackEvent (in-process)
      // -----------------------------------------------------------------------
      const slackEventPromise = nextMessage(ws);

      await routeSlackEvent({
        pool,
        registry,
        slack: {
          postReply: vi.fn(async () => {}),
          addReaction: vi.fn(async () => {}),
        },
        installFlow: vi.fn(async () => {}),
        event: {
          kind: "app_mention",
          workspaceId: "T1",
          userId: "U1",
          channelId: "C1",
          threadTs: "1.0",
          triggerMsgTs: "1.0",
          text: "hi from slack",
          eventId: "E1",
        },
      });

      // -----------------------------------------------------------------------
      // 7. Client receives slack_event
      // -----------------------------------------------------------------------
      const slackEventMsg = (await slackEventPromise) as {
        type: string;
        event: { kind: string; userId: string; text: string };
      };
      expect(slackEventMsg.type).toBe("slack_event");
      expect(slackEventMsg.event.kind).toBe("app_mention");
      expect(slackEventMsg.event.userId).toBe("U1");
      expect(slackEventMsg.event.text).toBe("hi from slack");

      // -----------------------------------------------------------------------
      // 8. Client sends slack_rpc_request
      // -----------------------------------------------------------------------
      const rpcResponsePromise = nextMessage(ws);

      ws.send(
        JSON.stringify({
          type: "slack_rpc_request",
          id: "req-1",
          method: "postReply",
          params: { channel: "C1", thread_ts: "1.0", text: "hi from machine" },
        })
      );

      // -----------------------------------------------------------------------
      // 9. Client receives slack_rpc_response
      // -----------------------------------------------------------------------
      const rpcResponse = (await rpcResponsePromise) as {
        type: string;
        id: string;
        result?: { ts: string };
        error?: unknown;
      };
      expect(rpcResponse.type).toBe("slack_rpc_response");
      expect(rpcResponse.id).toBe("req-1");
      expect(rpcResponse.error).toBeUndefined();
      expect(rpcResponse.result?.ts).toBe("100.1");

      // Confirm mock was called with the right arguments
      expect(slackApi.chat.postMessage).toHaveBeenCalledWith({
        channel: "C1",
        thread_ts: "1.0",
        text: "hi from machine",
      });

      // -----------------------------------------------------------------------
      // Teardown: close WS client
      // -----------------------------------------------------------------------
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects /pair with an expired pairing code", async () => {
    const pool = makeInMemoryPool();
    const serverKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const serverPublicKeyJwk = await exportJWK(serverKp.publicKey);
    const serverSigner = createJwtSigner({ privateKey: serverKp.privateKey });
    const registry = new ConnectionRegistry();

    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerPairRoute(app, { pool, publicWsUrl: "ws://unused", serverPublicKeyJwk });
    registerWsGateway(app, { pool, registry, jtiStore: new InMemoryJtiStore(), serverSigner });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
      await pool.query(
        `INSERT INTO pairings (pairing_code, slack_workspace_id, slack_user_id, expires_at)
         VALUES ('PAIR-expired', 'T1', 'U1', now() - interval '1 hour')`
      );

      const clientKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
      const machinePubKeyB64 = Buffer.from(
        JSON.stringify(await exportJWK(clientKp.publicKey)),
        "utf8"
      ).toString("base64");

      const res = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "PAIR-expired", machine_public_key: machinePubKeyB64 }),
      });
      expect(res.status).toBe(410);
    } finally {
      await app.close();
    }
  });

  it("rejects WS connection with JWT for unknown machine", async () => {
    const pool = makeInMemoryPool();
    const serverKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const serverPublicKeyJwk = await exportJWK(serverKp.publicKey);
    const serverSigner = createJwtSigner({ privateKey: serverKp.privateKey });
    const registry = new ConnectionRegistry();

    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerPairRoute(app, { pool, publicWsUrl: "ws://unused", serverPublicKeyJwk });
    registerWsGateway(app, { pool, registry, jtiStore: new InMemoryJtiStore(), serverSigner });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const clientKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
      const jwt = await mintClientJwt(clientKp.privateKey, "00000000-0000-0000-0000-000000000000");
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const closeCode = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
      expect(closeCode).toBe(4404);
    } finally {
      await app.close();
    }
  });
});
