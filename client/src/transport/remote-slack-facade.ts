import type { SlackClientFacade, Reaction } from "../core/slack/updater.js";

type Pending = {
  resolve: (v: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export type RemoteSlackFacade = SlackClientFacade & {
  _ingest: (msg: any) => void;
  getThread: (channelId: string, threadTs: string) => Promise<{ raw: any[]; displayNames: Record<string, string> }>;
};

export function createRemoteSlackFacade(opts: {
  send: (msg: unknown) => void;
  timeoutMs?: number;
}): RemoteSlackFacade {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pending = new Map<string, Pending>();

  function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`RPC ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      opts.send({ type: "slack_rpc_request", id, method, params });
    });
  }

  return {
    async postReply(channel, threadTs, text) {
      return rpc<{ ts: string }>("postReply", { channel, thread_ts: threadTs, text });
    },
    async editMessage(channel, ts, text) { await rpc<{}>("editMessage", { channel, ts, text }); },
    async deleteMessage(channel, ts) { await rpc<{}>("deleteMessage", { channel, ts }); },
    async addReaction(channel, ts, name: Reaction) { await rpc<{}>("addReaction", { channel, ts, name }); },
    async removeReaction(channel, ts, name: Reaction) { await rpc<{}>("removeReaction", { channel, ts, name }); },
    async permalink(channel, ts) {
      const { url } = await rpc<{ url: string }>("permalink", { channel, ts });
      return url;
    },
    async getThread(channelId, threadTs) {
      return rpc<{ raw: any[]; displayNames: Record<string, string> }>("getThread", {
        channel: channelId,
        thread_ts: threadTs,
      });
    },
    _ingest(msg) {
      if (msg.type !== "slack_rpc_response" || typeof msg.id !== "string") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
      else p.resolve(msg.result);
    },
  };
}
