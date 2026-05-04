import { describe, it, expect } from "vitest";
import { resolveHome, profileDir } from "../../src/profile/home.js";

describe("profile/home", () => {
  it("respects CLAUDE_SLACKBOT_HOME env override", () => {
    expect(resolveHome({ CLAUDE_SLACKBOT_HOME: "/tmp/xyz", HOME: "/home/x" })).toBe("/tmp/xyz");
  });

  it("defaults to $HOME/.claude-slackbot", () => {
    expect(resolveHome({ HOME: "/home/alice" })).toBe("/home/alice/.claude-slackbot");
  });

  it("throws if neither is set", () => {
    expect(() => resolveHome({})).toThrow(/HOME/);
  });

  it("profileDir concatenates", () => {
    expect(profileDir("/home/alice/.claude-slackbot", "tumblr"))
      .toBe("/home/alice/.claude-slackbot/profiles/tumblr");
  });
});
