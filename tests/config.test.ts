import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses a valid env + json bundle", () => {
    const cfg = loadConfig({
      env: {
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
        ALLOWED_USER_IDS: "U1,U2",
      },
      json: {
        workdir: "/tmp/wd",
        claudeBinary: "claude",
        maxParallelJobs: 3,
        stallSoftNoticeMinutes: 5,
        stallHardStopHours: 24,
        slackEditCoalesceMs: 3000,
        ownerDisplayName: "alice",
      },
    });

    expect(cfg.slackBotToken).toBe("xoxb-test");
    expect(cfg.slackAppToken).toBe("xapp-test");
    expect(cfg.allowedUserIds).toEqual(["U1", "U2"]);
    expect(cfg.workdir).toBe("/tmp/wd");
    expect(cfg.maxParallelJobs).toBe(3);
    expect(cfg.logLevel).toBe("info");
  });

  it("throws on missing required env", () => {
    expect(() =>
      loadConfig({
        env: { SLACK_BOT_TOKEN: "xoxb-x" },
        json: {
          workdir: "/tmp",
          claudeBinary: "claude",
          maxParallelJobs: 1,
          stallSoftNoticeMinutes: 5,
          stallHardStopHours: 24,
          slackEditCoalesceMs: 3000,
          ownerDisplayName: "x",
        },
      })
    ).toThrow(/SLACK_APP_TOKEN/);
  });

  it("rejects empty ALLOWED_USER_IDS", () => {
    expect(() =>
      loadConfig({
        env: {
          SLACK_BOT_TOKEN: "xoxb-x",
          SLACK_APP_TOKEN: "xapp-x",
          ALLOWED_USER_IDS: "",
        },
        json: {
          workdir: "/tmp",
          claudeBinary: "claude",
          maxParallelJobs: 1,
          stallSoftNoticeMinutes: 5,
          stallHardStopHours: 24,
          slackEditCoalesceMs: 3000,
          ownerDisplayName: "x",
        },
      })
    ).toThrow(/ALLOWED_USER_IDS/);
  });
});
