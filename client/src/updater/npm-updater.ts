import { spawnSync } from "node:child_process";
import type { Logger } from "../core/log.js";

export type UpdaterOptions = {
  packageName: string;
  allowedPublisher: string;
  log: Logger;
  isIdle: () => boolean;            // returns true if no jobs running
  onReady: (newVersion: string) => void; // called when update is ready to be applied
};

export function handleUpdateAvailable(version: string, opts: UpdaterOptions): void {
  opts.log.info({ version }, "update_available received");
  const check = () => {
    if (!opts.isIdle()) {
      setTimeout(check, 5_000);
      return;
    }
    // Verify publisher
    const view = spawnSync("npm", ["view", `${opts.packageName}@${version}`, "_npmUser.name"], { encoding: "utf8" });
    const publisher = view.stdout.trim();
    if (publisher !== opts.allowedPublisher) {
      opts.log.error({ publisher, expected: opts.allowedPublisher }, "update rejected: publisher mismatch");
      return;
    }
    // Install globally into user's npm prefix (or into npx cache).
    const install = spawnSync("npm", ["install", "-g", `${opts.packageName}@${version}`], { stdio: "inherit" });
    if (install.status !== 0) {
      opts.log.error({ status: install.status }, "update install failed");
      return;
    }
    opts.onReady(version);
  };
  check();
}
