import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { newDb, DataType } from "pg-mem";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import WebSocket from "ws";
import { ConnectionRegistry } from "../../src/ws/connections.js";
import { registerWsGateway } from "../../src/ws/gateway.js";
import { createJwtSigner, InMemoryJtiStore } from "../../src/identity/jwt.js";
import * as users from "../../src/db/users.js";

async function setup() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });
  mem.registerExtension("pgcrypto", () => {});
  const here = dirname(fileURLToPath(import.meta.url));
  mem.public.none(readFileSync(join(here, "..", "..", "src", "db", "migrations", "0001_init.sql"), "utf8"));
  const pool = new (mem.adapters.createPg().Pool)();

  await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
  const mk = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const pubJwk = await exportJWK(mk.publicKey);
  const r = await pool.query(
    `INSERT INTO machines (slack_workspace_id, slack_user_id, public_key, status)
     VALUES ('T1', 'U1', $1, 'active') RETURNING machine_id`,
    [Buffer.from(JSON.stringify(pubJwk))]
  );
  const machineId = r.rows[0].machine_id as string;

  const sk = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const signer = createJwtSigner({ privateKey: sk.privateKey });
  const registry = new ConnectionRegistry();

  const app = Fastify();
  await app.register(fastifyWebsocket);
  registerWsGateway(app, {
    pool,
    registry,
    jtiStore: new InMemoryJtiStore(),
    serverSigner: signer,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return { app, port, machineId, machinePrivateKey: mk.privateKey, pool, registry };
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
      // Registry populated
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
