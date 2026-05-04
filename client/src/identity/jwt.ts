import { SignJWT, type KeyLike } from "jose";

export async function mintClientJwt(args: {
  privateKey: KeyLike;
  machineId: string;
  ttlSeconds?: number;
}): Promise<string> {
  const ttl = args.ttlSeconds ?? 300;
  return await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(args.machineId)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(args.privateKey);
}
