import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectProxyForUrl, parseScutilProxy, describeDetection } from "../../src/transport/proxy.js";

const ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy"];

describe("parseScutilProxy", () => {
  it("returns PAC URL when ProxyAutoConfigEnable is 1", () => {
    const out = `<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : https://pac.example/proxy.pac
  SOCKSEnable : 0
}`;
    expect(parseScutilProxy(out)).toEqual({ url: "pac+https://pac.example/proxy.pac", kind: "pac" });
  });

  it("returns HTTPS proxy when HTTPSEnable is 1 and PAC is off", () => {
    const out = `  ProxyAutoConfigEnable : 0
  HTTPSEnable : 1
  HTTPSProxy : 10.0.0.5
  HTTPSPort : 8080
  SOCKSEnable : 0`;
    expect(parseScutilProxy(out)).toEqual({ url: "http://10.0.0.5:8080", kind: "https" });
  });

  it("returns SOCKS proxy when SOCKSEnable is 1 and others are off", () => {
    const out = `  ProxyAutoConfigEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 1080`;
    expect(parseScutilProxy(out)).toEqual({ url: "socks5://127.0.0.1:1080", kind: "socks" });
  });

  it("prefers PAC over HTTPS over SOCKS", () => {
    const out = `  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : https://pac.example/p.pac
  HTTPSEnable : 1
  HTTPSProxy : 10.0.0.5
  HTTPSPort : 8080
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 1080`;
    expect(parseScutilProxy(out)?.kind).toBe("pac");
  });

  it("returns null when nothing is enabled", () => {
    const out = `  ProxyAutoConfigEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0`;
    expect(parseScutilProxy(out)).toBeNull();
  });
});

describe("detectProxyForUrl", () => {
  let snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot = {};
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("env HTTPS_PROXY wins over OS settings", () => {
    process.env.HTTPS_PROXY = "http://corp.example:3128";
    const d = detectProxyForUrl("https://api.example.com/path");
    expect(d.proxyUrl).toBe("http://corp.example:3128");
    expect(d.source).toBe("env");
  });

  it("ALL_PROXY is honored when HTTPS_PROXY is unset", () => {
    process.env.ALL_PROXY = "socks5://127.0.0.1:1080";
    const d = detectProxyForUrl("https://api.example.com/x");
    expect(d.proxyUrl).toBe("socks5://127.0.0.1:1080");
    expect(d.source).toBe("env");
  });

  it("NO_PROXY suppresses detection for matching hosts", () => {
    process.env.HTTPS_PROXY = "http://corp.example:3128";
    process.env.NO_PROXY = "internal.example.com,localhost";
    const d = detectProxyForUrl("https://localhost:8443/x");
    expect(d.proxyUrl).toBeNull();
    expect(d.source).toBe("none");
  });

  it("NO_PROXY=* suppresses every proxy", () => {
    process.env.HTTPS_PROXY = "http://corp.example:3128";
    process.env.NO_PROXY = "*";
    expect(detectProxyForUrl("https://anything.example/x").proxyUrl).toBeNull();
  });

  it("records each attempt for diagnostic display", () => {
    process.env.HTTPS_PROXY = "http://corp.example:3128";
    const d = detectProxyForUrl("https://api.example.com/x");
    expect(d.attempts.length).toBeGreaterThanOrEqual(1);
    expect(d.attempts[0]?.source).toBe("env");
    expect(d.attempts[0]?.found).toBe(true);
  });
});

describe("describeDetection", () => {
  it("renders attempted sources and chosen result", () => {
    const out = describeDetection({
      proxyUrl: "socks5://127.0.0.1:8080",
      source: "macos-pac",
      attempts: [
        { source: "env", found: false, detail: "no HTTPS_PROXY/HTTP_PROXY/ALL_PROXY set" },
        { source: "macos-system", found: true, detail: "pac from System Network preferences" },
      ],
    });
    expect(out).toContain("env vars");
    expect(out).toContain("not found");
    expect(out).toContain("macOS system proxy");
    expect(out).toContain("found");
    expect(out).toContain("→ using socks5://127.0.0.1:8080");
  });

  it("redacts credentials from the chosen URL", () => {
    const out = describeDetection({
      proxyUrl: "http://user:secret@corp.example:3128",
      source: "env",
      attempts: [{ source: "env", found: true, detail: "value from HTTPS_PROXY" }],
    });
    expect(out).not.toContain("secret");
    expect(out).toContain("***");
  });

  it("explains when no proxy was found", () => {
    const out = describeDetection({
      proxyUrl: null,
      source: "none",
      attempts: [{ source: "env", found: false, detail: "no HTTPS_PROXY/HTTP_PROXY/ALL_PROXY set" }],
    });
    expect(out).toContain("no proxy detected");
  });
});
