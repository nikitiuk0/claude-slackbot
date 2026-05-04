import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { createJwtVerifier, createJwtSigner, type JtiStore } from "../../src/identity/jwt.js";

class MemJtiStore implements JtiStore {
  private seen = new Map<string, number>();
  async seenWithin(jti: string, ttlMs: number, now: number): Promise<boolean> {
    const at = this.seen.get(jti);
    if (at !== undefined && now - at < ttlMs) return true;
    this.seen.set(jti, now);
    return false;
  }
}

describe("JWT verifier", () => {
  let machinePriv: any, machinePub: any;

  beforeEach(async () => {
    const k = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    machinePriv = k.privateKey;
    machinePub = k.publicKey;
  });

  it("accepts a valid JWT", async () => {
    const verifier = createJwtVerifier({ store: new MemJtiStore() });
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("mid-1")
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(machinePriv);
    const claims = await verifier.verify(jwt, machinePub);
    expect(claims.sub).toBe("mid-1");
  });

  it("rejects replay (same jti seen twice)", async () => {
    const store = new MemJtiStore();
    const verifier = createJwtVerifier({ store });
    const jti = crypto.randomUUID();
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("mid-1")
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(machinePriv);
    await verifier.verify(jwt, machinePub);
    await expect(verifier.verify(jwt, machinePub)).rejects.toThrow(/replay|jti/i);
  });

  it("rejects expired JWT", async () => {
    const verifier = createJwtVerifier({ store: new MemJtiStore() });
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("mid-1")
      .setJti(crypto.randomUUID())
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(machinePriv);
    await expect(verifier.verify(jwt, machinePub)).rejects.toThrow();
  });
});

describe("JWT signer (server_hello)", () => {
  it("mints a JWT clients can verify", async () => {
    const { privateKey: serverPriv, publicKey: serverPub } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const signer = createJwtSigner({ privateKey: serverPriv });
    const jwt = await signer.sign({ iss: "claude-slackbot-server", sub: "server", exp_seconds: 60 });
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(jwt, serverPub, { algorithms: ["EdDSA"] });
    expect(payload.iss).toBe("claude-slackbot-server");
  });
});
