import { describe, it, expect } from "vitest";
import { IdentityGate } from "../src/identity-gate.js";

describe("IdentityGate", () => {
  it("admits allowlisted users", () => {
    const g = new IdentityGate({ allowed: ["U1", "U2"], rejectCooldownMs: 1000 });
    expect(g.admit("U1", 0)).toEqual({ ok: true });
    expect(g.admit("U2", 0)).toEqual({ ok: true });
  });

  it("rejects non-allowlisted users with shouldNotify=true on first hit", () => {
    const g = new IdentityGate({ allowed: ["U1"], rejectCooldownMs: 1000 });
    expect(g.admit("U_BAD", 0)).toEqual({ ok: false, shouldNotify: true });
  });

  it("rate-limits subsequent rejection notifications per user", () => {
    const g = new IdentityGate({ allowed: ["U1"], rejectCooldownMs: 1000 });
    expect(g.admit("U_BAD", 0)).toEqual({ ok: false, shouldNotify: true });
    expect(g.admit("U_BAD", 500)).toEqual({ ok: false, shouldNotify: false });
    expect(g.admit("U_BAD", 1001)).toEqual({ ok: false, shouldNotify: true });
  });

  it("isolates rate-limit per user", () => {
    const g = new IdentityGate({ allowed: ["U1"], rejectCooldownMs: 1000 });
    expect(g.admit("U_BAD_A", 0)).toEqual({ ok: false, shouldNotify: true });
    expect(g.admit("U_BAD_B", 100)).toEqual({ ok: false, shouldNotify: true });
  });
});
