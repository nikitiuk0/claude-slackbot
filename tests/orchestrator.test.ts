import { describe, it, expect, vi } from "vitest";
import {
  Orchestrator,
  type OrchestratorDeps,
} from "../src/orchestrator.js";
import type { IncomingMention } from "../src/slack/adapter.js";

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    maxParallelJobs: 2,
    coalesceMs: 3000,
    stallSoftNoticeMs: 5 * 60_000,
    stallHardStopMs: 24 * 60 * 60_000,
    nowMs: () => Date.now(),
    fetchThread: vi.fn(async () => ({ raw: [], rendered: [] })),
    buildInitial: vi.fn((s) => `INITIAL:${s.instruction}`),
    buildFollowUp: vi.fn((s) => `FOLLOWUP:${s.instruction}`),
    runClaude: vi.fn(async (input, onLine, control) => {
      onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "S" }));
      onLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "<slack-summary>\nSummary: ok\n</slack-summary>" }] },
        })
      );
      return { exitCode: 0, signal: null, stderr: "" };
    }),
    slack: {
      postReply: vi.fn(async () => ({ ts: "100.001" })),
      editMessage: vi.fn(async () => {}),
      addReaction: vi.fn(async () => {}),
      permalink: vi.fn(async () => "https://slack/permalink"),
    },
    state: {
      load: vi.fn(async () => {}),
      getThread: vi.fn(() => undefined),
      allRunning: vi.fn(() => []),
      upsertThread: vi.fn(async () => {}),
      deleteThread: vi.fn(async () => {}),
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    timeZone: "UTC",
    systemPrompt: "SYS",
    ownerDisplayName: "alice",
    ...over,
  } as OrchestratorDeps;
}

const m = (over: Partial<IncomingMention> = {}): IncomingMention => {
  const base: IncomingMention = {
    userId: "U1",
    channelId: "C1",
    threadTs: "T1",
    triggerMsgTs: "T1",
    cleanText: "fix it",
    eventId: "E1",
  };
  const merged = { ...base, ...over };
  // Mirror triggerMsgTs to threadTs unless explicitly overridden
  if (!("triggerMsgTs" in over)) merged.triggerMsgTs = merged.threadTs;
  return merged;
};

describe("Orchestrator", () => {
  it("runs a new mention end-to-end and persists session id", async () => {
    const d = deps();
    const o = new Orchestrator(d);
    await o.start();
    await o.enqueue(m());
    await o.idle();
    expect(d.runClaude).toHaveBeenCalledOnce();
    const upserts = (d.state.upsertThread as any).mock.calls;
    const finalState = upserts[upserts.length - 1][1];
    expect(finalState.sessionId).toBe("S");
    expect(finalState.status).toBe("done");
  });

  it("queues a follow-up on the same thread (single-flight)", async () => {
    const releases: Array<() => void> = [];
    const d = deps({
      runClaude: vi.fn(async (input, onLine) => {
        await new Promise<void>((r) => releases.push(r));
        onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "S" }));
        onLine(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "<slack-summary>\nSummary: ok\n</slack-summary>" }] },
          })
        );
        return { exitCode: 0, signal: null, stderr: "" };
      }),
    });
    const o = new Orchestrator(d);
    await o.start();
    const p1 = o.enqueue(m());
    const p2 = o.enqueue(m({ eventId: "E2", cleanText: "fix it differently" }));
    await new Promise((r) => setTimeout(r, 10));
    expect((d.runClaude as any).mock.calls.length).toBe(1);
    releases[0]?.();
    await Promise.all([p1, p2]);
    // wait for job2 to start (queued behind job1)
    await new Promise((r) => setTimeout(r, 10));
    releases[1]?.();
    await o.idle();
    expect((d.runClaude as any).mock.calls.length).toBe(2);
  });

  it("respects global parallel cap; queues over the cap", async () => {
    const releases: Array<() => void> = [];
    const d = deps({
      maxParallelJobs: 2,
      runClaude: vi.fn(async (input, onLine) => {
        await new Promise<void>((r) => releases.push(r));
        onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "S" }));
        onLine(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "<slack-summary>\nSummary: ok\n</slack-summary>" }] },
          })
        );
        return { exitCode: 0, signal: null, stderr: "" };
      }),
    });
    const o = new Orchestrator(d);
    await o.start();
    await o.enqueue(m({ threadTs: "T1", eventId: "E1" }));
    await o.enqueue(m({ threadTs: "T2", eventId: "E2" }));
    await o.enqueue(m({ threadTs: "T3", eventId: "E3" }));
    await new Promise((r) => setTimeout(r, 10));
    expect((d.runClaude as any).mock.calls.length).toBe(2);
    expect(d.slack.addReaction).toHaveBeenCalledWith(
      "C1",
      "T3",
      "hourglass_flowing_sand"
    );
    releases.forEach((r) => r());
    // wait for job3 to start (it was queued behind the cap)
    await new Promise((r) => setTimeout(r, 10));
    releases.forEach((r) => r());
    await o.idle();
    expect((d.runClaude as any).mock.calls.length).toBe(3);
    o.stop();
  });
});

describe("Orchestrator watchdog", () => {
  it("posts a soft notice after stallSoftNoticeMs of silence", async () => {
    vi.useFakeTimers();
    const d = deps({
      coalesceMs: 0,
      stallSoftNoticeMs: 5 * 60_000,
      stallHardStopMs: 24 * 60 * 60_000,
      runClaude: vi.fn(async (input, onLine) => {
        onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "S" }));
        await new Promise((r) => setTimeout(r, 10 * 60_000));
        onLine(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "<slack-summary>\nSummary: ok\n</slack-summary>" }] },
          })
        );
        return { exitCode: 0, signal: null, stderr: "" };
      }),
    });
    const o = new Orchestrator(d);
    await o.start();
    const p = o.enqueue(m());
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
    expect(d.slack.editMessage).toHaveBeenCalledWith(
      "C1",
      "100.001",
      expect.stringContaining("No progress in 5m")
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    o.stop();
    vi.useRealTimers();
  });

  it("queue-pressure message lists stale running jobs with permalinks", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const d = deps({
      maxParallelJobs: 1,
      stallSoftNoticeMs: 5 * 60_000,
      stallHardStopMs: 24 * 60 * 60_000,
      runClaude: vi.fn(async (input, onLine) => {
        onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "S" }));
        await new Promise<void>((r) => releases.push(r));
        return { exitCode: 0, signal: null, stderr: "" };
      }),
      slack: {
        postReply: vi.fn(async () => ({ ts: "100.001" })),
        editMessage: vi.fn(async () => {}),
        addReaction: vi.fn(async () => {}),
        permalink: vi.fn(async () => "https://slack/perm/x"),
      },
    });
    const o = new Orchestrator(d);
    await o.start();
    await o.enqueue(m({ threadTs: "T1" }));
    await vi.advanceTimersByTimeAsync(6 * 60_000); // T1 becomes stale
    await o.enqueue(m({ threadTs: "T2", eventId: "E2" }));
    expect(d.slack.postReply).toHaveBeenCalledWith(
      "C1",
      "T2",
      expect.stringContaining("Queued")
    );
    expect(d.slack.postReply).toHaveBeenCalledWith(
      "C1",
      "T2",
      expect.stringContaining("https://slack/perm/x")
    );
    releases.forEach((r) => r());
    o.stop();
    vi.useRealTimers();
  });
});
