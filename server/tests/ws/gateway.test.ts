import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import WebSocket from "ws";
import { ConnectionRegistry } from "../../src/ws/connections.js";
import { registerWsGateway } from "../../src/ws/gateway.js";
import { createJwtSigner, InMemoryJtiStore } from "../../src/identity/jwt.js";
import * as users from "../../src/db/users.js";
import { freshDb } from "../test-helpers/db.js";

async function setup() {
  const db = freshDb();

  users.upsertUser(db, { workspaceId: "T1", userId: "U1" });
  const mk = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const pubJwk = await exportJWK(mk.publicKey);
  const machineId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO machines (machine_id, slack_workspace_id, slack_user_id, public_key, status)
     VALUES (?, 'T1', 'U1', ?, 'active')`
  ).run(machineId, Buffer.from(JSON.stringify(pubJwk)));

  const sk = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const signer = createJwtSigner({ privateKey: sk.privateKey });
  const registry = new ConnectionRegistry();

  const app = Fastify();
  await app.register(fastifyWebsocket);
  registerWsGateway(app, {
    db,
    registry,
    jtiStore: new InMemoryJtiStore(),
    serverSigner: signer,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return { app, port, machineId, machinePrivateKey: mk.privateKey, db, registry };
}

async function mintClientJwt(privateKey: any, machineId: string): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(machineId)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("WebSocket gateway", () => {
  it("accepts a valid JWT, sends server_hello, tracks connection", async () => {
    const { app, port, machineId, machinePrivateKey, registry } = await setup();
    try {
      const jwt = await mintClientJwt(machinePrivateKey, machineId);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${jwt}` } });
      const helloMsg: any = await new Promise((r, rej) => {
        ws.on("message", (data) => r(JSON.parse(String(data))));
        ws.on("error", rej);
      });
      expect(helloMsg.type).toBe("server_hello");
      expect(helloMsg.jwt).toBeTruthy();
      await new Promise((r) => setTimeout(r, 50));
      expect(registry.getByMachine(machineId)).toBeDefined();
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects missing JWT with 4401", async () => {
    const { app, port } = await setup();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const code: number = await new Promise((r) => ws.on("close", (c) => r(c)));
      expect(code).toBe(4401);
    } finally {
      await app.close();
    }
  });

  it("rejects JWT for unknown machine with 4404", async () => {
    const { app, port, machinePrivateKey } = await setup();
    try {
      const jwt = await mintClientJwt(machinePrivateKey, "not-a-real-machine");
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${jwt}` } });
      const code: number = await new Promise((r) => ws.on("close", (c) => r(c)));
      expect(code).toBe(4404);
    } finally {
      await app.close();
    }
  });
});
