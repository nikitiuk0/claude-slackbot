import { promises as fs } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../profile/home.js";
import { discoverProfiles } from "../profile/manager.js";

export async function runProfiles(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const home = resolveHome(process.env);
  if (sub === "list") {
    const all = discoverProfiles(home);
    const def = await readDefault(home);
    for (const p of all) console.log(`${p.name === def ? "*" : " "} ${p.name}  (${p.dir})`);
    return;
  }
  if (sub === "default") {
    const name = rest[0];
    if (!name) { console.error("usage: profiles default <name>"); process.exit(2); }
    await fs.writeFile(join(home, "profiles.json"), JSON.stringify({ default: name }, null, 2));
    console.log(`default profile set to '${name}'`);
    return;
  }
  console.error("usage: profiles list | default <name>");
  process.exit(2);
}

async function readDefault(home: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(home, "profiles.json"), "utf8");
    return JSON.parse(raw).default ?? null;
  } catch { return null; }
}
