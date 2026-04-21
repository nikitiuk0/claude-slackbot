import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStream, type ParseEvent } from "../../src/claude/stream-parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(here, "..", "fixtures", "stream-json", "simple-edit.ndjson"),
  "utf8"
);

async function* asyncIter(arr: string[]) {
  for (const s of arr) yield s;
}

async function collect(input: string) {
  const events: ParseEvent[] = [];
  for await (const ev of parseStream(asyncIter(input.split("\n").filter(Boolean)))) {
    events.push(ev);
  }
  return events;
}

describe("parseStream", () => {
  it("emits milestones for tool_use items", async () => {
    const events = await collect(fixture);
    const milestones = events.filter((e) => e.kind === "milestone");
    const labels = milestones.map((e) => (e as any).text);
    expect(labels).toContain("Reading src/foo.ts");
    expect(labels).toContain("Editing src/foo.ts");
    expect(labels).toContain("Running `npm test`");
  });

  it("captures the session id from the system init event", async () => {
    const events = await collect(fixture);
    const init = events.find((e) => e.kind === "session-init");
    expect(init).toEqual({ kind: "session-init", sessionId: "sess-abc" });
  });

  it("extracts the slack-summary block from the final assistant text", async () => {
    const events = await collect(fixture);
    const summary = events.find((e) => e.kind === "summary");
    expect(summary).toBeDefined();
    expect((summary as any).text).toContain("fixed the typo");
    expect((summary as any).text).toContain("https://example.com/pr/1");
  });

  it("ignores malformed lines without crashing", async () => {
    const broken =
      fixture +
      "\n{not json\n" +
      `\n{"type":"unknown","weird":true}\n`;
    const events = await collect(broken);
    expect(events.find((e) => e.kind === "summary")).toBeDefined();
  });

  it("compacts multi-line Bash commands to a single-line milestone", async () => {
    const sql = `SELECT\n  col1,\n  col2\nFROM big_table\nWHERE x = 1`;
    const ndjson = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: `psql -c "${sql}"` } }],
      },
    });
    const events = await collect(ndjson);
    const milestone = events.find((e) => e.kind === "milestone");
    expect(milestone).toBeDefined();
    const text = (milestone as any).text as string;
    // Must fit on one line — Slack inline code doesn't span lines.
    expect(text.includes("\n")).toBe(false);
    // Must end with the ellipsis indicator since we dropped lines.
    expect(text).toMatch(/…`$/);
    // Must be wrapped in single backticks.
    expect(text).toMatch(/^Running `/);
  });

  it("does not append ellipsis for single-line commands within the length cap", async () => {
    const ndjson = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
      },
    });
    const events = await collect(ndjson);
    const milestone = events.find((e) => e.kind === "milestone");
    expect((milestone as any).text).toBe("Running `npm test`");
  });

  it("emits a text event for every non-empty assistant text block", async () => {
    const events = await collect(fixture);
    const texts = events.filter((e) => e.kind === "text");
    const bodies = texts.map((e) => (e as any).text as string);
    // Both the plain "Looking at the file..." line and the block that also
    // contains <slack-summary> should surface as text events.
    expect(bodies.some((b) => b.includes("Looking at the file"))).toBe(true);
    expect(bodies.some((b) => b.includes("<slack-summary>"))).toBe(true);
  });

  it("emits a text event AND a summary event for a block that wraps a summary", async () => {
    const ndjson = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text:
              "Some reasoning.\n\n<slack-summary>\nSummary: ok\n</slack-summary>",
          },
        ],
      },
    });
    const events = await collect(ndjson);
    const text = events.find((e) => e.kind === "text");
    const summary = events.find((e) => e.kind === "summary");
    expect(text).toBeDefined();
    expect(summary).toBeDefined();
    expect((summary as any).text).toBe("Summary: ok");
  });

  it("does not emit a text event for empty text blocks", async () => {
    const ndjson = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    });
    const events = await collect(ndjson);
    expect(events.find((e) => e.kind === "text")).toBeUndefined();
  });

  it("emits structured error info for non-success result lines", async () => {
    const events = await collect(
      [
        '{"type":"system","subtype":"init","session_id":"s1"}',
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"tool xyz not found"}',
      ].join("\n")
    );
    const result = events.find((e) => e.kind === "result");
    expect(result).toBeDefined();
    expect((result as any).success).toBe(false);
    expect((result as any).subtype).toBe("error_during_execution");
    expect((result as any).error).toBe("tool xyz not found");
  });
});
