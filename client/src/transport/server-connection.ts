import WebSocket from "ws";
import { jwtVerify, type KeyLike } from "jose";
import type { Agent } from "node:http";
import type { Logger } from "../core/log.js";
import { mintClientJwt } from "../identity/jwt.js";
import type { ProxyDetection } from "./proxy.js";
import { describeDetection } from "./proxy.js";

export type ServerConnectionDeps = {
  initialUrl: string;
  machineId: string;
  privateKey: KeyLike;
  serverPublicKey: KeyLike;
  proxyAgent?: Agent | null;
  proxyDetection?: ProxyDetection;
  onMessage: (msg: any) => void;
  onFatal: (reason: "revoked" | "unknown" | "auth_failed" | "abort") => void;
  log: Logger;
};

export class ServerConnection {
  private ws: WebSocket | null = null;
  private currentUrl: string;
  private shouldReconnect = true;
  private backoffMs = 1000;
  private hasConnectedAtLeastOnce = false;
  private hasLoggedConnectFailureDiagnostic = false;

  constructor(private readonly d: ServerConnectionDeps) {
    this.currentUrl = d.initialUrl;
  }

  start(): void { void this.connect(); }
  stop(): void { this.shouldReconnect = false; this.ws?.close(); }
  send(msg: unknown): void { this.ws?.send(JSON.stringify(msg)); }

  private async connect(): Promise<void> {
    try {
      const jwt = await mintClientJwt({ privateKey: this.d.privateKey, machineId: this.d.machineId });
      const wsUrl = toWss(this.currentUrl);
      const wsOpts: WebSocket.ClientOptions = { headers: { Authorization: `Bearer ${jwt}` } };
      if (this.d.proxyAgent) wsOpts.agent = this.d.proxyAgent;
      const ws = new WebSocket(wsUrl, wsOpts);
      this.ws = ws;

      let seenHello = false;
      ws.on("message", async (data) => {
        let msg: any;
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (!seenHello) {
          if (msg.type !== "server_hello" || typeof msg.jwt !== "string") {
            this.d.log.error({ msg }, "first message wasn't server_hello");
            ws.close();
            return;
          }
          try {
            await jwtVerify(msg.jwt, this.d.serverPublicKey, { algorithms: ["EdDSA"] });
          } catch (err) {
            this.d.log.error({ err }, "server_hello JWT verification failed — pinned key mismatch");
            ws.close();
            return;
          }
          seenHello = true;
          this.backoffMs = 1000;
          this.hasConnectedAtLeastOnce = true;
          this.hasLoggedConnectFailureDiagnostic = false;
          return;
        }
        this.d.onMessage(msg);
      });

      ws.on("close", (code) => {
        this.ws = null;
        if (code === 4403) { this.shouldReconnect = false; this.d.onFatal("revoked"); return; }
        if (code === 4404) { this.shouldReconnect = false; this.d.onFatal("unknown"); return; }
        if (code === 4401) { this.shouldReconnect = false; this.d.onFatal("auth_failed"); return; }
        if (!this.shouldReconnect) { this.d.onFatal("abort"); return; }
        const wait = Math.min(this.backoffMs, 60_000);
        this.d.log.info({ wait_ms: wait, code }, "scheduling reconnect");
        setTimeout(() => void this.connect(), wait);
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      });

      ws.on("error", (err) => {
        this.d.log.warn({ err }, "ws error");
        this.maybeLogConnectFailureDiagnostic(err);
      });
    } catch (err) {
      this.d.log.warn({ err }, "connect attempt threw");
      this.maybeLogConnectFailureDiagnostic(err);
      if (this.shouldReconnect) setTimeout(() => void this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    }
  }

  /**
   * On the first connect failure (before we've ever seen a `server_hello`),
   * print a single diagnostic block that explains which proxy detection paths
   * we tried and what we found. Suppressed once a connection has succeeded so
   * mid-session blips don't repeat the block on every reconnect.
   */
  private maybeLogConnectFailureDiagnostic(err: unknown): void {
    if (this.hasConnectedAtLeastOnce) return;
    if (this.hasLoggedConnectFailureDiagnostic) return;
    this.hasLoggedConnectFailureDiagnostic = true;

    const errMsg = (err as any)?.message ?? String(err);
    const lines: string[] = [];
    lines.push(`Could not reach ${this.currentUrl}: ${errMsg}`);
    lines.push("Proxy detection:");
    if (this.d.proxyDetection) {
      lines.push(describeDetection(this.d.proxyDetection));
    } else {
      lines.push("  (no detection ran — daemon was started without proxy support)");
    }
    if (!this.d.proxyDetection?.proxyUrl) {
      lines.push("If you're behind a proxy that wasn't auto-detected, set ALL_PROXY (e.g. ALL_PROXY=socks5://127.0.0.1:8080) and restart.");
    } else {
      lines.push("A proxy was detected but the connection still failed. Verify the proxy is reachable from this machine.");
    }
    this.d.log.error("\n" + lines.join("\n"));
  }
}

function toWss(httpsOrWss: string): string {
  if (httpsOrWss.startsWith("wss://") || httpsOrWss.startsWith("ws://")) return httpsOrWss;
  if (httpsOrWss.startsWith("https://")) return "wss://" + httpsOrWss.slice("https://".length);
  if (httpsOrWss.startsWith("http://")) return "ws://" + httpsOrWss.slice("http://".length);
  return httpsOrWss;
}
