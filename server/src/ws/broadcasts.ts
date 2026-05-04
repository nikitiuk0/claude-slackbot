import type { ConnectionRegistry } from "./connections.js";

export function broadcastMigrate(registry: ConnectionRegistry, newUrl: string): number {
  const msg = JSON.stringify({ type: "migrate", new_url: newUrl });
  let sent = 0;
  for (const c of registry.all()) { c.socket.send(msg); sent++; }
  return sent;
}

export function broadcastUpdateAvailable(registry: ConnectionRegistry, version: string): number {
  const msg = JSON.stringify({ type: "update_available", version });
  let sent = 0;
  for (const c of registry.all()) { c.socket.send(msg); sent++; }
  return sent;
}
