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
