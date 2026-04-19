import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, type ThreadState } from "../../src/state/store.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slackbot-state-"));
  path = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("returns empty map when file does not exist", async () => {
    const store = new StateStore(path);
    await store.load();
    expect(store.getThread("nope")).toBeUndefined();
  });

  it("persists and reloads a thread", async () => {
    const store = new StateStore(path);
    await store.load();
    const t: ThreadState = {
      sessionId: "sess-1",
      channelId: "C1",
      triggerMsgTs: "1.000",
      statusMsgTs: "1.001",
      status: "running",
      startedAt: "2026-04-19T00:00:00Z",
      updatedAt: "2026-04-19T00:00:01Z",
      lastEventAt: "2026-04-19T00:00:01Z",
    };
    await store.upsertThread("thread-1", t);

    const fresh = new StateStore(path);
    await fresh.load();
    expect(fresh.getThread("thread-1")).toEqual(t);
  });

  it("recovers from corrupt JSON by treating as empty + warning", async () => {
    writeFileSync(path, "{not json", "utf8");
    const store = new StateStore(path);
    await store.load(); // does not throw
    expect(store.getThread("anything")).toBeUndefined();
    // After load, the corrupt file should still exist; we don't overwrite
    // until the first upsert.
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  it("delete removes a thread", async () => {
    const store = new StateStore(path);
    await store.load();
    await store.upsertThread("t", {
      sessionId: "s",
      channelId: "C",
      triggerMsgTs: "1",
      statusMsgTs: "2",
      status: "done",
      startedAt: "x",
      updatedAt: "x",
      lastEventAt: "x",
    });
    await store.deleteThread("t");
    expect(store.getThread("t")).toBeUndefined();
    const fresh = new StateStore(path);
    await fresh.load();
    expect(fresh.getThread("t")).toBeUndefined();
  });
});
