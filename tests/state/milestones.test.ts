import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MilestonesStore } from "../../src/state/milestones.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slackbot-milestones-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MilestonesStore", () => {
  it("readAll on a missing thread returns []", async () => {
    const s = new MilestonesStore(dir);
    expect(await s.readAll("T1")).toEqual([]);
    expect(await s.readLastRun("T1")).toEqual([]);
  });

  it("appends and round-trips entries", async () => {
    const s = new MilestonesStore(dir);
    await s.append("T1", {
      ts: "2026-04-19T20:00:00.000Z",
      kind: "start",
      sessionId: "abc",
      sessionMode: "new",
      instruction: "fix it",
    });
    await s.append("T1", { ts: "2026-04-19T20:00:01.000Z", kind: "milestone", text: "Reading foo.ts" });
    await s.append("T1", { ts: "2026-04-19T20:00:02.000Z", kind: "milestone", text: "Editing foo.ts" });
    await s.append("T1", {
      ts: "2026-04-19T20:00:03.000Z",
      kind: "end",
      status: "done",
      exitCode: 0,
      signal: null,
    });
    const all = await s.readAll("T1");
    expect(all).toHaveLength(4);
    expect(all[0]!.kind).toBe("start");
    expect(all[3]!.kind).toBe("end");
  });

  it("readLastRun slices from the last `start` to the end", async () => {
    const s = new MilestonesStore(dir);
    // First run.
    await s.append("T1", { ts: "1", kind: "start", sessionId: "a", sessionMode: "new", instruction: "first" });
    await s.append("T1", { ts: "2", kind: "milestone", text: "step-A" });
    await s.append("T1", { ts: "3", kind: "end", status: "done", exitCode: 0, signal: null });
    // Second run.
    await s.append("T1", { ts: "4", kind: "start", sessionId: "a", sessionMode: "resume", instruction: "second" });
    await s.append("T1", { ts: "5", kind: "milestone", text: "step-B" });
    await s.append("T1", { ts: "6", kind: "milestone", text: "step-C" });

    const last = await s.readLastRun("T1");
    expect(last).toHaveLength(3);
    expect(last[0]!.kind).toBe("start");
    expect((last[0] as any).instruction).toBe("second");
    expect((last[1] as any).text).toBe("step-B");
    expect((last[2] as any).text).toBe("step-C");
  });

  it("ignores malformed lines without crashing", async () => {
    const s = new MilestonesStore(dir);
    await s.append("T1", { ts: "1", kind: "milestone", text: "ok" });
    // Manually append garbage to the file.
    const fs = await import("node:fs/promises");
    const path = join(dir, "T1.ndjson");
    await fs.appendFile(path, "{not json\n", "utf8");
    await fs.appendFile(path, "{\"unknown\":\"shape\"}\n", "utf8");
    await s.append("T1", { ts: "2", kind: "milestone", text: "still ok" });
    const all = await s.readAll("T1");
    expect(all).toHaveLength(2);
  });
});
