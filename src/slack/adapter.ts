import bolt from "@slack/bolt";

export type IncomingMention = {
  userId: string;
  channelId: string;
  threadTs: string;
  triggerMsgTs: string;
  cleanText: string;
  eventId: string;
};

type RawMention = {
  user?: string;
  channel?: string;
  ts: string;
  thread_ts?: string;
  text: string;
  event_id: string;
};

export function normalizeMention(
  raw: RawMention,
  botUserId: string
): IncomingMention {
  const cleanText = raw.text
    .replace(new RegExp(`<@${botUserId}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    userId: raw.user ?? "",
    channelId: raw.channel ?? "",
    threadTs: raw.thread_ts ?? raw.ts,
    triggerMsgTs: raw.ts,
    cleanText,
    eventId: raw.event_id,
  };
}

export class EventDedupe {
  private order: string[] = [];
  private seen = new Map<string, number>();
  constructor(private readonly opts: { capacity: number; ttlMs: number }) {}

  firstSeen(eventId: string, nowMs: number): boolean {
    const at = this.seen.get(eventId);
    if (at !== undefined && nowMs - at < this.opts.ttlMs) return false;
    if (this.seen.size >= this.opts.capacity && at === undefined) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
    if (at === undefined) this.order.push(eventId);
    this.seen.set(eventId, nowMs);
    return true;
  }
}

export type SlackAdapterOptions = {
  botToken: string;
  appToken: string;
  onMention: (m: IncomingMention) => void;
  onError: (err: unknown) => void;
};

export class SlackAdapter {
  private app: bolt.App;
  private dedupe = new EventDedupe({ capacity: 1024, ttlMs: 5 * 60_000 });
  private botUserId: string | null = null;

  constructor(private readonly opts: SlackAdapterOptions) {
    this.app = new bolt.App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
    });

    this.app.event("app_mention", async ({ event, body }) => {
      try {
        const eventId = (body as any).event_id ?? `${event.ts}-${event.user}`;
        if (!this.dedupe.firstSeen(eventId, Date.now())) return;
        const m = normalizeMention(
          {
            user: (event as any).user,
            channel: (event as any).channel,
            ts: event.ts,
            thread_ts: (event as any).thread_ts,
            text: (event as any).text ?? "",
            event_id: eventId,
          },
          this.botUserId ?? ""
        );
        this.opts.onMention(m);
      } catch (err) {
        this.opts.onError(err);
      }
    });

    this.app.error(async (err) => this.opts.onError(err));
  }

  async start(): Promise<void> {
    await this.app.start();
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id ?? null;
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  client(): bolt.App["client"] {
    return this.app.client;
  }
}
