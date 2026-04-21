import { randomUUID } from "node:crypto";
import { parseStream, type ParseEvent } from "./claude/stream-parser.js";
import { EditCoalescer, type SlackClientFacade } from "./slack/updater.js";
import { toSlackMrkdwn } from "./slack/mrkdwn.js";
import type { IncomingMention } from "./slack/adapter.js";
import type { ThreadState } from "./state/store.js";
import type { MilestonesStore, HistoryEntry } from "./state/milestones.js";
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
) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; stdoutTail?: string }>;

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
  milestones: MilestonesStore;
  /** Optional — if provided, janitor also purges a thread's attachments. */
  attachments?: { purgeThread(threadTs: string): Promise<void> };
  /** ms; threads idle longer than this are archived. 0 disables the janitor. */
  archiveIdleMs: number;
  log: Logger;
  timeZone: string;
  systemPrompt: string;
  ownerDisplayName: string;
  /** Used by the status command to print a manual `claude --resume` snippet. */
  workdir: string;
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
  private janitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: OrchestratorDeps) {}

  /**
   * Replace the in-progress status message with a fresh terminal reply so
   * Slack notifies subscribers (edits don't trigger notifications).
   * Best-effort delete: if it fails, we still post the new message.
   */
  private async replaceStatusWithFinalReply(
    channelId: string,
    threadTs: string,
    statusMsgTs: string | undefined,
    text: string,
    jlog: Logger
  ): Promise<void> {
    if (statusMsgTs) {
      try {
        await this.d.slack.deleteMessage(channelId, statusMsgTs);
      } catch (err) {
        jlog.warn({ err, statusMsgTs }, "failed to delete in-progress status message");
      }
    }
    await this.d.slack.postReply(channelId, threadTs, text);
  }

  /**
   * Remove the in-flight 🤔 reaction from the trigger message. Best-effort.
   * Called at every terminal path so the trigger is left with only the
   * final ✅/❌ (no leftover thinking face).
   */
  private async clearThinkingReaction(
    channelId: string,
    triggerMsgTs: string,
    jlog: Logger
  ): Promise<void> {
    try {
      await this.d.slack.removeReaction(channelId, triggerMsgTs, "thinking_face");
    } catch (err) {
      jlog.warn({ err, triggerMsgTs }, "failed to remove thinking_face reaction");
    }
  }

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

    if (this.d.archiveIdleMs > 0) {
      // Kick once on startup, then every hour.
      void this.runJanitor().catch((err) =>
        this.d.log.error({ err }, "janitor startup tick failed")
      );
      this.janitorTimer = setInterval(
        () => void this.runJanitor().catch((err) =>
          this.d.log.error({ err }, "janitor tick failed")
        ),
        60 * 60 * 1000
      );
    }

    this.d.log.info({ maxParallelJobs: this.d.maxParallelJobs }, "orchestrator ready");
  }

  stop(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.janitorTimer !== null) {
      clearInterval(this.janitorTimer);
      this.janitorTimer = null;
    }
    this.d.log.info("orchestrator stopped");
  }

  /**
   * Drop thread state + milestones + attachments for any thread whose
   * `lastEventAt` is older than `archiveIdleMs`. Skips threads that have
   * an in-flight job (we never archive something currently running).
   */
  private async runJanitor(): Promise<void> {
    const cutoffMs = this.d.nowMs() - this.d.archiveIdleMs;
    const purged: string[] = [];
    // The StateApi currently only exposes getThread / allRunning / upsert / delete.
    // We need a full listing — use allRunning plus a new enumeration helper.
    // For simplicity, we enumerate via the "load once, look through the map"
    // approach: StateStore internally has all entries; we iterate via a new
    // method `allThreads()`. But to avoid widening the StateApi surface area
    // just for this, we rely on the janitor being best-effort + the state
    // store exposing allThreads() (added below).
    const all = (this.d.state as StateApi & {
      allThreads?: () => Array<{ threadTs: string; state: ThreadState }>;
    }).allThreads?.() ?? [];
    for (const { threadTs, state } of all) {
      if (state.status === "running") continue; // never archive live threads
      const lastEvent = Date.parse(state.lastEventAt);
      if (!Number.isFinite(lastEvent) || lastEvent > cutoffMs) continue;
      try {
        await this.d.state.deleteThread(threadTs);
        await this.d.milestones.purgeThread(threadTs).catch(() => {});
        if (this.d.attachments) {
          await this.d.attachments.purgeThread(threadTs).catch(() => {});
        }
        purged.push(threadTs);
      } catch (err) {
        this.d.log.warn({ err, threadTs }, "janitor failed to purge thread");
      }
    }
    if (purged.length > 0) {
      this.d.log.info({ count: purged.length }, "janitor archived idle threads");
    }
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
        const wlog = j.log ?? this.d.log;
        wlog.warn(
          { idleMs: idle, idleHours: (idle / 3_600_000).toFixed(1) },
          "watchdog hard-stop (24h ceiling)"
        );
        void this.replaceStatusWithFinalReply(
          j.mention.channelId,
          j.mention.threadTs,
          j.statusMsgTs,
          "Auto-stopped after 24h. Session preserved — re-mention to resume.",
          wlog
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

    const rawCmd = mention.cleanText.trim().toLowerCase();
    const cmd =
      rawCmd === "ping" ? "nudge" :
      rawCmd === "stop" || rawCmd === "nudge" || rawCmd === "reset" ||
      rawCmd === "status" || rawCmd === "help" || rawCmd === "history" ? rawCmd :
      null;
    if (cmd) {
      mlog.info({ cmd, alias: rawCmd !== cmd ? rawCmd : undefined }, "command dispatch");
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
    cmd: "stop" | "nudge" | "reset" | "status" | "help" | "history",
    mention: IncomingMention,
    mlog: Logger = this.d.log
  ): Promise<void> {
    const slot = this.threads.get(mention.threadTs);

    if (cmd === "help") {
      await this.d.slack.postReply(
        mention.channelId,
        mention.threadTs,
        [
          "Available commands (mention me followed by one of these in this thread):",
          "• `stop` — kill the current run; session preserved (re-mention to resume)",
          "• `nudge` (alias: `ping`) — wake me up if I'm stuck; resumes the session with a reassess prompt",
          "• `reset` — wipe my session memory for this thread; next mention starts a brand-new run",
          "• `status` — show current state for this thread + how to resume the session manually",
          "• `history` — show the milestones from the most recent run on this thread",
          "• `help` — show this list",
          "",
          "To start work: just mention me with what you want me to do.",
        ].join("\n")
      );
      return;
    }

    if (cmd === "history") {
      const entries = await this.d.milestones.readLastRun(mention.threadTs);
      if (entries.length === 0) {
        await this.d.slack.postReply(
          mention.channelId,
          mention.threadTs,
          "No history yet for this thread."
        );
        return;
      }
      await this.d.slack.postReply(
        mention.channelId,
        mention.threadTs,
        formatHistory(entries)
      );
      return;
    }

    if (cmd === "status") {
      const s = this.d.state.getThread(mention.threadTs);
      if (!s) {
        await this.d.slack.postReply(mention.channelId, mention.threadTs, "No state for this thread yet.");
        return;
      }
      const resumeSnippet = [
        "```",
        `cd ${this.d.workdir}`,
        `claude --resume ${s.sessionId}`,
        "```",
      ].join("\n");
      const recentMilestones = await this.d.milestones
        .readLastRun(mention.threadTs)
        .then((entries) =>
          entries.filter((e): e is Extract<typeof e, { kind: "milestone" }> => e.kind === "milestone").slice(-3)
        )
        .catch(() => []);
      const lines = [
        `status: ${s.status}`,
        `started_at: ${s.startedAt}`,
        `last_event_at: ${s.lastEventAt}`,
      ];
      if (recentMilestones.length > 0) {
        lines.push("", "Recent milestones:");
        for (const m of recentMilestones) {
          lines.push(`• ${m.ts.slice(11, 19)}  ${toSingleLine(m.text, 200)}`);
        }
      }
      lines.push("", "Resume manually:", resumeSnippet);
      await this.d.slack.postReply(mention.channelId, mention.threadTs, lines.join("\n"));
      return;
    }

    if (cmd === "stop") {
      const wasRunning = !!slot?.running;
      if (slot?.running) slot.running.terminatedBy = "stop";
      if (slot?.running && slot.stopController) slot.stopController.stop();
      await this.d.slack.addReaction(mention.channelId, mention.triggerMsgTs, "octagonal_sign");
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
        await this.clearThinkingReaction(job.mention.channelId, job.mention.triggerMsgTs, jlog);
        await this.replaceStatusWithFinalReply(
          job.mention.channelId,
          job.mention.threadTs,
          job.statusMsgTs,
          "Internal daemon error — see logs.",
          jlog
        );
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
    await this.d.milestones.append(threadTs, {
      ts: startedAt,
      kind: "start",
      sessionId: existing?.sessionId ?? newSessionId,
      sessionMode: sessionMode.kind,
      instruction: cleanText,
    });

    job.lastEventAt = this.d.nowMs();

    const lineStream = new LineStream();
    const milestones: string[] = [];
    let summary: string | null = null;
    let lastAssistantText: string | null = null;
    let observedSessionId: string | null = null;

    let parserError: string | undefined;
    const parserDone = (async () => {
      for await (const ev of parseStream(lineStream.iterate())) {
        if (ev.kind === "session-init") observedSessionId = ev.sessionId;
        else if (ev.kind === "result" && !ev.success) {
          parserError = ev.error ?? `result subtype=${ev.subtype}`;
        }
        else if (ev.kind === "milestone") {
          milestones.push(ev.text);
          job.lastEventAt = this.d.nowMs();
          job.lastMilestone = ev.text;
          coalescer.update(ev.text);
          // Persist for `history` command. Best-effort — ignore disk hiccups.
          this.d.milestones
            .append(threadTs, {
              ts: new Date(this.d.nowMs()).toISOString(),
              kind: "milestone",
              text: ev.text,
            })
            .catch((err) => jlog.warn({ err }, "failed to persist milestone"));
        } else if (ev.kind === "text") {
          lastAssistantText = ev.text;
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

    // Always clear the thinking face on the trigger — runs that finish
    // here (and runs that were terminated externally) shouldn't leave a
    // 🤔 hanging next to the final ✅/❌/🛑.
    await this.clearThinkingReaction(channelId, triggerMsgTs, jlog);

    // Decide the terminal status now so we can persist the run-end record
    // exactly once (even on the terminatedBy fast-return path below).
    const finalStatus =
      job.terminatedBy === "stop" ? "stopped" :
      job.terminatedBy === "reset" ? "reset" :
      job.terminatedBy === "nudge" ? "stopped" :
      job.terminatedBy === "watchdog-hard-stop" ? "errored" :
      result.exitCode === 0 ? "done" :
      "errored";
    await this.d.milestones
      .append(threadTs, {
        ts: new Date(this.d.nowMs()).toISOString(),
        kind: "end",
        status: finalStatus,
        exitCode: result.exitCode,
        signal: result.signal,
        terminatedBy: job.terminatedBy,
      })
      .catch((err) => jlog.warn({ err }, "failed to persist run-end"));

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
      await this.replaceStatusWithFinalReply(channelId, threadTs, status.ts, toSlackMrkdwn(summary), jlog);
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
      jlog.warn(
        {
          sawText: Boolean(lastAssistantText),
          lastTextSnippet: lastAssistantText
            ? (lastAssistantText as string).slice(0, 500)
            : undefined,
          milestoneCount: milestones.length,
        },
        "job done (no structured summary returned)"
      );
      await this.replaceStatusWithFinalReply(
        channelId,
        threadTs,
        status.ts,
        formatNoSummaryMessage(milestones),
        jlog
      );
      await this.d.slack.addReaction(channelId, triggerMsgTs, "warning");
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
        {
          exitCode: result.exitCode,
          signal: result.signal,
          parserError,
          stderrTail: result.stderr.split("\n").slice(-5).join("\n"),
          stdoutTail: (result.stdoutTail ?? "").split("\n").slice(-20).join("\n"),
        },
        "job errored"
      );
      // Keep the Slack message short — full stdout/stderr live in the log file.
      const stderrSnippet = result.stderr.trim().split("\n").slice(-3).join("\n");
      const body = parserError
        ? parserError
        : stderrSnippet || "(no error output — see daemon log for details)";
      await this.replaceStatusWithFinalReply(
        channelId,
        threadTs,
        status.ts,
        `❌ Errored (exit ${result.exitCode}).\n\`\`\`\n${body}\n\`\`\``,
        jlog
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

/** Render the most recent run's history into a Slack-friendly code block. */
export function formatHistory(entries: HistoryEntry[]): string {
  const MAX_LINES = 60;
  const lines: string[] = [];
  for (const e of entries) {
    const time = e.ts.slice(11, 19); // HH:MM:SS from ISO
    if (e.kind === "start") {
      lines.push(
        `${time} START session=${e.sessionId.slice(0, 8)} (${e.sessionMode})  «${toSingleLine(e.instruction, 120)}»`
      );
    } else if (e.kind === "milestone") {
      lines.push(`${time}   ${toSingleLine(e.text, 200)}`);
    } else if (e.kind === "end") {
      const tags = [e.status];
      if (e.exitCode !== null) tags.push(`exit=${e.exitCode}`);
      if (e.signal) tags.push(e.signal);
      if (e.terminatedBy) tags.push(`by=${e.terminatedBy}`);
      lines.push(`${time} END   ${tags.join(" ")}`);
    }
  }

  let body: string;
  if (lines.length <= MAX_LINES) {
    body = lines.join("\n");
  } else {
    const head = lines.slice(0, 5);
    const tail = lines.slice(-(MAX_LINES - 5));
    body = [
      ...head,
      `… (${lines.length - head.length - tail.length} entries omitted) …`,
      ...tail,
    ].join("\n");
  }
  return ["History (most recent run):", "```", body, "```"].join("\n");
}

/**
 * Build the Slack message for the "exit 0 but no <slack-summary>" path.
 * Shows up to the last 3 milestones as context so the operator can see what
 * Claude was doing just before it punted, then points at `nudge` / `reset`.
 */
export function formatNoSummaryMessage(milestones: string[]): string {
  const lines = ["⚠️ Claude ended its turn without a summary."];
  if (milestones.length > 0) {
    const tail = milestones.slice(-3);
    lines.push("", "Last actions:");
    for (const m of tail) lines.push(`• ${toSingleLine(m, 200)}`);
  }
  lines.push(
    "",
    "This usually means the session is stuck. Try `nudge` or `reset`."
  );
  return lines.join("\n");
}

/**
 * Force a single-line rendering of arbitrary text for Slack: take the first
 * non-empty line, cap at `max` chars, append " …" if anything was dropped.
 * Idempotent — safe to apply to already-compact input.
 */
export function toSingleLine(text: string, max: number): string {
  const hasNewline = text.includes("\n");
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const overlong = first.length > max;
  const body = overlong ? first.slice(0, max) : first;
  return hasNewline || overlong ? `${body} …` : body;
}
