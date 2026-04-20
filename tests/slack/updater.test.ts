import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditCoalescer, makeSlackClientFacade } from "../../src/slack/updater.js";

beforeEach(() => {
  vi.useFakeTimers();
});

describe("EditCoalescer", () => {
  it("emits the first update immediately and rate-limits the rest", async () => {
    const calls: string[] = [];
    const c = new EditCoalescer(3000, async (text) => {
      calls.push(text);
    });
    c.update("first");
    await vi.runOnlyPendingTimersAsync();
    expect(calls).toEqual(["first"]);

    c.update("second");
    c.update("third");
    expect(calls).toEqual(["first"]); // still throttled

    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toEqual(["first", "third"]);
  });

  it("flushes pending update on close", async () => {
    const calls: string[] = [];
    const c = new EditCoalescer(3000, async (text) => {
      calls.push(text);
    });
    c.update("a");
    await vi.runOnlyPendingTimersAsync();
    c.update("b");
    await c.flush();
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("makeSlackClientFacade addReaction", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  function makePlatformError(code: string) {
    const err: any = new Error(`An API error occurred: ${code}`);
    err.code = "slack_webapi_platform_error";
    err.data = { ok: false, error: code };
    return err;
  }

  it("swallows already_reacted errors", async () => {
    const client = {
      reactions: { add: vi.fn(async () => { throw makePlatformError("already_reacted"); }) },
    };
    const facade = makeSlackClientFacade(client);
    await expect(facade.addReaction("C", "1.0", "thinking_face")).resolves.toBeUndefined();
  });

  it("swallows invalid_name errors so a bad emoji name doesn't crash callers", async () => {
    const client = {
      reactions: { add: vi.fn(async () => { throw makePlatformError("invalid_name"); }) },
    };
    const facade = makeSlackClientFacade(client);
    await expect(facade.addReaction("C", "1.0", "thinking_face")).resolves.toBeUndefined();
  });

  it("rethrows other Slack errors", async () => {
    const client = {
      reactions: { add: vi.fn(async () => { throw makePlatformError("channel_not_found"); }) },
    };
    const facade = makeSlackClientFacade(client);
    await expect(facade.addReaction("C", "1.0", "thinking_face")).rejects.toThrow(/channel_not_found/);
  });
});
