import type { Pool } from "pg";
import * as users from "../db/users.js";
import * as pairings from "../db/pairings.js";
import type { IncomingSlackEvent } from "../slack/adapter.js";

export type SlackHandle = {
  postDm: (userId: string, text: string) => Promise<void>;
  postReply: (channel: string, threadTs: string, text: string) => Promise<void>;
  addReaction: (channel: string, ts: string, name: string) => Promise<void>;
};

export async function runInstallFlow(args: {
  pool: Pool;
  slack: SlackHandle;
  publicServerUrl: string;
  npmPackage: string;
  readmeUrl: string;
  event: IncomingSlackEvent;
}): Promise<void> {
  const { event } = args;
  await users.upsertUser(args.pool, { workspaceId: event.workspaceId, userId: event.userId });
  const { pairingCode } = await pairings.createPairing(args.pool, {
    workspaceId: event.workspaceId, userId: event.userId,
  });

  const dmText = [
    `Welcome! To pair this Slack account with your machine, run on the machine you want to use:`,
    "",
    "```",
    `npx -y ${args.npmPackage} pair \\`,
    `  --server ${args.publicServerUrl} \\`,
    `  --code ${pairingCode}`,
    "```",
    "",
    `Code expires in 15 minutes.`,
    `Full install guide + troubleshooting: ${args.readmeUrl}`,
  ].join("\n");

  await args.slack.postDm(event.userId, dmText);

  if (event.kind === "app_mention") {
    await args.slack.addReaction(event.channelId, event.triggerMsgTs, "hammer_and_wrench");
    await args.slack.postReply(
      event.channelId,
      event.threadTs,
      "👋 You'll need to configure me on your machine first. Check your DMs for install instructions."
    );
  }
}
