import { join } from "node:path";

export function resolveHome(env: Record<string, string | undefined>): string {
  if (env.CLAUDE_SLACKBOT_HOME && env.CLAUDE_SLACKBOT_HOME.length > 0) return env.CLAUDE_SLACKBOT_HOME;
  if (!env.HOME) throw new Error("HOME not set; cannot resolve ~/.claude-slackbot");
  return join(env.HOME, ".claude-slackbot");
}

export function profileDir(home: string, profileName: string): string {
  return join(home, "profiles", profileName);
}
