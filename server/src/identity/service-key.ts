import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPair, exportJWK, importJWK, type KeyLike } from "jose";

export type ServiceKey = {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicKeyJwk: import("jose").JWK;
};

export async function generateAndSaveServiceKey(opts: {
  privatePath: string;
  publicPath: string;
}): Promise<ServiceKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const privJwk = await exportJWK(privateKey);
  const pubJwk = await exportJWK(publicKey);
  await fs.mkdir(dirname(opts.privatePath), { recursive: true });
  await fs.mkdir(dirname(opts.publicPath), { recursive: true });
  await fs.writeFile(opts.privatePath, JSON.stringify(privJwk), { mode: 0o600 });
  await fs.writeFile(opts.publicPath, JSON.stringify(pubJwk), { mode: 0o644 });
  return { privateKey, publicKey, publicKeyJwk: pubJwk };
}

export async function loadServiceKey(opts: {
  privatePath: string;
  publicPath: string;
}): Promise<ServiceKey> {
  let privStat;
  try {
    privStat = await fs.stat(opts.privatePath);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(`server private key not found at ${opts.privatePath}`);
    }
    throw err;
  }
  // Group/world readable bits set?
  if ((privStat.mode & 0o077) !== 0) {
    throw new Error(
      `server private key ${opts.privatePath} has unsafe permissions (mode ${privStat.mode.toString(8)}); expected 0600`
    );
  }
  const privJwkRaw = await fs.readFile(opts.privatePath, "utf8");
  const pubJwkRaw = await fs.readFile(opts.publicPath, "utf8");
  const privJwk = JSON.parse(privJwkRaw);
  const pubJwk = JSON.parse(pubJwkRaw);
  const privateKey = (await importJWK(privJwk, "EdDSA")) as KeyLike;
  const publicKey = (await importJWK(pubJwk, "EdDSA")) as KeyLike;
  return { privateKey, publicKey, publicKeyJwk: pubJwk };
}
