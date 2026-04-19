import { describe, it, expect } from "vitest";
import {
  EventDedupe,
  normalizeMention,
} from "../../src/slack/adapter.js";

describe("EventDedupe", () => {
  it("returns true the first time, false on repeat within ttl", () => {
    const d = new EventDedupe({ capacity: 4, ttlMs: 1000 });
    expect(d.firstSeen("a", 0)).toBe(true);
    expect(d.firstSeen("a", 100)).toBe(false);
    expect(d.firstSeen("a", 1500)).toBe(true);
  });

  it("evicts oldest at capacity", () => {
    const d = new EventDedupe({ capacity: 2, ttlMs: 10_000 });
    d.firstSeen("a", 0);
    d.firstSeen("b", 1);
    d.firstSeen("c", 2);
    expect(d.firstSeen("a", 3)).toBe(true); // a was evicted
  });
});

describe("normalizeMention", () => {
  it("strips the bot mention prefix and normalizes whitespace", () => {
    const m = normalizeMention(
      {
        user: "U1",
        channel: "C1",
        ts: "1.001",
        thread_ts: "1.001",
        text: "<@UBOTID>   please   fix   the   bug  ",
        event_id: "Ev1",
      },
      "UBOTID"
    );
    expect(m.userId).toBe("U1");
    expect(m.channelId).toBe("C1");
    expect(m.threadTs).toBe("1.001");
    expect(m.triggerMsgTs).toBe("1.001");
    expect(m.cleanText).toBe("please fix the bug");
    expect(m.eventId).toBe("Ev1");
  });

  it("falls back to ts when thread_ts is missing", () => {
    const m = normalizeMention(
      {
        user: "U1",
        channel: "C1",
        ts: "2.000",
        text: "<@UBOTID> hi",
        event_id: "Ev2",
      },
      "UBOTID"
    );
    expect(m.threadTs).toBe("2.000");
  });
});
