import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProfiles } from "../../src/profile/manager.js";

describe("discoverProfiles", () => {
  it("returns a list of profile directories", () => {
    const home = mkdtempSync(join(tmpdir(), "cbs-"));
    try {
      mkdirSync(join(home, "profiles", "alpha"), { recursive: true });
      writeFileSync(join(home, "profiles", "alpha", "config.json"), "{}");
      mkdirSync(join(home, "profiles", "beta"), { recursive: true });
      writeFileSync(join(home, "profiles", "beta", "config.json"), "{}");
      mkdirSync(join(home, "profiles", "incomplete"), { recursive: true });
      // no config.json → skipped
      const found = discoverProfiles(home);
      expect(found.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns empty array if profiles dir doesn't exist", () => {
    const home = mkdtempSync(join(tmpdir(), "cbs-"));
    try {
      expect(discoverProfiles(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
