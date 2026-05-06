import type { ConnectionRegistry } from "./connections.js";

export function broadcastUpdateAvailable(registry: ConnectionRegistry, version: string): number {
  const msg = JSON.stringify({ type: "update_available", version });
  let sent = 0;
  for (const c of registry.all()) { c.socket.send(msg); sent++; }
  return sent;
}
