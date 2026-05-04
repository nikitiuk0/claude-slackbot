import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK } from "jose";
import { generateAndSaveKeypair, loadKeypair } from "../../src/identity/keypair.js";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "client-kp-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("client keypair", () => {
  it("generates, saves, and round-trips a keypair", async () => {
    const path = join(dir, "kp.json");
    const { publicKey } = await generateAndSaveKeypair(path);
    const loaded = await loadKeypair(path);
    const pubJwk = await exportJWK(publicKey);
    expect(loaded.publicKeyJwk.x).toBe(pubJwk.x);
  });

  it("refuses to load if the keypair file is world-readable", async () => {
    const path = join(dir, "kp.json");
    await generateAndSaveKeypair(path);
    chmodSync(path, 0o644);
    await expect(loadKeypair(path)).rejects.toThrow(/permissions/);
  });

  it("throws a clear error if the keypair file is missing", async () => {
    await expect(loadKeypair(join(dir, "nope"))).rejects.toThrow(/not found|re-run/);
  });
});
