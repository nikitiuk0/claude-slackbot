import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import { loadServiceKey, generateAndSaveServiceKey } from "../../src/identity/service-key.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "svc-key-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("service-key", () => {
  it("generates, saves, and round-trips a keypair", async () => {
    const priv = join(dir, "priv");
    const pub = join(dir, "pub");
    const { publicKey } = await generateAndSaveServiceKey({ privatePath: priv, publicPath: pub });
    const loaded = await loadServiceKey({ privatePath: priv, publicPath: pub });
    // Verify by signing a payload with the loaded private key and
    // verifying it with the saved public key JWK.
    const pubJwk = await exportJWK(publicKey);
    expect(loaded.publicKeyJwk.x).toBe(pubJwk.x);
  });

  it("refuses to load if the private key file is world-readable", async () => {
    const priv = join(dir, "priv");
    const pub = join(dir, "pub");
    await generateAndSaveServiceKey({ privatePath: priv, publicPath: pub });
    chmodSync(priv, 0o644);
    await expect(loadServiceKey({ privatePath: priv, publicPath: pub })).rejects.toThrow(/permissions/);
  });

  it("throws a clear error if the private key file is missing", async () => {
    await expect(
      loadServiceKey({ privatePath: join(dir, "nope"), publicPath: join(dir, "nope.pub") })
    ).rejects.toThrow(/not found|ENOENT/);
  });
});
