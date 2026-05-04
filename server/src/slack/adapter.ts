import bolt from "@slack/bolt";

export type IncomingAppMention = {
  kind: "app_mention";
  workspaceId: string;
  userId: string;
  channelId: string;
  threadTs: string;
  triggerMsgTs: string;
  text: string;
  eventId: string;
};

export type IncomingDm = {
  kind: "dm";
  workspaceId: string;
  userId: string;
  channelId: string;
  text: string;
  eventId: string;
};

export type IncomingSlackEvent = IncomingAppMention | IncomingDm;

export type SlackAdapterOptions = {
  botToken: string;
  appToken: string;
  onEvent: (e: IncomingSlackEvent) => void;
  onError: (err: unknown) => void;
};

export class SlackAdapter {
  private app: bolt.App;
  private botUserId: string | null = null;

  constructor(private readonly opts: SlackAdapterOptions) {
    this.app = new bolt.App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
    });

    this.app.event("app_mention", async ({ event, body }) => {
      try {
        const eventId = (body as any).event_id ?? `${event.ts}-${(event as any).user}`;
        this.opts.onEvent({
          kind: "app_mention",
          workspaceId: (body as any).team_id,
          userId: (event as any).user ?? "",
          channelId: (event as any).channel ?? "",
          threadTs: (event as any).thread_ts ?? event.ts,
          triggerMsgTs: event.ts,
          text: this.stripBotMention((event as any).text ?? ""),
          eventId,
        });
      } catch (err) { this.opts.onError(err); }
    });

    this.app.message(async ({ message, body }) => {
      if ((message as any).channel_type !== "im") return;
      if ((message as any).subtype) return; // skip edits/bot messages
      try {
        const eventId = (body as any).event_id ?? `${(message as any).ts}-${(message as any).user}`;
        this.opts.onEvent({
          kind: "dm",
          workspaceId: (body as any).team_id,
          userId: (message as any).user ?? "",
          channelId: (message as any).channel ?? "",
          text: (message as any).text ?? "",
          eventId,
        });
      } catch (err) { this.opts.onError(err); }
    });

    this.app.error(async (err) => this.opts.onError(err));
  }

  private stripBotMention(text: string): string {
    if (!this.botUserId) return text.replace(/\s+/g, " ").trim();
    return text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").replace(/\s+/g, " ").trim();
  }

  async start(): Promise<void> {
    await this.app.start();
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id ?? null;
  }

  async stop(): Promise<void> { await this.app.stop(); }

  client() { return this.app.client; }
}
