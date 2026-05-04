import { describe, it, expect } from "vitest";
import { createRemoteSlackFacade } from "../../src/transport/remote-slack-facade.js";

describe("RemoteSlackFacade", () => {
  it("postReply round-trips an RPC", async () => {
    const sent: any[] = [];
    const facade = createRemoteSlackFacade({
      send: (m) => sent.push(m),
      timeoutMs: 1000,
    });
    const p = facade.postReply("C1", "1.0", "hi");
    const req = sent[0];
    expect(req.type).toBe("slack_rpc_request");
    expect(req.method).toBe("postReply");
    facade._ingest({ type: "slack_rpc_response", id: req.id, result: { ts: "100.1" } });
    expect(await p).toEqual({ ts: "100.1" });
  });

  it("rejects on error response", async () => {
    const sent: any[] = [];
    const facade = createRemoteSlackFacade({ send: (m) => sent.push(m), timeoutMs: 1000 });
    const p = facade.editMessage("C1", "1", "x");
    const req = sent[0];
    facade._ingest({ type: "slack_rpc_response", id: req.id, error: { message: "nope" } });
    await expect(p).rejects.toThrow(/nope/);
  });

  it("times out if no response", async () => {
    const facade = createRemoteSlackFacade({ send: () => {}, timeoutMs: 10 });
    await expect(facade.postReply("C1", "1", "x")).rejects.toThrow(/timeout/i);
  });
});
