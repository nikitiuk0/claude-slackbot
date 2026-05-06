import type { FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";

/**
 * Returns the client address as a single human-readable string, automatically
 * detecting reverse-proxy presence:
 *
 *   - Behind a proxy (X-Forwarded-For present): "203.0.113.5 (via 10.0.0.7)"
 *   - Direct connection:                         "203.0.113.5"
 *
 * The "real" client IP is the first entry of X-Forwarded-For; the proxy IP is
 * the TCP socket peer. No config flag — proxy is detected by header presence.
 */
export function clientAddr(req: FastifyRequest | IncomingMessage): string {
  const headers = "headers" in req ? req.headers : {};
  const xff = headers["x-forwarded-for"];
  const peer =
    ("socket" in req && req.socket?.remoteAddress) ||
    ("connection" in req && (req as any).connection?.remoteAddress) ||
    "unknown";
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  if (typeof xffStr === "string" && xffStr.length > 0) {
    const realIp = xffStr.split(",")[0]!.trim();
    if (realIp && realIp !== peer) return `${realIp} (via ${peer})`;
  }
  return String(peer);
}
