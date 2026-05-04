import WebSocket from "ws";
import { jwtVerify, type KeyLike } from "jose";
import type { Logger } from "../core/log.js";
import { mintClientJwt } from "../identity/jwt.js";

export type ServerConnectionDeps = {
  initialUrl: string;
  machineId: string;
  privateKey: KeyLike;
  serverPublicKey: KeyLike;
  /** Path to serverUrl in config file — written on migrate. */
  persistServerUrl: (newUrl: string) => Promise<void>;
  onMessage: (msg: any) => void;
  onFatal: (reason: "revoked" | "unknown" | "auth_failed" | "abort") => void;
  log: Logger;
};

export class ServerConnection {
  private ws: WebSocket | null = null;
  private currentUrl: string;
  private shouldReconnect = true;
  private backoffMs = 1000;

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
      const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${jwt}` } });
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
          return;
        }
        if (msg.type === "migrate" && typeof msg.new_url === "string") {
          this.currentUrl = msg.new_url;
          await this.d.persistServerUrl(msg.new_url).catch((err) =>
            this.d.log.warn({ err }, "failed to persist migrated URL")
          );
          ws.close();
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

      ws.on("error", (err) => this.d.log.warn({ err }, "ws error"));
    } catch (err) {
      this.d.log.warn({ err }, "connect attempt threw");
      if (this.shouldReconnect) setTimeout(() => void this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    }
  }
}

function toWss(httpsOrWss: string): string {
  if (httpsOrWss.startsWith("wss://") || httpsOrWss.startsWith("ws://")) return httpsOrWss;
  if (httpsOrWss.startsWith("https://")) return "wss://" + httpsOrWss.slice("https://".length);
  if (httpsOrWss.startsWith("http://")) return "ws://" + httpsOrWss.slice("http://".length);
  return httpsOrWss;
}
