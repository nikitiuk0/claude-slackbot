import { describe, it, expect } from "vitest";
import { normalizeServerEvent } from "../../src/transport/server-adapter.js";

describe("normalizeServerEvent", () => {
  it("maps an app_mention event", () => {
    const m = normalizeServerEvent({
      kind: "app_mention", userId: "U", channelId: "C", threadTs: "1", triggerMsgTs: "1", text: "hi", eventId: "E",
    });
    expect(m?.userId).toBe("U");
    expect(m?.cleanText).toBe("hi");
  });
  it("returns null for non-mention events", () => {
    expect(normalizeServerEvent({ kind: "dm" })).toBeNull();
  });
});
