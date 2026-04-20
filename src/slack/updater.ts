type EditFn = (text: string) => Promise<void>;

export class EditCoalescer {
  private timer: NodeJS.Timeout | null = null;
  private pending: string | null = null;
  private lastEmittedAt = 0;
  private busy: Promise<void> = Promise.resolve();

  constructor(private readonly intervalMs: number, private readonly edit: EditFn) {}

  update(text: string): void {
    const now = Date.now();
    if (now - this.lastEmittedAt >= this.intervalMs && !this.timer) {
      this.lastEmittedAt = now;
      this.busy = this.edit(text).catch(() => {});
      return;
    }
    this.pending = text;
    if (!this.timer) {
      const wait = Math.max(0, this.intervalMs - (now - this.lastEmittedAt));
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.pending !== null) {
          const t = this.pending;
          this.pending = null;
          this.lastEmittedAt = Date.now();
          this.busy = this.edit(t).catch(() => {});
        }
      }, wait);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending !== null) {
      const t = this.pending;
      this.pending = null;
      this.lastEmittedAt = Date.now();
      await this.edit(t);
    }
    await this.busy;
  }
}

export type Reaction =
  | "thinking_face"
  | "white_check_mark"
  | "x"
  | "hourglass_flowing_sand"
  | "arrows_counterclockwise"
  | "broom"
  | "octagonal_sign"
  | "no_entry_sign"
  | "shrug";

export type SlackClientFacade = {
  postReply: (channel: string, threadTs: string, text: string) => Promise<{ ts: string }>;
  editMessage: (channel: string, ts: string, text: string) => Promise<void>;
  deleteMessage: (channel: string, ts: string) => Promise<void>;
  addReaction: (channel: string, ts: string, name: Reaction) => Promise<void>;
  removeReaction: (channel: string, ts: string, name: Reaction) => Promise<void>;
  permalink: (channel: string, ts: string) => Promise<string>;
};

export function makeSlackClientFacade(client: any): SlackClientFacade {
  return {
    async postReply(channel, threadTs, text) {
      const res = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
      });
      return { ts: String(res.ts) };
    },
    async editMessage(channel, ts, text) {
      await client.chat.update({ channel, ts, text });
    },
    async deleteMessage(channel, ts) {
      try {
        await client.chat.delete({ channel, ts });
      } catch (err: any) {
        const code = err?.data?.error;
        // Already gone is fine.
        if (code === "message_not_found") return;
        throw err;
      }
    },
    async addReaction(channel, ts, name) {
      try {
        await client.reactions.add({ channel, timestamp: ts, name });
      } catch (err: any) {
        const code = err?.data?.error;
        // Reactions are decorative — never let a bad emoji name or duplicate
        // reaction crash the orchestrator pipeline.
        if (code === "already_reacted" || code === "invalid_name") return;
        throw err;
      }
    },
    async removeReaction(channel, ts, name) {
      try {
        await client.reactions.remove({ channel, timestamp: ts, name });
      } catch (err: any) {
        const code = err?.data?.error;
        // No reaction to remove or unknown name: harmless.
        if (code === "no_reaction" || code === "invalid_name") return;
        throw err;
      }
    },
    async permalink(channel, ts) {
      const r = await client.chat.getPermalink({
        channel,
        message_ts: ts,
      });
      return String(r.permalink);
    },
  };
}
