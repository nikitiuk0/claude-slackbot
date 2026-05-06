/**
 * End-to-end integration test:
 *   POST /pair  →  WS /ws (server_hello)  →  inject slack_event  →  slack_rpc_request  →  slack_rpc_response
 *
 * Uses an in-memory SQLite database (no real DB) and a mock Slack client.
 */

import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { generateKeyPair, exportJWK, importJWK, jwtVerify, SignJWT } from "jose";
import type { KeyLike } from "jose";
import WebSocket from "ws";

import { ConnectionRegistry } from "../../src/ws/connections.js";
import { registerWsGateway } from "../../src/ws/gateway.js";
import { registerPairRoute } from "../../src/pairing/route.js";
import { createJwtSigner, InMemoryJtiStore } from "../../src/identity/jwt.js";
import { routeSlackEvent } from "../../src/ws/router.js";
import * as users from "../../src/db/users.js";
import * as pairings from "../../src/db/pairings.js";
import { freshDb } from "../test-helpers/db.js";

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

describe("End-to-end: pair + WS + RPC round-trip", () => {
  it("full pair + WS + RPC round-trip works end-to-end", async () => {
    const db = freshDb();

    const serverKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const serverPublicKeyJwk = await exportJWK(serverKp.publicKey);
    const serverSigner = createJwtSigner({ privateKey: serverKp.privateKey });

    const clientKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const clientPubJwk = await exportJWK(clientKp.publicKey);
    const machinePubKeyB64 = Buffer.from(JSON.stringify(clientPubJwk), "utf8").toString("base64");

    const slackApi = makeSlackApi();
    const registry = new ConnectionRegistry();

    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);

    let wsUrl = "ws://placeholder";
    registerPairRoute(app, {
      db,
      publicWsUrl: wsUrl,
      serverPublicKeyJwk,
    });
    registerWsGateway(app, {
      db,
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
      users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
      const { pairingCode } = pairings.createPairing(db, { workspaceId: "T1", userId: "U1" });

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

      const clientJwt = await mintClientJwt(clientKp.privateKey, machineId);
      const ws = new WebSocket(`${wsBase}/ws`, {
        headers: { Authorization: `Bearer ${clientJwt}` },
      });

      const helloMsg = (await nextMessage(ws)) as { type: string; jwt: string };
      expect(helloMsg.type).toBe("server_hello");
      expect(typeof helloMsg.jwt).toBe("string");

      const serverPubKey = (await importJWK(serverPubKeyJwk as any, "EdDSA")) as KeyLike;
      const { payload: helloPayload } = await jwtVerify(helloMsg.jwt, serverPubKey, {
        algorithms: ["EdDSA"],
      });
      expect(helloPayload.iss).toBe("claude-slackbot-server");
      expect((helloPayload as any).machine_id).toBe(machineId);

      await new Promise<void>((r) => setTimeout(r, 100));
      expect(registry.getByMachine(machineId)).toBeDefined();

      const slackEventPromise = nextMessage(ws);

      await routeSlackEvent({
        db,
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

      const slackEventMsg = (await slackEventPromise) as {
        type: string;
        event: { kind: string; userId: string; text: string };
      };
      expect(slackEventMsg.type).toBe("slack_event");
      expect(slackEventMsg.event.kind).toBe("app_mention");
      expect(slackEventMsg.event.userId).toBe("U1");
      expect(slackEventMsg.event.text).toBe("hi from slack");

      const rpcResponsePromise = nextMessage(ws);

      ws.send(
        JSON.stringify({
          type: "slack_rpc_request",
          id: "req-1",
          method: "postReply",
          params: { channel: "C1", thread_ts: "1.0", text: "hi from machine" },
        })
      );

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

      expect(slackApi.chat.postMessage).toHaveBeenCalledWith({
        channel: "C1",
        thread_ts: "1.0",
        text: "hi from machine",
      });

      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects /pair with an expired pairing code", async () => {
    const db = freshDb();
    const serverKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const serverPublicKeyJwk = await exportJWK(serverKp.publicKey);
    const serverSigner = createJwtSigner({ privateKey: serverKp.privateKey });
    const registry = new ConnectionRegistry();

    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerPairRoute(app, { db, publicWsUrl: "ws://unused", serverPublicKeyJwk });
    registerWsGateway(app, { db, registry, jtiStore: new InMemoryJtiStore(), serverSigner });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
      db.prepare(
        `INSERT INTO pairings (pairing_code, slack_workspace_id, slack_user_id, expires_at)
         VALUES (?, 'T1', 'U1', ?)`
      ).run("PAIR-expired", Date.now() - 60 * 60 * 1000);

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
    const db = freshDb();
    const serverKp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const serverPublicKeyJwk = await exportJWK(serverKp.publicKey);
    const serverSigner = createJwtSigner({ privateKey: serverKp.privateKey });
    const registry = new ConnectionRegistry();

    const app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerPairRoute(app, { db, publicWsUrl: "ws://unused", serverPublicKeyJwk });
    registerWsGateway(app, { db, registry, jtiStore: new InMemoryJtiStore(), serverSigner });
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
