import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const RunStart = z.object({
  ts: z.string(),
  kind: z.literal("start"),
  sessionId: z.string(),
  sessionMode: z.enum(["new", "resume"]),
  instruction: z.string(),
});

const Milestone = z.object({
  ts: z.string(),
  kind: z.literal("milestone"),
  text: z.string(),
});

const RunEnd = z.object({
  ts: z.string(),
  kind: z.literal("end"),
  status: z.string(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  terminatedBy: z.string().optional(),
});

const Entry = z.union([RunStart, Milestone, RunEnd]);

export type RunStartEntry = z.infer<typeof RunStart>;
export type MilestoneEntry = z.infer<typeof Milestone>;
export type RunEndEntry = z.infer<typeof RunEnd>;
export type HistoryEntry = z.infer<typeof Entry>;

export class MilestonesStore {
  constructor(private readonly baseDir: string) {}

  private fileFor(threadTs: string): string {
    // Slashes shouldn't appear in thread_ts, but normalize defensively.
    const safe = threadTs.replace(/\//g, "_");
    return join(this.baseDir, `${safe}.ndjson`);
  }

  async append(threadTs: string, entry: HistoryEntry): Promise<void> {
    const path = this.fileFor(threadTs);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  }

  async readAll(threadTs: string): Promise<HistoryEntry[]> {
    const path = this.fileFor(threadTs);
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "ENOENT") return [];
      throw err;
    }
    const out: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const validated = Entry.safeParse(parsed);
        if (validated.success) out.push(validated.data);
      } catch {
        // Skip malformed lines silently.
      }
    }
    return out;
  }

  /**
   * Return the entries belonging to the most recent run on this thread.
   * Slice from the last `start` entry to the end of the file. If no `start`
   * exists, return the whole file (best-effort).
   */
  async readLastRun(threadTs: string): Promise<HistoryEntry[]> {
    const all = await this.readAll(threadTs);
    let lastStart = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]!.kind === "start") {
        lastStart = i;
        break;
      }
    }
    return lastStart >= 0 ? all.slice(lastStart) : all;
  }

  /** Remove the ndjson file for a thread. Best-effort. */
  async purgeThread(threadTs: string): Promise<void> {
    const path = this.fileFor(threadTs);
    try {
      await fs.unlink(path);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== "ENOENT") throw err;
    }
  }
}
