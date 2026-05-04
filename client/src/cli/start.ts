import { discoverProfiles, startProfile } from "../profile/manager.js";
import { resolveHome } from "../profile/home.js";

export async function runStart(argv: string[]): Promise<void> {
  const args = Object.fromEntries(
    argv.reduce<Array<[string, string]>>((acc, v, i, arr) =>
      v.startsWith("--") ? [...acc, [v.slice(2), arr[i + 1] ?? ""]] : acc, []
    )
  );
  const home = resolveHome(process.env);
  let profiles = discoverProfiles(home);
  if (args.profile) profiles = profiles.filter((p) => p.name === args.profile);
  if (profiles.length === 0) {
    console.error("no profiles to start — run 'pair' first");
    process.exit(2);
  }

  const stops: Array<() => Promise<void>> = [];
  for (const p of profiles) {
    try {
      const h = await startProfile({ profileDir: p.dir, profileName: p.name });
      stops.push(h.stop);
      console.log(`started profile '${p.name}'`);
    } catch (err) {
      console.error(`profile '${p.name}' failed to start:`, err);
    }
  }

  const shutdown = async (sig: string) => {
    console.log(`\n${sig} — shutting down`);
    await Promise.all(stops.map((s) => s().catch(() => {})));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
