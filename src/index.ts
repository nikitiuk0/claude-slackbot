import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { StateStore } from "./state/store.js";
import { MilestonesStore } from "./state/milestones.js";
import { AttachmentsStore } from "./slack/attachments.js";
import { IdentityGate } from "./identity-gate.js";
import { ClaudeRunner } from "./claude/runner.js";
import { SlackAdapter } from "./slack/adapter.js";
import { fetchThread } from "./slack/thread-fetch.js";
import { makeSlackClientFacade } from "./slack/updater.js";
import type { SlackClientFacade } from "./slack/updater.js";
import { buildInitialInput, buildFollowUpInput } from "./prompt/build-input.js";
import { Orchestrator } from "./orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  dotenv.config();
  const json = JSON.parse(await fs.readFile("config.json", "utf8"));
  const cfg = loadConfig({ env: process.env, json });
  const log = createLogger({ level: cfg.logLevel, logFile: cfg.logFile });
  log.info(
    { workdir: cfg.workdir, logFile: cfg.logFile, logLevel: cfg.logLevel },
    "starting daemon"
  );

  const state = new StateStore("./data/state.json");
  const milestones = new MilestonesStore("./data/milestones");
  const attachments = new AttachmentsStore("./data/attachments", cfg.slackBotToken);
  const gate = new IdentityGate({
    allowed: cfg.allowedUserIds,
    rejectCooldownMs: 60 * 60 * 1000,
  });
  const systemPrompt = await fs.readFile(
    join(here, "prompt", "system-prompt.txt"),
    "utf8"
  );

  const runner = new ClaudeRunner({
    binary: cfg.claudeBinary,
    cwd: cfg.workdir,
    log: log.child({ component: "claude-runner" }),
  });

  // We need slackFacade to construct the orchestrator, but we also need the
  // orchestrator to handle mentions from the adapter. Order: start adapter
  // (so we have a client), build facade, build orchestrator, start orchestrator.
  // The adapter's onMention is wired AFTER orchestrator exists, via a closure
  // captured in a promise-resolution dance, OR via a module-level ref. The
  // simpler approach: declare a `let orchestrator` and `let slackFacade`,
  // construct adapter with onMention that references them at call-time.

  let orchestrator: Orchestrator;
  let slackFacade: SlackClientFacade;

  const slackAdapter = new SlackAdapter({
    botToken: cfg.slackBotToken,
    appToken: cfg.slackAppToken,
    onMention: (m) => {
      const admit = gate.admit(m.userId, Date.now());
      if (!admit.ok) {
        if (admit.shouldNotify) {
          slackFacade
            .addReaction(m.channelId, m.triggerMsgTs, "no_entry_sign")
            .catch((err) => log.warn({ err }, "rejection reaction failed"));
          slackFacade
            .postReply(
              m.channelId,
              m.threadTs,
              `Sorry, this bot is wired to ${cfg.ownerDisplayName}'s laptop and won't respond to others. (Multi-user is on the roadmap.)`
            )
            .catch((err) => log.warn({ err }, "rejection reply failed"));
        }
        return;
      }
      orchestrator.enqueue(m).catch((err) =>
        log.error({ err }, "enqueue failed")
      );
    },
    onError: (err) => log.error({ err }, "slack adapter error"),
  });

  await slackAdapter.start();
  slackFacade = makeSlackClientFacade(slackAdapter.client());

  orchestrator = new Orchestrator({
    maxParallelJobs: cfg.maxParallelJobs,
    coalesceMs: cfg.slackEditCoalesceMs,
    nowMs: () => Date.now(),
    fetchThread: (channelId, threadTs) =>
      fetchThread(slackAdapter.client(), channelId, threadTs, "UTC", attachments),
    buildInitial: buildInitialInput,
    buildFollowUp: buildFollowUpInput,
    runClaude: async (input, onLine, control) => {
      control.onStop(() => runner.stop());
      return runner.run({
        stdin: input.stdin,
        sessionMode: input.sessionMode,
        onLine,
      });
    },
    slack: slackFacade,
    state,
    milestones,
    attachments,
    archiveIdleMs: cfg.archiveIdleDays * 24 * 60 * 60 * 1000,
    log,
    timeZone: "UTC",
    systemPrompt,
    ownerDisplayName: cfg.ownerDisplayName,
    workdir: cfg.workdir,
    stallSoftNoticeMs: cfg.stallSoftNoticeMinutes * 60_000,
    stallHardStopMs: cfg.stallHardStopHours * 60 * 60_000,
  });

  await orchestrator.start();
  log.info("ready");

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    orchestrator.stop?.();
    await slackAdapter.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
