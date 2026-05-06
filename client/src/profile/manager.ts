import { promises as fs, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importJWK, type KeyLike } from "jose";
import { loadKeypair } from "../identity/keypair.js";
import { parseProfileConfig } from "./config.js";
import { ServerConnection } from "../transport/server-connection.js";
import { detectProxyForUrl, buildProxyAgent } from "../transport/proxy.js";
import { createRemoteSlackFacade } from "../transport/remote-slack-facade.js";
import { normalizeServerEvent } from "../transport/server-adapter.js";
import { Orchestrator } from "../core/orchestrator.js";
import { StateStore } from "../core/state/store.js";
import { MilestonesStore } from "../core/state/milestones.js";
import { AttachmentsStore } from "../core/slack/attachments.js";
import { ClaudeRunner } from "../core/claude/runner.js";
import { buildInitialInput, buildFollowUpInput } from "../core/prompt/build-input.js";
import { toRenderedMessages } from "../core/slack/thread-fetch.js";
import { createLogger } from "../core/log.js";

/**
 * Discover all named profile directories under `<home>/profiles/`.
 * A valid profile directory must exist and contain a `config.json` file.
 */
export function discoverProfiles(home: string): Array<{ name: string; dir: string }> {
  const profilesRoot = join(home, "profiles");
  if (!existsSync(profilesRoot)) return [];
  return readdirSync(profilesRoot)
    .filter((name) => {
      const dir = join(profilesRoot, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "config.json"));
    })
    .map((name) => ({ name, dir: join(profilesRoot, name) }));
}

/**
 * Wire up all components for a single profile and start the orchestrator +
 * server connection. Returns a `stop()` handle to cleanly shut down.
 */
export async function startProfile(opts: {
  profileDir: string;
  profileName: string;
}): Promise<{ stop: () => Promise<void> }> {
  const keypairPath = join(opts.profileDir, "identity", "keypair.json");
  const pinnedKeyPath = join(opts.profileDir, "pinned-server-key.pub");
  const configPath = join(opts.profileDir, "config.json");
  const machineIdPath = join(opts.profileDir, "identity", "machine_id");

  const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  const config = parseProfileConfig(rawConfig);
  const log = createLogger({
    level: process.env.LOG_LEVEL ?? "info",
    logFile: join(opts.profileDir, "logs", "daemon.log"),
  }).child({ profile: opts.profileName });

  const keypair = await loadKeypair(keypairPath);
  const pinnedJwk = JSON.parse(await fs.readFile(pinnedKeyPath, "utf8"));
  const serverPublicKey = (await importJWK(pinnedJwk, "EdDSA")) as KeyLike;
  const machineId = (await fs.readFile(machineIdPath, "utf8")).trim();

  // Late-bound connection so the facade can call connection.send() once defined.
  let connection!: ServerConnection;
  const facade = createRemoteSlackFacade({
    send: (m) => connection.send(m),
    timeoutMs: 30_000,
  });

  const state = new StateStore(join(opts.profileDir, "data", "state.json"));
  const milestones = new MilestonesStore(join(opts.profileDir, "data", "milestones"));
  const attachments = new AttachmentsStore(
    join(opts.profileDir, "data", "attachments"),
    "",  // TODO Phase B: file downloads proxied via slack_rpc_request "downloadFile"
    log.child({ component: "attachments" })
  );
  const runner = new ClaudeRunner({
    binary: config.claudeBinary,
    cwd: config.workdir,
    log: log.child({ component: "claude-runner" }),
  });

  const systemPromptPath = fileURLToPath(new URL("../core/prompt/system-prompt.txt", import.meta.url));
  const systemPrompt = await fs.readFile(systemPromptPath, "utf8");

  const orchestrator = new Orchestrator({
    maxParallelJobs: config.maxParallelJobs,
    coalesceMs: config.slackEditCoalesceMs,
    stallSoftNoticeMs: config.stallSoftNoticeMinutes * 60_000,
    stallHardStopMs: config.stallHardStopHours * 60 * 60 * 1000,
    nowMs: () => Date.now(),
    fetchThread: async (channelId, threadTs) => {
      const { raw, displayNames } = await facade.getThread(channelId, threadTs);
      const dnMap = new Map<string, string>(Object.entries(displayNames));
      const rendered = toRenderedMessages(raw as any[], dnMap, "UTC");
      return { raw: raw as unknown[], rendered };
    },
    buildInitial: buildInitialInput,
    buildFollowUp: buildFollowUpInput,
    runClaude: async (input, onLine, control) => {
      control.onStop(() => runner.stop());
      return runner.run({ stdin: input.stdin, sessionMode: input.sessionMode, onLine });
    },
    slack: facade,
    state,
    milestones,
    attachments,
    archiveIdleMs: config.archiveIdleDays * 24 * 60 * 60 * 1000,
    log,
    timeZone: "UTC",
    systemPrompt,
    ownerDisplayName: opts.profileName,
    workdir: config.workdir,
  });

  await orchestrator.start();

  const proxyDetection = detectProxyForUrl(config.serverUrl);
  const proxyAgent = buildProxyAgent(proxyDetection, log);

  connection = new ServerConnection({
    initialUrl: config.serverUrl,
    machineId,
    privateKey: keypair.privateKey,
    serverPublicKey,
    proxyAgent,
    proxyDetection,
    onMessage: (msg) => {
      if (msg.type === "slack_rpc_response") {
        facade._ingest(msg);
        return;
      }
      if (msg.type === "slack_event") {
        const mention = normalizeServerEvent(msg.event);
        if (mention) {
          void orchestrator.enqueue(mention).catch((err) =>
            log.error({ err }, "enqueue failed")
          );
        }
      }
    },
    onFatal: (reason) => {
      log.error({ reason }, "connection fatal; profile exiting");
    },
    log: log.child({ component: "transport" }),
  });
  connection.start();

  return {
    async stop() {
      connection.stop();
      orchestrator.stop();
    },
  };
}
