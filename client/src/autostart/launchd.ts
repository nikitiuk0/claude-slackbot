import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

export async function installLaunchdPlist(opts: { home: string; nodePath: string; entrypoint: string }): Promise<string> {
  const plistPath = join(opts.home, "Library", "LaunchAgents", "com.nikitiuk0.claude-slackbot.plist");
  await fs.mkdir(join(opts.home, "Library", "LaunchAgents"), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nikitiuk0.claude-slackbot</string>
  <key>ProgramArguments</key><array>
    <string>${opts.nodePath}</string>
    <string>${opts.entrypoint}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${opts.home}/.claude-slackbot/logs/daemon.stdout.log</string>
  <key>StandardErrorPath</key><string>${opts.home}/.claude-slackbot/logs/daemon.stderr.log</string>
</dict>
</plist>`;
  await fs.writeFile(plistPath, plist);
  try { execSync(`launchctl unload ${plistPath}`); } catch {}
  execSync(`launchctl load ${plistPath}`);
  return plistPath;
}
