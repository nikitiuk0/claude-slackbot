import { describe, it, expect, vi } from "vitest";
import { newDb, DataType } from "pg-mem";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as users from "../../src/db/users.js";
import { runInstallFlow } from "../../src/install-dm/flow.js";

async function freshPool() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  mem.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });
  mem.registerExtension("pgcrypto", () => {});
  const here = dirname(fileURLToPath(import.meta.url));
  mem.public.none(readFileSync(join(here, "..", "..", "src", "db", "migrations", "0001_init.sql"), "utf8"));
  return new (mem.adapters.createPg().Pool)();
}

describe("install-dm/flow", () => {
  it("creates a pairing code and DMs the user with the full install command", async () => {
    const pool = await freshPool();
    const slack = {
      postDm: vi.fn(async () => {}),
      postReply: vi.fn(async () => {}),
      addReaction: vi.fn(async () => {}),
    };
    await runInstallFlow({
      pool, slack,
      publicServerUrl: "https://server.example",
      npmPackage: "@nikitiuk0/claude-slackbot",
      readmeUrl: "https://github.com/example/repo#readme",
      event: {
        kind: "app_mention", workspaceId: "T1", userId: "U1",
        channelId: "C1", threadTs: "1.0", triggerMsgTs: "1.0",
        text: "fix X", eventId: "E1",
      },
    });
    expect(slack.addReaction).toHaveBeenCalledWith("C1", "1.0", "hammer_and_wrench");
    expect(slack.postReply).toHaveBeenCalledWith("C1", "1.0", expect.stringContaining("Check your DMs"));
    expect(slack.postDm).toHaveBeenCalledWith("U1", expect.stringContaining("npx -y @nikitiuk0/claude-slackbot pair"));
    expect(slack.postDm).toHaveBeenCalledWith("U1", expect.stringContaining("https://github.com/example/repo#readme"));
  });

  it("skips the in-thread ack on DM trigger", async () => {
    const pool = await freshPool();
    const slack = {
      postDm: vi.fn(async () => {}),
      postReply: vi.fn(async () => {}),
      addReaction: vi.fn(async () => {}),
    };
    await runInstallFlow({
      pool, slack,
      publicServerUrl: "https://server.example",
      npmPackage: "@nikitiuk0/claude-slackbot",
      readmeUrl: "https://github.com/example/repo#readme",
      event: { kind: "dm", workspaceId: "T1", userId: "U1", channelId: "D1", text: "hi", eventId: "E1" },
    });
    expect(slack.postReply).not.toHaveBeenCalled();
    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(slack.postDm).toHaveBeenCalled();
  });
});
