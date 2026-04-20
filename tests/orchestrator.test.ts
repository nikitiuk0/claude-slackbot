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
      deleteMessage: vi.fn(async () => {}),
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
    log: (() => {
      const noop = () => {};
      const stub: any = {
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        trace: noop,
        fatal: noop,
      };
      stub.child = () => stub;
      return stub;
    })(),
    timeZone: "UTC",
    systemPrompt: "SYS",
    ownerDisplayName: "alice",
    workdir: "/tmp/sandbox",
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

  it("on completion, deletes the in-progress message and posts the summary as a new reply", async () => {
    const d = deps();
    const o = new Orchestrator(d);
    await o.start();
    await o.enqueue(m());
    await o.idle();
    // Status message ts comes from postReply mock returning "100.001".
    expect(d.slack.deleteMessage).toHaveBeenCalledWith("C1", "100.001");
    // Two postReply calls: the initial "Working on it…" and the final summary.
    const replyCalls = (d.slack.postReply as any).mock.calls;
    expect(replyCalls.length).toBe(2);
    expect(replyCalls[0][2]).toMatch(/Working on it/);
    expect(replyCalls[1][2]).toMatch(/Summary: ok/);
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

  it("watchdog hard-stop posts auto-stop message and avoids double error", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const d = deps({
      coalesceMs: 0,
      stallSoftNoticeMs: 5 * 60_000,
      stallHardStopMs: 24 * 60 * 60_000,
      runClaude: vi.fn(async (input, onLine, control) => {
        control.onStop(() => release());
        onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "S" }));
        await new Promise<void>((r) => (release = r));
        return { exitCode: 130, signal: "SIGTERM" as NodeJS.Signals, stderr: "" };
      }),
    });
    const o = new Orchestrator(d);
    await o.start();
    const p = o.enqueue(m());
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 30_000);
    await p;
    o.stop();
    vi.useRealTimers();
    // The terminal "Auto-stopped" notice goes out as a NEW reply (so Slack
    // notifies subscribers), not an edit of the in-progress message.
    const replyCalls = (d.slack.postReply as any).mock.calls;
    const autoStopMsg = replyCalls.some((c: any[]) =>
      typeof c[2] === "string" && c[2].includes("Auto-stopped after 24h")
    );
    expect(autoStopMsg).toBe(true);
    // The in-progress message should be deleted before the new reply.
    expect(d.slack.deleteMessage).toHaveBeenCalledWith("C1", "100.001");
    // The error-branch "Errored." message must NOT be sent (terminatedBy guard).
    const erroredReply = replyCalls.some((c: any[]) =>
      typeof c[2] === "string" && c[2].startsWith("Errored.")
    );
    expect(erroredReply).toBe(false);
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
        deleteMessage: vi.fn(async () => {}),
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

describe("Orchestrator commands", () => {
  it("stop kills running subprocess and sets status to stopped", async () => {
    let resolve: () => void = () => {};
    const stops: number[] = [];
    const d = deps({
      runClaude: vi.fn(async (input, onLine, control) => {
        control.onStop(() => stops.push(1));
        onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "S" }));
        await new Promise<void>((r) => (resolve = r));
        return { exitCode: 130, signal: "SIGTERM" as NodeJS.Signals, stderr: "" };
      }),
      state: {
        load: vi.fn(async () => {}),
        getThread: vi.fn(() => ({
          sessionId: "S", channelId: "C1", triggerMsgTs: "T1", statusMsgTs: "100.001",
          status: "running", startedAt: "x", updatedAt: "x", lastEventAt: "x",
        } as any)),
        allRunning: vi.fn(() => []),
        upsertThread: vi.fn(async () => {}),
        deleteThread: vi.fn(async () => {}),
      },
    });
    const o = new Orchestrator(d);
    await o.start();
    void o.enqueue(m({ cleanText: "fix it" }));
    await new Promise((r) => setTimeout(r, 10));
    await o.enqueue(m({ eventId: "E2", cleanText: "stop" }));
    expect(stops.length).toBe(1);
    resolve();
    await o.idle();
    o.stop();
    const upserts = (d.state.upsertThread as any).mock.calls;
    // The FINAL upsert must be "stopped" — not clobbered by the errored branch.
    const finalStatus = upserts[upserts.length - 1][1].status;
    expect(finalStatus).toBe("stopped");
    // The :x: reaction from the error branch must NOT have been added.
    const reactionCalls = (d.slack.addReaction as any).mock.calls;
    const addedX = reactionCalls.some((c: any[]) => c[2] === "x");
    expect(addedX).toBe(false);
  });

  it("stop preserves status: stopped after the killed run unwinds", async () => {
    let release: () => void = () => {};
    const d = deps({
      runClaude: vi.fn(async (input, onLine, control) => {
        control.onStop(() => release());
        onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "S" }));
        await new Promise<void>((r) => (release = r));
        return { exitCode: 130, signal: "SIGTERM" as NodeJS.Signals, stderr: "killed" };
      }),
      state: {
        load: vi.fn(async () => {}),
        getThread: vi.fn(() => ({
          sessionId: "S", channelId: "C1", triggerMsgTs: "T1", statusMsgTs: "100.001",
          status: "running", startedAt: "x", updatedAt: "x", lastEventAt: "x",
        } as any)),
        allRunning: vi.fn(() => []),
        upsertThread: vi.fn(async () => {}),
        deleteThread: vi.fn(async () => {}),
      },
    });
    const o = new Orchestrator(d);
    await o.start();
    void o.enqueue(m({ cleanText: "fix it" }));
    await new Promise((r) => setTimeout(r, 10));
    await o.enqueue(m({ eventId: "E2", cleanText: "stop" }));
    await o.idle();
    o.stop();
    const upserts = (d.state.upsertThread as any).mock.calls;
    const finalStatus = upserts[upserts.length - 1][1].status;
    expect(finalStatus).toBe("stopped");
    // x reaction must NOT have been added
    const reactionCalls = (d.slack.addReaction as any).mock.calls;
    const addedX = reactionCalls.some((c: any[]) => c[2] === "x");
    expect(addedX).toBe(false);
  });

  it("nudge doesn't leak parallel jobs", async () => {
    // Track concurrent runClaude invocations
    let concurrent = 0;
    let maxConcurrent = 0;
    const stdins: string[] = [];
    const releases: Array<() => void> = [];
    const d = deps({
      runClaude: vi.fn(async (input, onLine, control) => {
        stdins.push(input.stdin);
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        try {
          if (stdins.length === 1) {
            control.onStop(() => releases[0]?.());
            await new Promise<void>((r) => releases.push(r));
            return { exitCode: 130, signal: "SIGTERM" as NodeJS.Signals, stderr: "" };
          }
          onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "S" }));
          onLine(JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "<slack-summary>\nSummary: ok\n</slack-summary>" }] },
          }));
          return { exitCode: 0, signal: null, stderr: "" };
        } finally {
          concurrent--;
        }
      }),
    });
    const o = new Orchestrator(d);
    await o.start();
    void o.enqueue(m({ cleanText: "fix it" }));
    await new Promise((r) => setTimeout(r, 10));
    await o.enqueue(m({ eventId: "E2", cleanText: "nudge" }));
    await o.idle();
    o.stop();
    expect(maxConcurrent).toBe(1);
    expect(stdins.length).toBe(2);
    expect(stdins[1]).toMatch(/Reassess what's blocking/);
  });

  it("reset wipes the thread state", async () => {
    const d = deps({
      state: {
        load: vi.fn(async () => {}),
        getThread: vi.fn(() => ({ sessionId: "old" } as any)),
        allRunning: vi.fn(() => []),
        upsertThread: vi.fn(async () => {}),
        deleteThread: vi.fn(async () => {}),
      },
    });
    const o = new Orchestrator(d);
    await o.start();
    await o.enqueue(m({ cleanText: "reset" }));
    o.stop();
    expect(d.state.deleteThread).toHaveBeenCalledWith("T1");
    expect(d.slack.addReaction).toHaveBeenCalledWith("C1", "T1", "broom");
  });

  it("status replies with the current thread state and a manual resume snippet", async () => {
    const d = deps({
      workdir: "/Users/me/work/sandbox",
      state: {
        load: vi.fn(async () => {}),
        getThread: vi.fn(() => ({
          sessionId: "abc12345-aaaa-bbbb-cccc-ddddeeeeffff",
          status: "done",
          startedAt: "2026-04-19T00:00:00Z",
          lastEventAt: "2026-04-19T00:01:00Z",
        } as any)),
        allRunning: vi.fn(() => []),
        upsertThread: vi.fn(async () => {}),
        deleteThread: vi.fn(async () => {}),
      },
    });
    const o = new Orchestrator(d);
    await o.start();
    await o.enqueue(m({ cleanText: "status" }));
    o.stop();
    const replyCalls = (d.slack.postReply as any).mock.calls;
    const replyText = replyCalls.find((c: any[]) => typeof c[2] === "string" && c[2].includes("status:"))[2];
    expect(replyText).toMatch(/status: done/);
    expect(replyText).not.toMatch(/^session_id:/m);
    expect(replyText).toContain("Resume manually:");
    expect(replyText).toContain("cd /Users/me/work/sandbox");
    expect(replyText).toContain("claude --resume abc12345-aaaa-bbbb-cccc-ddddeeeeffff");
  });

  it("help command lists all commands", async () => {
    const d = deps();
    const o = new Orchestrator(d);
    await o.start();
    await o.enqueue(m({ cleanText: "help" }));
    o.stop();
    const replyCalls = (d.slack.postReply as any).mock.calls;
    const replyText = replyCalls[replyCalls.length - 1][2];
    expect(replyText).toContain("`stop`");
    expect(replyText).toContain("`nudge`");
    expect(replyText).toContain("alias: `ping`");
    expect(replyText).toContain("`reset`");
    expect(replyText).toContain("`status`");
    expect(replyText).toContain("`help`");
  });

  it("ping is treated as a nudge alias", async () => {
    const stdins: string[] = [];
    let release: () => void = () => {};
    const d = deps({
      runClaude: vi.fn(async (input, onLine, control) => {
        stdins.push(input.stdin);
        if (stdins.length === 1) {
          control.onStop(() => release());
          await new Promise<void>((r) => (release = r));
          return { exitCode: 130, signal: "SIGTERM" as NodeJS.Signals, stderr: "" };
        }
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
    void o.enqueue(m({ cleanText: "fix it" }));
    await new Promise((r) => setTimeout(r, 10));
    await o.enqueue(m({ eventId: "E2", cleanText: "ping" }));
    await o.idle();
    o.stop();
    expect(stdins.length).toBe(2);
    expect(stdins[1]).toMatch(/Reassess what's blocking/);
  });

  it("nudge stops the run, then resumes the session with a wake-up turn", async () => {
    const stdins: string[] = [];
    let release: () => void = () => {};
    const releases: Array<() => void> = [];
    const d = deps({
      runClaude: vi.fn(async (input, onLine, control) => {
        stdins.push(input.stdin);
        if (stdins.length === 1) {
          control.onStop(() => release());
          await new Promise<void>((r) => (release = r));
          return { exitCode: 130, signal: "SIGTERM" as NodeJS.Signals, stderr: "" };
        }
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
    void o.enqueue(m({ cleanText: "fix it" }));
    await new Promise((r) => setTimeout(r, 10));
    await o.enqueue(m({ eventId: "E2", cleanText: "nudge" }));
    await o.idle();
    o.stop();
    expect(stdins.length).toBe(2);
    expect(stdins[1]).toMatch(/Reassess what's blocking/);
  });
});

describe("Orchestrator startup recovery", () => {
  it("marks leftover running jobs as interrupted and posts in their threads", async () => {
    const leftover = {
      sessionId: "old",
      channelId: "C1",
      triggerMsgTs: "1.001",
      statusMsgTs: "1.002",
      status: "running" as const,
      startedAt: "2026-04-18T00:00:00Z",
      updatedAt: "2026-04-18T00:00:00Z",
      lastEventAt: "2026-04-18T00:00:00Z",
    };
    const d = deps({
      state: {
        load: vi.fn(async () => {}),
        getThread: vi.fn(() => undefined),
        allRunning: vi.fn(() => [{ threadTs: "T1", state: leftover }]),
        upsertThread: vi.fn(async () => {}),
        deleteThread: vi.fn(async () => {}),
      },
    });
    const o = new Orchestrator(d);
    await o.start();
    o.stop();
    expect(d.slack.postReply).toHaveBeenCalledWith(
      "C1",
      "T1",
      expect.stringMatching(/Daemon restarted/)
    );
    expect(d.state.upsertThread).toHaveBeenCalledWith(
      "T1",
      expect.objectContaining({ status: "interrupted" })
    );
  });
});
