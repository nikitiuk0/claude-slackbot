import type { Db } from "../db/pool.js";
import * as machines from "../db/machines.js";
import type { ConnectionRegistry } from "./connections.js";
import type { IncomingSlackEvent } from "../slack/adapter.js";

export type RouterSlack = {
  postReply: (channel: string, threadTs: string, text: string) => Promise<void>;
  addReaction: (channel: string, ts: string, name: string) => Promise<void>;
};

export async function routeSlackEvent(args: {
  db: Db;
  registry: ConnectionRegistry;
  slack: RouterSlack;
  installFlow: (event: IncomingSlackEvent) => Promise<void>;
  event: IncomingSlackEvent;
}): Promise<void> {
  const { event } = args;
  const active = machines.listActiveByUser(args.db, {
    workspaceId: event.workspaceId, userId: event.userId,
  });
  if (active.length === 0) {
    await args.installFlow(event);
    return;
  }
  // Invariant: only one active per user (enforced by unique partial index).
  const machine = active[0]!;
  const conn = args.registry.getByMachine(machine.machineId);
  if (!conn) {
    if (event.kind === "app_mention") {
      await args.slack.addReaction(event.channelId, event.triggerMsgTs, "no_entry_sign");
      await args.slack.postReply(
        event.channelId,
        event.threadTs,
        "Your machine isn't online. Reconnect and re-mention me to retry."
      );
    } else {
      await args.slack.postReply(event.channelId, event.channelId, "Your machine isn't online.");
    }
    return;
  }
  conn.socket.send(JSON.stringify({ type: "slack_event", event }));
}
