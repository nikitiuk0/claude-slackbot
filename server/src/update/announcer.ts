import type { Logger } from "pino";
import type { ConnectionRegistry } from "../ws/connections.js";
import { broadcastUpdateAvailable } from "../ws/broadcasts.js";

export function startUpdateAnnouncer(opts: {
  registry: ConnectionRegistry;
  packageName: string;
  log: Logger;
  intervalMs?: number;
}): () => void {
  const interval = opts.intervalMs ?? 5 * 60_000;
  let lastAnnounced: string | null = null;

  const tick = async () => {
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(opts.packageName)}/latest`);
      if (!res.ok) return;
      const body = await res.json() as { version?: string };
      if (!body.version || body.version === lastAnnounced) return;
      const count = broadcastUpdateAvailable(opts.registry, body.version);
      lastAnnounced = body.version;
      opts.log.info({ version: body.version, clients: count }, "update_available broadcast");
    } catch (err) {
      opts.log.warn({ err }, "update announcer tick failed");
    }
  };

  void tick();
  const timer = setInterval(tick, interval);
  return () => clearInterval(timer);
}
