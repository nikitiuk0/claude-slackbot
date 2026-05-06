import { execFileSync } from "node:child_process";
import type { Agent } from "node:http";
import { ProxyAgent } from "proxy-agent";
import type { Logger } from "../core/log.js";

/**
 * Outcome of a proxy detection attempt for a target URL.
 *
 * `proxyUrl` is the URL we'd hand to ProxyAgent (env-style: `http://...`,
 * `socks5://...`, or `pac+https://...` to evaluate a PAC file per request).
 * `null` means "go direct".
 *
 * `attempts` records each detection step we tried, so the daemon can produce
 * an actionable error message if the connection still fails.
 */
export type ProxyDetection = {
  proxyUrl: string | null;
  source: "env" | "macos-pac" | "macos-https" | "macos-socks" | "none";
  attempts: ProxyDetectionAttempt[];
};

export type ProxyDetectionAttempt = {
  source: "env" | "macos-system";
  found: boolean;
  detail?: string;
};

const ENV_VAR_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"] as const;

/**
 * Detect a proxy for the given target URL. Returns the proxy URL we'd use
 * (or null for direct), plus a record of which detection paths we tried.
 *
 * Order of precedence:
 *   1. Standard env vars (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY) — universal, always wins.
 *   2. macOS system proxy via `scutil --proxy` — picks PAC URL, then HTTPS, then SOCKS.
 *   3. None.
 *
 * NO_PROXY (or no_proxy) is honored: if the target host matches an entry in
 * the comma-separated NO_PROXY list, we return null even if a proxy exists.
 */
export function detectProxyForUrl(targetUrl: string): ProxyDetection {
  const attempts: ProxyDetectionAttempt[] = [];

  // NO_PROXY short-circuit.
  if (matchesNoProxy(targetUrl, process.env.NO_PROXY ?? process.env.no_proxy)) {
    return { proxyUrl: null, source: "none", attempts };
  }

  // 1. Env vars.
  const envValue = readEnvProxy();
  attempts.push({
    source: "env",
    found: envValue !== null,
    detail: envValue ? `value from ${envValue.varName}` : "no HTTPS_PROXY/HTTP_PROXY/ALL_PROXY set",
  });
  if (envValue) {
    return { proxyUrl: envValue.url, source: "env", attempts };
  }

  // 2. macOS system proxy.
  if (process.platform === "darwin") {
    const sys = readMacosSystemProxy();
    attempts.push({
      source: "macos-system",
      found: sys !== null,
      detail: sys ? `${sys.kind} from System Network preferences` : "no PAC/HTTPS/SOCKS proxy configured",
    });
    if (sys) {
      const source =
        sys.kind === "pac" ? "macos-pac" : sys.kind === "https" ? "macos-https" : "macos-socks";
      return { proxyUrl: sys.url, source, attempts };
    }
  }

  return { proxyUrl: null, source: "none", attempts };
}

/**
 * Build a ProxyAgent for the detected proxy, or return null for direct connection.
 * Logs the chosen path at INFO so operators can see what happened on startup.
 */
export function buildProxyAgent(detection: ProxyDetection, log: Logger): Agent | null {
  if (!detection.proxyUrl) {
    log.info("no proxy detected; connecting directly");
    return null;
  }
  log.info(
    { proxy: redactCreds(detection.proxyUrl), source: detection.source },
    "using proxy"
  );
  return new ProxyAgent({ getProxyForUrl: () => detection.proxyUrl ?? "" });
}

/**
 * Render a human-readable explanation of what detection tried, suitable for
 * surfacing in connection-failure messages. Reads top-down; first hit wins.
 */
export function describeDetection(detection: ProxyDetection): string {
  const lines = detection.attempts.map((a) => {
    const tag = a.source === "env" ? "env vars (HTTPS_PROXY/HTTP_PROXY/ALL_PROXY)" : "macOS system proxy (scutil --proxy)";
    return `  • ${tag}: ${a.found ? "found — " : "not found — "}${a.detail ?? ""}`;
  });
  if (detection.proxyUrl) {
    lines.push(`  → using ${redactCreds(detection.proxyUrl)} (source: ${detection.source})`);
  } else {
    lines.push("  → no proxy detected; connection was attempted directly");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function readEnvProxy(): { url: string; varName: string } | null {
  for (const name of ENV_VAR_NAMES) {
    const v = process.env[name];
    if (v && v.length > 0) return { url: v, varName: name };
  }
  return null;
}

type MacosProxy = { url: string; kind: "pac" | "https" | "socks" };

function readMacosSystemProxy(): MacosProxy | null {
  let out: string;
  try {
    out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 2000 });
  } catch {
    return null;
  }
  return parseScutilProxy(out);
}

/** Exposed for tests. */
export function parseScutilProxy(out: string): MacosProxy | null {
  const pacEnabled = /^\s*ProxyAutoConfigEnable\s*:\s*1\b/m.test(out);
  const pacUrl = out.match(/^\s*ProxyAutoConfigURLString\s*:\s*(\S+)/m)?.[1];
  if (pacEnabled && pacUrl) {
    return { url: `pac+${pacUrl}`, kind: "pac" };
  }
  const httpsEnable = /^\s*HTTPSEnable\s*:\s*1\b/m.test(out);
  const httpsHost = out.match(/^\s*HTTPSProxy\s*:\s*(\S+)/m)?.[1];
  const httpsPort = out.match(/^\s*HTTPSPort\s*:\s*(\d+)/m)?.[1];
  if (httpsEnable && httpsHost && httpsPort) {
    return { url: `http://${httpsHost}:${httpsPort}`, kind: "https" };
  }
  const socksEnable = /^\s*SOCKSEnable\s*:\s*1\b/m.test(out);
  const socksHost = out.match(/^\s*SOCKSProxy\s*:\s*(\S+)/m)?.[1];
  const socksPort = out.match(/^\s*SOCKSPort\s*:\s*(\d+)/m)?.[1];
  if (socksEnable && socksHost && socksPort) {
    return { url: `socks5://${socksHost}:${socksPort}`, kind: "socks" };
  }
  return null;
}

/** Strip user:password@ from a proxy URL for safe logging. */
function redactCreds(url: string): string {
  try {
    const u = new URL(url.startsWith("pac+") ? url.slice(4) : url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    const inner = u.toString();
    return url.startsWith("pac+") ? `pac+${inner}` : inner;
  } catch {
    return url;
  }
}

/** Honor NO_PROXY: comma-separated list of suffixes/hosts. `*` means everything. */
function matchesNoProxy(targetUrl: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  if (noProxy.trim() === "*") return true;
  let host: string;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const bare = entry.startsWith(".") ? entry.slice(1) : entry;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}
