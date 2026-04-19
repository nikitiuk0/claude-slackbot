import type { RenderedMessage } from "../prompt/build-input.js";

export type RawSlackMessage = {
  user?: string;
  ts: string;          // "1697059200.0001"
  text?: string;
};

function tsToHHMM(ts: string, timeZone: string): string {
  const ms = Math.floor(parseFloat(ts) * 1000);
  const d = new Date(ms);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(d);
}

export function renderThread(
  messages: RawSlackMessage[],
  displayNames: Map<string, string>,
  timeZone: string
): string[] {
  return messages.map((m) => {
    const userId = m.user ?? "unknown";
    const name = displayNames.get(userId) ?? userId;
    const time = tsToHHMM(m.ts, timeZone);
    const text = (m.text ?? "").trim();
    return `[${name} ${time}] ${text}`;
  });
}

export function toRenderedMessages(
  messages: RawSlackMessage[],
  displayNames: Map<string, string>,
  timeZone: string
): RenderedMessage[] {
  return messages.map((m) => {
    const userId = m.user ?? "unknown";
    return {
      displayName: displayNames.get(userId) ?? userId,
      time: tsToHHMM(m.ts, timeZone),
      text: (m.text ?? "").trim(),
    };
  });
}

export async function fetchThread(
  client: { conversations: any; users: any },
  channelId: string,
  threadTs: string,
  timeZone: string
): Promise<{ raw: RawSlackMessage[]; rendered: RenderedMessage[] }> {
  const res = await client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    inclusive: true,
    limit: 200,
  });
  const raw: RawSlackMessage[] = (res.messages ?? []).map((m: any) => ({
    user: m.user,
    ts: m.ts,
    text: m.text,
  }));
  const userIds = Array.from(new Set(raw.map((m) => m.user).filter(Boolean) as string[]));
  const displayNames = new Map<string, string>();
  for (const uid of userIds) {
    try {
      const info = await client.users.info({ user: uid });
      const dn =
        info.user?.profile?.display_name?.trim() ||
        info.user?.real_name ||
        uid;
      displayNames.set(uid, dn);
    } catch {
      displayNames.set(uid, uid);
    }
  }
  return { raw, rendered: toRenderedMessages(raw, displayNames, timeZone) };
}
