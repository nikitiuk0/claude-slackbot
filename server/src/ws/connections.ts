import type { WebSocket } from "ws";

export type ActiveConnection = {
  machineId: string;
  workspaceId: string;
  userId: string;
  socket: WebSocket;
  connectedAt: number;
  lastPingAt: number;
};

export class ConnectionRegistry {
  private byMachine = new Map<string, ActiveConnection>();
  private byUser = new Map<string, Set<string>>(); // `${workspace}:${user}` → set of machineIds

  add(conn: ActiveConnection): void {
    this.byMachine.set(conn.machineId, conn);
    const key = `${conn.workspaceId}:${conn.userId}`;
    let set = this.byUser.get(key);
    if (!set) { set = new Set(); this.byUser.set(key, set); }
    set.add(conn.machineId);
  }

  remove(machineId: string): void {
    const conn = this.byMachine.get(machineId);
    if (!conn) return;
    this.byMachine.delete(machineId);
    const key = `${conn.workspaceId}:${conn.userId}`;
    const set = this.byUser.get(key);
    if (set) {
      set.delete(machineId);
      if (set.size === 0) this.byUser.delete(key);
    }
  }

  getByMachine(machineId: string): ActiveConnection | undefined {
    return this.byMachine.get(machineId);
  }

  getForUser(workspaceId: string, userId: string): ActiveConnection[] {
    const set = this.byUser.get(`${workspaceId}:${userId}`);
    if (!set) return [];
    return Array.from(set)
      .map((id) => this.byMachine.get(id))
      .filter((c): c is ActiveConnection => c !== undefined);
  }

  all(): ActiveConnection[] {
    return Array.from(this.byMachine.values());
  }
}
