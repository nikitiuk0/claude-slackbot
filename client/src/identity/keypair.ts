import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPair, exportJWK, importJWK, type KeyLike } from "jose";

export type ClientKeypair = {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicKeyJwk: import("jose").JWK;
};

export async function generateAndSaveKeypair(path: string): Promise<ClientKeypair> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const privJwk = await exportJWK(privateKey);
  const pubJwk = await exportJWK(publicKey);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify({ privateKey: privJwk, publicKey: pubJwk }), { mode: 0o600 });
  return { privateKey, publicKey, publicKeyJwk: pubJwk };
}

export async function loadKeypair(path: string): Promise<ClientKeypair> {
  let stat;
  try { stat = await fs.stat(path); }
  catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`keypair not found at ${path} — re-run 'pair' to create one`);
    throw err;
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`keypair ${path} has unsafe permissions (${stat.mode.toString(8)}); expected 0600`);
  }
  const raw = JSON.parse(await fs.readFile(path, "utf8"));
  const privateKey = (await importJWK(raw.privateKey, "EdDSA")) as KeyLike;
  const publicKey = (await importJWK(raw.publicKey, "EdDSA")) as KeyLike;
  return { privateKey, publicKey, publicKeyJwk: raw.publicKey };
}
