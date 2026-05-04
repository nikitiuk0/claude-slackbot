import type { IncomingMention } from "../core/slack/adapter.js";

export function normalizeServerEvent(event: any): IncomingMention | null {
  if (event?.kind !== "app_mention") return null;
  return {
    userId: event.userId,
    channelId: event.channelId,
    threadTs: event.threadTs,
    triggerMsgTs: event.triggerMsgTs,
    cleanText: (event.text ?? "").replace(/\s+/g, " ").trim(),
    eventId: event.eventId,
  };
}
