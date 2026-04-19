import { describe, it, expect } from "vitest";
import { renderThread, type RawSlackMessage } from "../../src/slack/thread-fetch.js";

const userMap = new Map<string, string>([
  ["U1", "Alice"],
  ["U2", "Bob"],
]);

const msgs: RawSlackMessage[] = [
  { user: "U1", ts: "1697032800.0001", text: "We've got a 500" },
  { user: "U2", ts: "1697033100.0001", text: "repro: <https://x>" },
  { user: "UBOT", ts: "1697033200.0001", text: "(no mapping for me)" },
];

describe("renderThread", () => {
  it("renders display names + HH:MM and preserves text including links", () => {
    const out = renderThread(msgs, userMap, "UTC");
    expect(out[0]).toMatch(/^\[Alice 14:00\] We've got a 500$/);
    expect(out[1]).toMatch(/^\[Bob 14:05\] repro: <https:\/\/x>$/);
  });

  it("falls back to user id when display name is unknown", () => {
    const out = renderThread(msgs, userMap, "UTC");
    expect(out[2]).toMatch(/^\[UBOT \d{2}:\d{2}\] \(no mapping for me\)$/);
  });
});
