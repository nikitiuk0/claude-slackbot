import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { newDb, DataType } from "pg-mem";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as users from "../../src/db/users.js";
import * as pairings from "../../src/db/pairings.js";
import { registerPairRoute } from "../../src/pairing/route.js";

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
  const app = Fastify();
  registerPairRoute(app, {
    pool,
    publicWsUrl: "wss://example/ws",
    serverPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc" } as any,
  });
  return { app, pool };
}

const jwkFixture = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" };
const machinePubKey = Buffer.from(JSON.stringify(jwkFixture), "utf8").toString("base64");

describe("POST /pair", () => {
  it("claims a live code and returns machine_id + server_public_key + ws_url", async () => {
    const { app, pool } = await setup();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const p = await pairings.createPairing(pool, { workspaceId: "T1", userId: "U1" });
    const res = await app.inject({
      method: "POST",
      url: "/pair",
      payload: { code: p.pairingCode, machine_public_key: machinePubKey, label: "m1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.machine_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.ws_url).toBe("wss://example/ws");
    expect(body.server_public_key.kty).toBe("OKP");
    expect(body.revoked_previous).toBe(0);
  });

  it("returns 410 for expired code", async () => {
    const { app, pool } = await setup();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    await pool.query(
      `INSERT INTO pairings (pairing_code, slack_workspace_id, slack_user_id, expires_at)
       VALUES ('PAIR-old', 'T1', 'U1', now() - interval '1 hour')`
    );
    const res = await app.inject({
      method: "POST",
      url: "/pair",
      payload: { code: "PAIR-old", machine_public_key: machinePubKey },
    });
    expect(res.statusCode).toBe(410);
  });

  it("returns 409 for already-consumed code", async () => {
    const { app, pool } = await setup();
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const p = await pairings.createPairing(pool, { workspaceId: "T1", userId: "U1" });
    await app.inject({ method: "POST", url: "/pair", payload: { code: p.pairingCode, machine_public_key: machinePubKey } });
    const res = await app.inject({
      method: "POST",
      url: "/pair",
      payload: { code: p.pairingCode, machine_public_key: machinePubKey },
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for unknown code", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/pair",
      payload: { code: "PAIR-none", machine_public_key: machinePubKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for non-JWK public_key", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/pair",
      payload: { code: "PAIR-anything", machine_public_key: Buffer.from("not-a-jwk").toString("base64") },
    });
    expect(res.statusCode).toBe(400);
  });
});
