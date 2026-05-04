import { describe, it, expect, vi } from "vitest";
import { handleRpcRequest } from "../../src/ws/rpc-handler.js";

describe("handleRpcRequest", () => {
  const makeSlack = () => ({
    chat: {
      postMessage: vi.fn(async () => ({ ts: "100.1" })),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      getPermalink: vi.fn(async () => ({ permalink: "https://slack/perm/x" })),
    },
    reactions: {
      add: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    },
    conversations: { replies: vi.fn(async () => ({ messages: [] })) },
    users: { info: vi.fn(async () => ({ user: { profile: { display_name: "alice" }, real_name: "Alice" } })) },
    files: { info: vi.fn(async () => ({ file: { url_private: "x" } })) },
  });

  it("postReply returns {ts}", async () => {
    const slack = makeSlack();
    const res = await handleRpcRequest({
      slackClient: slack as any,
      botToken: "xoxb-x",
      method: "postReply",
      params: { channel: "C1", thread_ts: "1", text: "hi" },
    });
    expect(res.ts).toBe("100.1");
    expect(slack.chat.postMessage).toHaveBeenCalledWith({ channel: "C1", thread_ts: "1", text: "hi" });
  });

  it("addReaction swallows already_reacted", async () => {
    const slack = makeSlack();
    slack.reactions.add = vi.fn(async (): Promise<{}> => { const e: any = new Error("x"); e.data = { error: "already_reacted" }; throw e; });
    const res = await handleRpcRequest({
      slackClient: slack as any, botToken: "xoxb-x",
      method: "addReaction",
      params: { channel: "C1", ts: "1", name: "thinking_face" },
    });
    expect(res).toEqual({});
  });

  it("unknown method rejects with clear error", async () => {
    const slack = makeSlack();
    await expect(
      handleRpcRequest({ slackClient: slack as any, botToken: "xoxb-x", method: "nope" as any, params: {} })
    ).rejects.toThrow(/unknown method/i);
  });
});
