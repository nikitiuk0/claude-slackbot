import { jwtVerify, SignJWT, type JWTPayload, type KeyLike } from "jose";

export interface JtiStore {
  /** Returns true if jti was already seen within ttlMs. Otherwise records it. */
  seenWithin(jti: string, ttlMs: number, now: number): Promise<boolean>;
}

export class InMemoryJtiStore implements JtiStore {
  private order: string[] = [];
  private seen = new Map<string, number>();
  constructor(private readonly capacity: number = 4096) {}
  async seenWithin(jti: string, ttlMs: number, now: number): Promise<boolean> {
    const at = this.seen.get(jti);
    if (at !== undefined && now - at < ttlMs) return true;
    if (this.seen.size >= this.capacity && !this.seen.has(jti)) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
    if (!this.seen.has(jti)) this.order.push(jti);
    this.seen.set(jti, now);
    return false;
  }
}

export type JwtVerifier = {
  verify(jwt: string, publicKey: KeyLike): Promise<JWTPayload>;
};

export function createJwtVerifier(opts: { store: JtiStore; ttlMs?: number }): JwtVerifier {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  return {
    async verify(jwt, publicKey) {
      const { payload } = await jwtVerify(jwt, publicKey, { algorithms: ["EdDSA"] });
      if (!payload.jti) throw new Error("JWT missing jti");
      const seen = await opts.store.seenWithin(payload.jti, ttlMs, Date.now());
      if (seen) throw new Error(`JWT replay: jti ${payload.jti} already used`);
      return payload;
    },
  };
}

export type JwtSigner = {
  sign(claims: { iss: string; sub: string; exp_seconds: number; extra?: Record<string, unknown> }): Promise<string>;
};

export function createJwtSigner(opts: { privateKey: KeyLike }): JwtSigner {
  return {
    async sign(claims) {
      return await new SignJWT(claims.extra ?? {})
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(claims.iss)
        .setSubject(claims.sub)
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + claims.exp_seconds)
        .sign(opts.privateKey);
    },
  };
}
