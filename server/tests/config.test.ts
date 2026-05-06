import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

function validEnv(): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: "xoxb-x",
    SLACK_APP_TOKEN: "xapp-x",
    DATABASE_PATH: "./data/test.sqlite",
    SERVER_PRIVATE_KEY_PATH: "./key",
    SERVER_PUBLIC_KEY_PATH: "./pub",
    PUBLIC_SERVER_URL: "https://x",
    PUBLIC_WS_URL: "wss://x/ws",
    ALLOWED_NPM_PUBLISHER: "nikitiuk0",
  };
}

describe("loadConfig", () => {
  it("parses a valid env", () => {
    const c = loadConfig(validEnv());
    expect(c.slackBotToken).toBe("xoxb-x");
    expect(c.databasePath).toBe("./data/test.sqlite");
    expect(c.port).toBe(8443); // default
    expect(c.logLevel).toBe("info"); // default
  });

  it("throws on missing required var", () => {
    const e = validEnv();
    delete e.SLACK_BOT_TOKEN;
    expect(() => loadConfig(e)).toThrow(/SLACK_BOT_TOKEN/);
  });

  it("uses default DATABASE_PATH when omitted", () => {
    const e = validEnv();
    delete e.DATABASE_PATH;
    expect(loadConfig(e).databasePath).toBe("./data/claude-slackbot.sqlite");
  });

  it("accepts PORT override", () => {
    const e = validEnv();
    e.PORT = "9000";
    expect(loadConfig(e).port).toBe(9000);
  });
});
