import { promises as fs } from "node:fs";
import { join } from "node:path";
import { generateAndSaveKeypair } from "../identity/keypair.js";
import { resolveHome, profileDir } from "../profile/home.js";

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
  const res = await fetch(pairUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    await fs.rm(keypairPath, { force: true });
    console.error(`pair failed: status=${res.status} body=${text}`);
    process.exit(1);
  }
  const { machine_id, server_public_key, ws_url, revoked_previous } = await res.json();

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
