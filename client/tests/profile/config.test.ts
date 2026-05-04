import { describe, it, expect } from "vitest";
import { parseProfileConfig } from "../../src/profile/config.js";

describe("parseProfileConfig", () => {
  it("parses valid config", () => {
    const c = parseProfileConfig({
      serverUrl: "https://s.example",
      workdir: "/tmp/wd",
      claudeBinary: "claude",
      maxParallelJobs: 3,
      stallSoftNoticeMinutes: 5,
      stallHardStopHours: 24,
      slackEditCoalesceMs: 3000,
      archiveIdleDays: 7,
    });
    expect(c.serverUrl).toBe("https://s.example");
    expect(c.archiveIdleDays).toBe(7);
  });

  it("uses sensible defaults", () => {
    const c = parseProfileConfig({ serverUrl: "https://s", workdir: "/tmp" });
    expect(c.claudeBinary).toBe("claude");
    expect(c.maxParallelJobs).toBe(3);
  });

  it("rejects missing serverUrl", () => {
    expect(() => parseProfileConfig({ workdir: "/tmp" } as any)).toThrow(/serverUrl/);
  });
});
