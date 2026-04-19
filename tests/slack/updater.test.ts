import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditCoalescer } from "../../src/slack/updater.js";

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
