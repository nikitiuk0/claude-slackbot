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
    await this.d.state.load();
    this.watchdogTimer = setInterval(() => this.tickWatchdog(), 30_000);
  }

  stop(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
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
        void this.d.slack.editMessage(
          j.mention.channelId,
          j.statusMsgTs,
          (j.lastMilestone ?? "Working\u2026") +
            "\n\n\u26a0\ufe0f No progress in 5m. Reply 'stop' to abort or 'nudge' to wake it. Auto-stop after 24h."
        );
      }
      if (idle >= this.d.stallHardStopMs && slot.stopController) {
        slot.stopController.stop();
      }
    }
  }

  async enqueue(mention: IncomingMention): Promise<void> {
    const slot = this.threads.get(mention.threadTs) ?? {
      running: null,
      queued: null,
      stopController: null,
    };
    this.threads.set(mention.threadTs, slot);

    if (slot.running) {
      if (slot.queued) {
        await this.d.slack.addReaction(
          mention.channelId,
          slot.queued.mention.triggerMsgTs,
          "arrows_counterclockwise"
        );
      }
      slot.queued = { mention };
      return;
    }

    if (this.inFlight >= this.d.maxParallelJobs) {
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
      this.globalQueue.push({ mention });
      return;
    }

    this.startJob({ mention });
  }

  async idle(): Promise<void> {
    while (this.inFlightPromises.size > 0) {
      await Promise.race([...this.inFlightPromises]);
    }
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
    const { mention } = job;
    const { channelId, threadTs, triggerMsgTs, cleanText } = mention;

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
    await coalescer.flush();

    const finalSessionId = observedSessionId ?? newSessionId;
    const ts = new Date(this.d.nowMs()).toISOString();

    if (result.exitCode === 0 && summary) {
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
