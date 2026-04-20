import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type SessionMode =
  | { kind: "new"; sessionId: string }
  | { kind: "resume"; sessionId: string };

export type RunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

export type RunnerOptions = {
  binary: string;
  /** Args inserted before the standard claude flags (used by tests only). */
  extraArgsBefore?: string[];
  cwd: string;
};

export class ClaudeRunner {
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly opts: RunnerOptions) {}

  async run(input: {
    stdin: string;
    sessionMode: SessionMode;
    onLine: (line: string) => void;
  }): Promise<RunResult> {
    const args: string[] = [
      ...(this.opts.extraArgsBefore ?? []),
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      input.sessionMode.kind === "new" ? "--session-id" : "--resume",
      input.sessionMode.sessionId,
    ];

    const child = spawn(this.opts.binary, args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => input.onLine(line));

    if (input.stdin) {
      child.stdin.write(input.stdin);
    }
    child.stdin.end();

    const result = await new Promise<RunResult>((resolve) => {
      child.once("close", (code, signal) => {
        rl.close();
        resolve({
          exitCode: code,
          signal,
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });
    });
    this.child = null;
    return result;
  }

  stop(): void {
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
  }
}
