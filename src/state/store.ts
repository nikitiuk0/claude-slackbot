import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const ThreadStateSchema = z.object({
  sessionId: z.string(),
  channelId: z.string(),
  triggerMsgTs: z.string(),
  statusMsgTs: z.string(),
  status: z.enum([
    "running",
    "done",
    "errored",
    "interrupted",
    "stopped",
    "reset",
  ]),
  startedAt: z.string(),
  updatedAt: z.string(),
  lastEventAt: z.string(),
});

const FileSchema = z.object({
  threads: z.record(ThreadStateSchema).default({}),
});

export type ThreadState = z.infer<typeof ThreadStateSchema>;
type FileShape = z.infer<typeof FileSchema>;

export class StateStore {
  private data: FileShape = { threads: {} };

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      this.data = FileSchema.parse(parsed);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "ENOENT") {
        this.data = { threads: {} };
        return;
      }
      // Corrupt or schema-mismatch: treat as empty, leave file alone.
      this.data = { threads: {} };
    }
  }

  getThread(threadTs: string): ThreadState | undefined {
    return this.data.threads[threadTs];
  }

  allRunning(): Array<{ threadTs: string; state: ThreadState }> {
    return Object.entries(this.data.threads)
      .filter(([, s]) => s.status === "running")
      .map(([threadTs, state]) => ({ threadTs, state }));
  }

  async upsertThread(threadTs: string, state: ThreadState): Promise<void> {
    this.data.threads[threadTs] = state;
    await this.flush();
  }

  async deleteThread(threadTs: string): Promise<void> {
    delete this.data.threads[threadTs];
    await this.flush();
  }

  private async flush(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.path);
  }
}
