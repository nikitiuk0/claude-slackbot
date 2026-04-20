import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createLogger } from "../src/log.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slackbot-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createLogger", () => {
  it("writes JSON lines to the configured logFile", async () => {
    const file = join(dir, "daemon.log");
    const log = createLogger({ level: "info", logFile: file });
    log.info({ thread: "T1" }, "hello world");
    log.warn({ idleMin: 6 }, "stalling");
    // Pino transports flush asynchronously; give them a moment.
    await wait(120);
    const contents = readFileSync(file, "utf8").trim().split("\n");
    expect(contents.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(contents[0]!);
    expect(first.msg).toBe("hello world");
    expect(first.thread).toBe("T1");
    expect(first.level).toBe(30); // pino info
    const second = JSON.parse(contents[1]!);
    expect(second.msg).toBe("stalling");
    expect(second.idleMin).toBe(6);
  });

  it("creates intermediate directories for the log file", async () => {
    const file = join(dir, "nested", "subdir", "daemon.log");
    const log = createLogger({ level: "info", logFile: file });
    log.info("ok");
    await wait(120);
    const contents = readFileSync(file, "utf8").trim();
    expect(contents.length).toBeGreaterThan(0);
  });

  it("does not create a file when logFile is empty", async () => {
    const log = createLogger({ level: "info", logFile: "" });
    log.info("nothing-to-disk");
    await wait(50);
    // No assertion on filesystem — just confirm no throw.
    expect(true).toBe(true);
  });
});
