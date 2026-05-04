import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "../log.js";

export type SessionMode =
  | { kind: "new"; sessionId: string }
  | { kind: "resume"; sessionId: string };

export type RunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Tail of stdout for post-mortem diagnostics. `--output-format stream-json`
   *  puts error results on stdout, so this is often the only evidence on a
   *  non-zero exit with empty stderr. */
  stdoutTail: string;
};

export type RunnerOptions = {
  binary: string;
  /** Args inserted before the standard claude flags (used by tests only). */
  extraArgsBefore?: string[];
  cwd: string;
  /** Optional logger; if omitted, runner is silent. */
  log?: Logger;
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
      // Own process group so stop() can SIGTERM the whole tree
      // (claude + its tool subprocesses like Bash/sleep).
      detached: true,
    });
    this.child = child;
    this.opts.log?.info(
      {
        pid: child.pid,
        binary: this.opts.binary,
        cwd: this.opts.cwd,
        sessionMode: input.sessionMode.kind,
        sessionId: input.sessionMode.sessionId,
      },
      "claude subprocess spawned"
    );

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    // Keep a rolling tail of stdout lines (all events, including ones the
    // parser ignored) so we can diagnose non-zero exits with empty stderr.
    const stdoutTail: string[] = [];
    const STDOUT_TAIL_LIMIT = 50;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      stdoutTail.push(line);
      if (stdoutTail.length > STDOUT_TAIL_LIMIT) stdoutTail.shift();
      input.onLine(line);
    });

    if (input.stdin) {
      child.stdin.write(input.stdin);
    }
    child.stdin.end();

    const result = await new Promise<RunResult>((resolve) => {
      child.once("close", (code, signal) => {
        rl.close();
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const tail = stdoutTail.join("\n");
        this.opts.log?.info(
          {
            pid: child.pid,
            exitCode: code,
            signal,
            stderrBytes: stderr.length,
            stdoutTailBytes: tail.length,
            stdoutTailSample:
              code !== 0 && stderr.length === 0 ? tail.slice(-1000) : undefined,
          },
          "claude subprocess exited"
        );
        resolve({ exitCode: code, signal, stderr, stdoutTail: tail });
      });
    });
    this.child = null;
    return result;
  }

  stop(): void {
    const child = this.child;
    if (!child || child.killed || child.pid === undefined) return;
    const pgid = child.pid;
    this.opts.log?.info({ pid: pgid }, "stopping claude subprocess group (SIGTERM)");
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      // Group may already be gone; fall back to direct kill.
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    setTimeout(() => {
      if (this.child && !this.child.killed) {
        this.opts.log?.warn({ pid: pgid }, "subprocess group still alive after 2s; sending SIGKILL");
        try { process.kill(-pgid, "SIGKILL"); } catch { /* ignore */ }
      }
    }, 2000).unref();
  }
}
