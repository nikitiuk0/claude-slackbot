import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner } from "../../src/claude/runner.js";

const here = dirname(fileURLToPath(import.meta.url));
let dir: string;
let stubPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-runner-"));
  stubPath = join(dir, "fake-claude.mjs");
  copyFileSync(join(here, "..", "fixtures", "fake-claude.mjs"), stubPath);
  chmodSync(stubPath, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ClaudeRunner", () => {
  it("streams NDJSON lines to a sink and reports clean exit", async () => {
    const runner = new ClaudeRunner({
      binary: "node",
      extraArgsBefore: [stubPath],
      cwd: dir,
    });
    const lines: string[] = [];
    const result = await runner.run({
      stdin: "ignored",
      sessionMode: { kind: "new", sessionId: "fake-sess-1" },
      onLine: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("session_id");
  });

  it("kills subprocess on stop()", async () => {
    const runner = new ClaudeRunner({
      binary: "node",
      extraArgsBefore: ["-e", "setTimeout(() => {}, 60_000);"],
      cwd: dir,
    });
    const p = runner.run({
      stdin: "",
      sessionMode: { kind: "new", sessionId: "x" },
      onLine: () => {},
    });
    setTimeout(() => runner.stop(), 50);
    const result = await p;
    expect(result.exitCode).not.toBe(0);
  });
});
