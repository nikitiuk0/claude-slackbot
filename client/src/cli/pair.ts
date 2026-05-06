import { promises as fs } from "node:fs";
import { join } from "node:path";
import https from "node:https";
import http from "node:http";
import type { Agent } from "node:http";
import { generateAndSaveKeypair } from "../identity/keypair.js";
import { resolveHome, profileDir } from "../profile/home.js";
import { detectProxyForUrl, buildProxyAgent, describeDetection } from "../transport/proxy.js";
import { createLogger } from "../core/log.js";

export async function runPair(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.profile || !args.server || !args.code) {
    console.error("usage: pair --profile <name> --server <url> --code <PAIR-...>");
    process.exit(2);
  }
  const home = resolveHome(process.env);
  const dir = profileDir(home, args.profile);

  // If a keypair already exists in this profile, refuse — user must explicitly unpair first.
  const keypairPath = join(dir, "identity", "keypair.json");
  if (await exists(keypairPath)) {
    console.error(`profile '${args.profile}' already has a keypair at ${keypairPath}.`);
    console.error(`run 'unpair --profile ${args.profile}' first if you want to re-pair.`);
    process.exit(2);
  }

  // 1. Generate keypair.
  const kp = await generateAndSaveKeypair(keypairPath);
  // 2. Compute hostname as label.
  const os = await import("node:os");
  const label = os.hostname();
  // 3. POST /pair.
  const body = {
    code: args.code,
    machine_public_key: Buffer.from(JSON.stringify(kp.publicKeyJwk), "utf8").toString("base64"),
    label,
  };
  const pairUrl = new URL("/pair", args.server).toString();
  const detection = detectProxyForUrl(pairUrl);
  const log = createLogger({ level: process.env.LOG_LEVEL ?? "info", logFile: "" });
  const agent = buildProxyAgent(detection, log);
  let res: { status: number; text: string };
  try {
    res = await httpPost(pairUrl, JSON.stringify(body), agent);
  } catch (err: any) {
    await fs.rm(keypairPath, { force: true });
    console.error(`pair failed: could not reach ${pairUrl}: ${err.message ?? err}`);
    console.error("Proxy detection:");
    console.error(describeDetection(detection));
    if (!detection.proxyUrl) {
      console.error("If you're behind a proxy that wasn't auto-detected, set ALL_PROXY (e.g. ALL_PROXY=socks5://127.0.0.1:8080) and retry.");
    }
    process.exit(1);
  }
  if (res.status < 200 || res.status >= 300) {
    await fs.rm(keypairPath, { force: true });
    console.error(`pair failed: status=${res.status} body=${res.text}`);
    process.exit(1);
  }
  const { machine_id, server_public_key, ws_url, revoked_previous } = JSON.parse(res.text);

  // 4. Persist machine_id, pinned server key, config.
  await fs.writeFile(join(dir, "identity", "machine_id"), machine_id);
  await fs.writeFile(join(dir, "pinned-server-key.pub"), JSON.stringify(server_public_key));
  const defaultConfig = {
    serverUrl: ws_url,
    workdir: process.env.PWD ?? process.cwd(),
    claudeBinary: "claude",
    maxParallelJobs: 3,
    stallSoftNoticeMinutes: 5,
    stallHardStopHours: 24,
    slackEditCoalesceMs: 3000,
    archiveIdleDays: 7,
  };
  await fs.writeFile(join(dir, "config.json"), JSON.stringify(defaultConfig, null, 2));
  await fs.mkdir(join(dir, "data"), { recursive: true });
  await fs.mkdir(join(dir, "logs"), { recursive: true });

  // Optional: migrate Phase A state (data/state.json in cwd).
  const phaseALocation = join(process.cwd(), "data");
  if (await exists(phaseALocation) && (await exists(join(phaseALocation, "state.json")))) {
    if (args["migrate-from"] === "auto") {
      await fs.cp(phaseALocation, join(dir, "data"), { recursive: true });
      console.log(`migrated Phase A state from ${phaseALocation}`);
    } else {
      console.log(`tip: detected Phase A state at ${phaseALocation}. Re-run with`);
      console.log(`     --migrate-from auto to copy threads/milestones/attachments into the new profile.`);
    }
  }

  // 5. Set as default if first profile.
  const profilesJson = join(home, "profiles.json");
  if (!(await exists(profilesJson))) {
    await fs.writeFile(profilesJson, JSON.stringify({ default: args.profile }, null, 2));
  }

  console.log(`paired profile '${args.profile}' as machine ${machine_id}`);
  if (revoked_previous > 0) {
    console.log(`   (revoked ${revoked_previous} previously-paired machine(s) for your Slack user)`);
  }
  console.log(`\nTo start the daemon now:   npx -y @nikitiuk0/claude-slackbot start`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k?.startsWith("--")) out[k.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function httpPost(url: string, body: string, agent: Agent | null): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body).toString(),
        },
        ...(agent ? { agent } : {}),
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
