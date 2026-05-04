import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

function validEnv(): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: "xoxb-x",
    SLACK_APP_TOKEN: "xapp-x",
    DATABASE_URL: "postgres://u:p@h:5432/d",
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
    expect(c.databaseUrl).toBe("postgres://u:p@h:5432/d");
    expect(c.port).toBe(8443); // default
    expect(c.logLevel).toBe("info"); // default
  });

  it("throws on missing required var", () => {
    const e = validEnv();
    delete e.SLACK_BOT_TOKEN;
    expect(() => loadConfig(e)).toThrow(/SLACK_BOT_TOKEN/);
  });

  it("throws on invalid DATABASE_URL", () => {
    const e = validEnv();
    e.DATABASE_URL = "not-a-url";
    expect(() => loadConfig(e)).toThrow(/DATABASE_URL/);
  });

  it("accepts PORT override", () => {
    const e = validEnv();
    e.PORT = "9000";
    expect(loadConfig(e).port).toBe(9000);
  });
});
