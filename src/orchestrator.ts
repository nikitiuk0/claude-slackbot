import { randomUUID } from "node:crypto";
import { parseStream, type ParseEvent } from "./claude/stream-parser.js";
import { EditCoalescer, type SlackClientFacade } from "./slack/updater.js";
import type { IncomingMention } from "./slack/adapter.js";
import type { ThreadState } from "./state/store.js";
import type { RenderedMessage } from "./prompt/build-input.js";
import type { Logger } from "./log.js";

class LineStream {
  private buf: string[] = [];
  private resolve: (() => void) | null = null;
  private done = false;

  push(line: string) {
    this.buf.push(line);
    this.resolve?.();
    this.resolve = null;
  }

  end() {
    this.done = true;
    this.resolve?.();
    this.resolve = null;
  }

  async *iterate(): AsyncIterable<string> {
    while (true) {
      if (this.buf.length > 0) {
        yield this.buf.shift()!;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => (this.resolve = r));
    }
  }
}

export type RunClaudeFn = (
  input: { stdin: string; sessionMode: { kind: "new" | "resume"; sessionId: string } },
  onLine: (line: string) => void,
  control: { onStop: (cb: () => void) => void }
) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }>;

export type FetchThreadFn = (
  channelId: string,
  threadTs: string
) => Promise<{ raw: unknown[]; rendered: RenderedMessage[] }>;

export type StateApi = {
  load(): Promise<void>;
  getThread(threadTs: string): ThreadState | undefined;
  allRunning(): Array<{ threadTs: string; state: ThreadState }>;
  upsertThread(threadTs: string, s: ThreadState): Promise<void>;
  deleteThread(threadTs: string): Promise<void>;
};

export type OrchestratorDeps = {
  maxParallelJobs: number;
  coalesceMs: number;
  stallSoftNoticeMs: number;
  stallHardStopMs: number;
  nowMs: () => number;
  fetchThread: FetchThreadFn;
  buildInitial: (input: { systemPrompt: string; thread: RenderedMessage[]; instruction: string }) => string;
  buildFollowUp: (input: { systemPrompt: string; thread: RenderedMessage[]; instruction: string }) => string;
  runClaude: RunClaudeFn;
  slack: SlackClientFacade;
  state: StateApi;
  log: Logger;
  timeZone: string;
  systemPrompt: string;
  ownerDisplayName: string;
};

type Job = {
  mention: IncomingMention;
  statusMsgTs?: string;
  lastEventAt?: number;       // ms epoch
  lastMilestone?: string;
  softNoticed?: boolean;
  /** Set when a command or watchdog terminated the run; executeJob skips post-run. */
  terminatedBy?: "stop" | "nudge" | "reset" | "watchdog-hard-stop";
  /** Set when watchdog hard-stop fires, to prevent duplicate firings. */
  hardStopped?: boolean;
  /** Per-job child logger with thread/user/event context baked in. */
  log?: Logger;
};

type ThreadSlot = {
  running: Job | null;
  queued: Job | null;
  stopController: { stop: () => void } | null;
};

export class Orchestrator {
  private threads = new Map<string, ThreadSlot>();
  private globalQueue: Job[] = [];
  private inFlight = 0;
  private inFlightPromises = new Set<Promise<void>>();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: OrchestratorDeps) {}

  async start(): Promise<void> {
    this.d.log.info("orchestrator starting");
    await this.d.state.load();
    const leftovers = this.d.state.allRunning();
    if (leftovers.length > 0) {
      this.d.log.info({ count: leftovers.length }, "found leftover running jobs from previous daemon");
    }
    for (const { threadTs, state } of leftovers) {
      const jlog = this.d.log.child({ threadTs, channelId: state.channelId, sessionId: state.sessionId });
      jlog.info("marking leftover job as interrupted");
      try {
        await this.d.slack.postReply(
          state.channelId,
          threadTs,
          "Daemon restarted; that run was interrupted. Re-mention to resume."
        );
      } catch (err) {
        jlog.error({ err }, "failed to post interrupt notice");
      }
      await this.d.state.upsertThread(threadTs, {
        ...state,
        status: "interrupted",
        updatedAt: new Date(this.d.nowMs()).toISOString(),
      });
    }
    this.watchdogTimer = setInterval(() => this.tickWatchdog(), 30_000);
    this.d.log.info({ maxParallelJobs: this.d.maxParallelJobs }, "orchestrator ready");
  }

  stop(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.d.log.info("orchestrator stopped");
  }

  private tickWatchdog(): void {
    const now = this.d.nowMs();
    for (const slot of this.threads.values()) {
      const j = slot.running;
      if (!j || !j.statusMsgTs || j.lastEventAt === undefined) continue;
      const idle = now - j.lastEventAt;
      if (!j.softNoticed && idle >= this.d.stallSoftNoticeMs) {
        j.softNoticed = true;
        (j.log ?? this.d.log).warn(
          { idleMs: idle, idleMin: Math.round(idle / 60_000) },
          "watchdog soft notice (no progress)"
        );
        void this.d.slack.editMessage(
          j.mention.channelId,
          j.statusMsgTs,
          (j.lastMilestone ?? "Working\u2026") +
            "\n\n\u26a0\ufe0f No progress in 5m. Reply 'stop' to abort or 'nudge' to wake it. Auto-stop after 24h."
        );
      }
      if (idle >= this.d.stallHardStopMs && slot.stopController && !j.hardStopped) {
        j.hardStopped = true;
        j.terminatedBy = "watchdog-hard-stop";
        (j.log ?? this.d.log).warn(
          { idleMs: idle, idleHours: (idle / 3_600_000).toFixed(1) },
          "watchdog hard-stop (24h ceiling)"
        );
        void this.d.slack.editMessage(
          j.mention.channelId,
          j.statusMsgTs,
          "Auto-stopped after 24h. Session preserved — re-mention to resume."
        );
        void this.d.slack.addReaction(j.mention.channelId, j.mention.triggerMsgTs, "x");
        const s = this.d.state.getThread(j.mention.threadTs);
        if (s) {
          void this.d.state.upsertThread(j.mention.threadTs, {
            ...s,
            status: "errored",
            updatedAt: new Date(this.d.nowMs()).toISOString(),
          });
        }
        slot.stopController.stop();
      }
    }
  }

  async enqueue(mention: IncomingMention): Promise<void> {
    const mlog = this.d.log.child({
      threadTs: mention.threadTs,
      channelId: mention.channelId,
      userId: mention.userId,
      eventId: mention.eventId,
    });
    mlog.info({ cleanTextLen: mention.cleanText.length }, "mention received");

    const cmd = mention.cleanText.trim().toLowerCase();
    if (cmd === "stop" || cmd === "nudge" || cmd === "reset" || cmd === "status") {
      mlog.info({ cmd }, "command dispatch");
      return this.handleCommand(cmd, mention, mlog);
    }

    const slot = this.threads.get(mention.threadTs) ?? {
      running: null,
      queued: null,
      stopController: null,
    };
    this.threads.set(mention.threadTs, slot);

    if (slot.running) {
      mlog.info("queued (per-thread, single-flight)");
      if (slot.queued) {
        await this.d.slack.addReaction(
          mention.channelId,
          slot.queued.mention.triggerMsgTs,
          "arrows_counterclockwise"
        );
      }
      slot.queued = { mention, log: mlog };
      return;
    }

    if (this.inFlight >= this.d.maxParallelJobs) {
      mlog.info(
        { inFlight: this.inFlight, cap: this.d.maxParallelJobs, queueDepth: this.globalQueue.length + 1 },
        "queued (global parallel cap reached)"
      );
      await this.d.slack.addReaction(mention.channelId, mention.triggerMsgTs, "hourglass_flowing_sand");
      const stale: string[] = [];
      for (const slot of this.threads.values()) {
        const j = slot.running;
        if (j && j.statusMsgTs && j.lastEventAt !== undefined) {
          const idle = this.d.nowMs() - j.lastEventAt;
          if (idle > this.d.stallSoftNoticeMs) {
            const link = await this.d.slack.permalink(j.mention.channelId, j.statusMsgTs);
            const mins = Math.round(idle / 60_000);
            stale.push(`\u2022 ${link} (no progress for ${mins}m)`);
          }
        }
      }
      const lines = [`Queued \u2014 ${this.globalQueue.length + 1} jobs ahead.`];
      if (stale.length > 0) {
        lines.push("The following running jobs haven't made progress recently and may be candidates to stop:");
        lines.push(...stale);
      }
      await this.d.slack.postReply(mention.channelId, mention.threadTs, lines.join("\n"));
      this.globalQueue.push({ mention, log: mlog });
      return;
    }

    this.startJob({ mention, log: mlog });
  }

  async idle(): Promise<void> {
    while (this.inFlightPromises.size > 0) {
      await Promise.race([...this.inFlightPromises]);
    }
  }

  private async handleCommand(
    cmd: "stop" | "nudge" | "reset" | "status",
    mention: IncomingMention,
    mlog: Logger = this.d.log
  ): Promise<void> {
    const slot = this.threads.get(mention.threadTs);

    if (cmd === "status") {
      const s = this.d.state.getThread(mention.threadTs);
      if (!s) {
        await this.d.slack.postReply(mention.channelId, mention.threadTs, "No state for this thread yet.");
        return;
      }
      await this.d.slack.postReply(
        mention.channelId,
        mention.threadTs,
        [
          `status: ${s.status}`,
          `started_at: ${s.startedAt}`,
          `last_event_at: ${s.lastEventAt}`,
          `session_id: ${s.sessionId.slice(0, 8)}…`,
        ].join("\n")
      );
      return;
    }

    if (cmd === "stop") {
      const wasRunning = !!slot?.running;
      if (slot?.running) slot.running.terminatedBy = "stop";
      if (slot?.running && slot.stopController) slot.stopController.stop();
      await this.d.slack.addReaction(mention.channelId, mention.triggerMsgTs, "stop_button");
      const s = this.d.state.getThread(mention.threadTs);
      if (s) {
        await this.d.state.upsertThread(mention.threadTs, {
          ...s,
          status: "stopped",
          updatedAt: new Date(this.d.nowMs()).toISOString(),
        });
      }
      await this.d.slack.postReply(mention.channelId, mention.threadTs, "Stopped. Re-mention to resume.");
      mlog.info({ wasRunning }, "stop processed");
      return;
    }

    if (cmd === "reset") {
      const wasRunning = !!slot?.running;
      if (slot?.running) slot.running.terminatedBy = "reset";
      if (slot?.running && slot.stopController) slot.stopController.stop();
      await this.d.state.deleteThread(mention.threadTs);
      await this.d.slack.addReaction(mention.channelId, mention.triggerMsgTs, "broom");
      await this.d.slack.postReply(mention.channelId, mention.threadTs, "Session reset. Next mention will start fresh.");
      mlog.info({ wasRunning }, "reset processed");
      return;
    }

    if (cmd === "nudge") {
      const wasRunning = !!slot?.running;
      mlog.info({ wasRunning }, "nudge processed");
      if (slot?.running) {
        // Mark the running job so executeJob skips its post-run pipeline.
        slot.running.terminatedBy = "nudge";
        // Enqueue the wake-up as a queued job so onJobDone picks it up after
        // the current run unwinds — this avoids the race of a parallel spawn.
        const nudgeMention: IncomingMention = {
          ...mention,
          cleanText:
            "You haven't made progress recently. Reassess what's blocking you and either ask a clarifying question or pick a different approach.",
        };
        // Replace any already-queued item (same semantics as a normal follow-up).
        if (slot.queued) {
          void this.d.slack.addReaction(
            slot.queued.mention.channelId,
            slot.queued.mention.triggerMsgTs,
            "arrows_counterclockwise"
          );
        }
        slot.queued = { mention: nudgeMention, log: mlog };
        if (slot.stopController) slot.stopController.stop();
      } else {
        // No running job — just fire the nudge immediately as a new run.
        await this.runJob({
          mention: {
            ...mention,
            cleanText:
              "You haven't made progress recently. Reassess what's blocking you and either ask a clarifying question or pick a different approach.",
          },
          log: mlog,
        });
      }
    }
  }

  private async runJob(job: Job): Promise<void> {
    const { threadTs } = job.mention;
    if (!this.threads.has(threadTs)) {
      this.threads.set(threadTs, { running: null, queued: null, stopController: null });
    }
    this.startJob(job);
  }

  private startJob(job: Job): void {
    this.inFlight += 1;
    const slot = this.threads.get(job.mention.threadTs)!;
    slot.running = job;

    const p: Promise<void> = this.executeJob(job).then(
      () => this.onJobDone(job, slot, p),
      () => this.onJobDone(job, slot, p)
    );
    this.inFlightPromises.add(p);
  }

  private onJobDone(job: Job, slot: ThreadSlot, p: Promise<void>): void {
    this.inFlight -= 1;
    this.inFlightPromises.delete(p);
    slot.running = null;
    slot.stopController = null;

    if (slot.queued) {
      const next = slot.queued;
      slot.queued = null;
      this.startJob(next);
    } else if (
      this.globalQueue.length > 0 &&
      this.inFlight < this.d.maxParallelJobs
    ) {
      const next = this.globalQueue.shift()!;
      this.startJob(next);
    }

    if (!slot.queued && !slot.running) {
      this.threads.delete(job.mention.threadTs);
    }
  }

  private async executeJob(job: Job): Promise<void> {
    try {
      await this.executeJobInner(job);
    } catch (err) {
      const jlog = job.log ?? this.d.log;
      jlog.error({ err }, "executeJob crashed");
      try {
        if (job.statusMsgTs) {
          await this.d.slack.editMessage(
            job.mention.channelId,
            job.statusMsgTs,
            "Internal daemon error — see logs."
          );
        } else {
          await this.d.slack.postReply(
            job.mention.channelId,
            job.mention.threadTs,
            "Internal daemon error — see logs."
          );
        }
        await this.d.slack.addReaction(job.mention.channelId, job.mention.triggerMsgTs, "x");
        const s = this.d.state.getThread(job.mention.threadTs);
        if (s) {
          await this.d.state.upsertThread(job.mention.threadTs, {
            ...s,
            status: "errored",
            updatedAt: new Date(this.d.nowMs()).toISOString(),
          });
        }
      } catch (cleanupErr) {
        jlog.error({ cleanupErr }, "failed to surface crash to Slack");
      }
    }
  }

  private async executeJobInner(job: Job): Promise<void> {
    const { mention } = job;
    const { channelId, threadTs, triggerMsgTs, cleanText } = mention;
    const jlog = job.log ?? this.d.log;
    jlog.info({ inFlight: this.inFlight }, "job execute start");

    await this.d.slack.addReaction(channelId, triggerMsgTs, "thinking_face");
    const status = await this.d.slack.postReply(
      channelId,
      threadTs,
      "Working on it… (planning)"
    );
    job.statusMsgTs = status.ts;

    const coalescer = new EditCoalescer(this.d.coalesceMs, async (text) => {
      await this.d.slack.editMessage(channelId, status.ts, text);
    });

    const existing = this.d.state.getThread(threadTs);
    const newSessionId = existing?.sessionId ?? randomUUID();
    const sessionMode = existing
      ? ({ kind: "resume" as const, sessionId: existing.sessionId })
      : ({ kind: "new" as const, sessionId: newSessionId });
    jlog.info(
      { sessionId: newSessionId, sessionMode: sessionMode.kind, statusMsgTs: status.ts },
      "spawning claude session"
    );

    const { rendered } = await this.d.fetchThread(channelId, threadTs);
    const stdin = (existing ? this.d.buildFollowUp : this.d.buildInitial)({
      systemPrompt: this.d.systemPrompt,
      thread: rendered,
      instruction: cleanText,
    });

    const startedAt = new Date(this.d.nowMs()).toISOString();
    await this.d.state.upsertThread(threadTs, {
      sessionId: newSessionId,
      channelId,
      triggerMsgTs,
      statusMsgTs: status.ts,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      lastEventAt: startedAt,
    });

    job.lastEventAt = this.d.nowMs();

    const lineStream = new LineStream();
    const milestones: string[] = [];
    let summary: string | null = null;
    let observedSessionId: string | null = null;

    const parserDone = (async () => {
      for await (const ev of parseStream(lineStream.iterate())) {
        if (ev.kind === "session-init") observedSessionId = ev.sessionId;
        else if (ev.kind === "milestone") {
          milestones.push(ev.text);
          job.lastEventAt = this.d.nowMs();
          job.lastMilestone = ev.text;
          coalescer.update(ev.text);
        } else if (ev.kind === "summary") {
          summary = ev.text;
        }
      }
    })();

    let stopCb: (() => void) | null = null;
    const slot = this.threads.get(mention.threadTs)!;
    slot.stopController = { stop: () => { if (stopCb) stopCb(); } };

    const result = await this.d.runClaude(
      { stdin, sessionMode },
      (line) => lineStream.push(line),
      { onStop: (cb) => { stopCb = cb; } }
    );
    lineStream.end();
    await parserDone;
    await coalescer.flush().catch(() => {});

    jlog.info(
      {
        exitCode: result.exitCode,
        signal: result.signal,
        milestoneCount: milestones.length,
        hasSummary: summary !== null,
        terminatedBy: job.terminatedBy ?? null,
        observedSessionId,
      },
      "claude run finished"
    );

    // If a command handler or watchdog already handled Slack + state updates,
    // skip the normal post-run pipeline to avoid clobbering their work.
    if (job.terminatedBy) {
      jlog.info({ terminatedBy: job.terminatedBy }, "skipping post-run pipeline (terminated)");
      return;
    }

    const finalSessionId = observedSessionId ?? newSessionId;
    const ts = new Date(this.d.nowMs()).toISOString();

    if (result.exitCode === 0 && summary) {
      jlog.info("job done (with summary)");
      await this.d.slack.editMessage(channelId, status.ts, summary);
      await this.d.slack.addReaction(channelId, triggerMsgTs, "white_check_mark");
      await this.d.state.upsertThread(threadTs, {
        sessionId: finalSessionId,
        channelId,
        triggerMsgTs,
        statusMsgTs: status.ts,
        status: "done",
        startedAt,
        updatedAt: ts,
        lastEventAt: ts,
      });
    } else if (result.exitCode === 0) {
      jlog.warn("job done (no structured summary returned)");
      const text =
        milestones.length > 0 ? milestones.join("\n") : "(no output)";
      await this.d.slack.editMessage(
        channelId,
        status.ts,
        `${text}\n\n_(no structured summary returned)_`
      );
      await this.d.slack.addReaction(channelId, triggerMsgTs, "white_check_mark");
      await this.d.slack.addReaction(channelId, triggerMsgTs, "shrug");
      await this.d.state.upsertThread(threadTs, {
        sessionId: finalSessionId,
        channelId,
        triggerMsgTs,
        statusMsgTs: status.ts,
        status: "done",
        startedAt,
        updatedAt: ts,
        lastEventAt: ts,
      });
    } else {
      jlog.error(
        { exitCode: result.exitCode, signal: result.signal, stderrTail: result.stderr.split("\n").slice(-5).join("\n") },
        "job errored"
      );
      const tail = result.stderr.split("\n").slice(-20).join("\n");
      await this.d.slack.editMessage(
        channelId,
        status.ts,
        `Errored.\n\n\`\`\`\n${tail}\n\`\`\``
      );
      await this.d.slack.addReaction(channelId, triggerMsgTs, "x");
      await this.d.state.upsertThread(threadTs, {
        sessionId: finalSessionId,
        channelId,
        triggerMsgTs,
        statusMsgTs: status.ts,
        status: "errored",
        startedAt,
        updatedAt: ts,
        lastEventAt: ts,
      });
    }
  }
}
