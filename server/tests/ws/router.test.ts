import { describe, it, expect, vi } from "vitest";
import { newDb, DataType } from "pg-mem";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as users from "../../src/db/users.js";
import * as machines from "../../src/db/machines.js";
import { ConnectionRegistry } from "../../src/ws/connections.js";
import { routeSlackEvent } from "../../src/ws/router.js";

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

describe("routeSlackEvent", () => {
  it("unknown user → runInstallFlow", async () => {
    const pool = await freshPool();
    const registry = new ConnectionRegistry();
    const installFlow = vi.fn(async () => {});
    const slack = { postReply: vi.fn(async () => {}), addReaction: vi.fn(async () => {}) };
    await routeSlackEvent({
      pool, registry, slack, installFlow,
      event: { kind: "app_mention", workspaceId: "T1", userId: "U1", channelId: "C1",
               threadTs: "1", triggerMsgTs: "1", text: "fix", eventId: "E1" },
    });
    expect(installFlow).toHaveBeenCalled();
  });

  it("paired but disconnected → reply with reconnect prompt", async () => {
    const pool = await freshPool();
    const registry = new ConnectionRegistry();
    const installFlow = vi.fn(async () => {});
    const slack = { postReply: vi.fn(async () => {}), addReaction: vi.fn(async () => {}) };
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    await machines.insertMachine(pool, { workspaceId: "T1", userId: "U1", publicKey: Buffer.from("pk") });
    await routeSlackEvent({
      pool, registry, slack, installFlow,
      event: { kind: "app_mention", workspaceId: "T1", userId: "U1", channelId: "C1",
               threadTs: "1", triggerMsgTs: "1", text: "fix", eventId: "E1" },
    });
    expect(installFlow).not.toHaveBeenCalled();
    expect(slack.addReaction).toHaveBeenCalledWith("C1", "1", "no_entry_sign");
    expect(slack.postReply).toHaveBeenCalledWith("C1", "1", expect.stringMatching(/isn't online/i));
  });

  it("paired and connected → forwards slack_event via socket", async () => {
    const pool = await freshPool();
    const registry = new ConnectionRegistry();
    const installFlow = vi.fn(async () => {});
    const slack = { postReply: vi.fn(async () => {}), addReaction: vi.fn(async () => {}) };
    await users.upsertUser(pool, { workspaceId: "T1", userId: "U1" });
    const m = await machines.insertMachine(pool, { workspaceId: "T1", userId: "U1", publicKey: Buffer.from("pk") });
    const sent: string[] = [];
    const socket: any = { send: (s: string) => sent.push(s) };
    registry.add({ machineId: m.machineId, workspaceId: "T1", userId: "U1", socket, connectedAt: 0, lastPingAt: 0 });
    await routeSlackEvent({
      pool, registry, slack, installFlow,
      event: { kind: "app_mention", workspaceId: "T1", userId: "U1", channelId: "C1",
               threadTs: "1", triggerMsgTs: "1", text: "fix", eventId: "E1" },
    });
    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0]!);
    expect(msg.type).toBe("slack_event");
    expect(msg.event.kind).toBe("app_mention");
  });

  it("DM from unknown user also triggers install flow", async () => {
    const pool = await freshPool();
    const registry = new ConnectionRegistry();
    const installFlow = vi.fn(async () => {});
    const slack = { postReply: vi.fn(async () => {}), addReaction: vi.fn(async () => {}) };
    await routeSlackEvent({
      pool, registry, slack, installFlow,
      event: { kind: "dm", workspaceId: "T1", userId: "U1", channelId: "D1", text: "hi", eventId: "E1" },
    });
    expect(installFlow).toHaveBeenCalled();
  });
});
