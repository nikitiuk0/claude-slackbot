import { describe, it, expect } from "vitest";
import { toSlackMrkdwn } from "../../src/slack/mrkdwn.js";

describe("toSlackMrkdwn", () => {
  it("converts <code> to backticks", () => {
    expect(toSlackMrkdwn("use <code>npm run start</code>")).toBe("use `npm run start`");
  });

  it("converts <pre><code> to triple-backtick block", () => {
    const out = toSlackMrkdwn("<pre><code>line1\nline2</code></pre>");
    expect(out).toContain("```");
    expect(out).toContain("line1");
    expect(out).toContain("line2");
  });

  it("converts **bold** to *bold*", () => {
    expect(toSlackMrkdwn("this is **important**")).toBe("this is *important*");
  });

  it("converts __bold__ to *bold*", () => {
    expect(toSlackMrkdwn("this is __important__")).toBe("this is *important*");
  });

  it("converts [text](url) to <url|text>", () => {
    expect(toSlackMrkdwn("see [the docs](https://example.com/x)")).toBe(
      "see <https://example.com/x|the docs>"
    );
  });

  it("leaves already-slack-style text alone", () => {
    const input = "already `inline` and *bold* and _italic_ and <https://x|y>";
    expect(toSlackMrkdwn(input)).toBe(input);
  });

  it("leaves plain text alone", () => {
    expect(toSlackMrkdwn("no formatting here")).toBe("no formatting here");
  });
});
