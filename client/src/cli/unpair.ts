import { promises as fs } from "node:fs";
import { resolveHome, profileDir } from "../profile/home.js";

export async function runUnpair(argv: string[]): Promise<void> {
  const args = Object.fromEntries(
    argv.reduce<Array<[string, string]>>((acc, v, i, arr) =>
      v.startsWith("--") ? [...acc, [v.slice(2), arr[i + 1] ?? ""]] : acc, []
    )
  );
  if (!args.profile) { console.error("usage: unpair --profile <name>"); process.exit(2); }
  const home = resolveHome(process.env);
  const dir = profileDir(home, args.profile);
  await fs.rm(dir, { recursive: true, force: true });
  console.log(`unpaired profile '${args.profile}' (local state removed)`);
  console.log(`   Server-side revocation will be triggered on your next 'pair' for this Slack user,`);
  console.log(`   since pairing auto-revokes prior machines.`);
}
