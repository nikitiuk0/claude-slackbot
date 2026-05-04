import { mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import pino from "pino";

export type Logger = pino.Logger;

export type LoggerOptions = {
  level: string;
  /** Absolute or relative path. Empty string disables file logging. */
  logFile?: string;
};

export function createLogger(opts: LoggerOptions): Logger {
  const isTty = process.stdout.isTTY;
  const targets: pino.TransportTargetOptions[] = [];

  if (isTty) {
    targets.push({
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss", destination: 1 },
      level: opts.level,
    });
  } else {
    targets.push({
      target: "pino/file",
      options: { destination: 1 },
      level: opts.level,
    });
  }

  if (opts.logFile && opts.logFile.length > 0) {
    const dest = resolvePath(opts.logFile);
    mkdirSync(dirname(dest), { recursive: true });
    targets.push({
      target: "pino/file",
      options: { destination: dest, mkdir: true, append: true },
      level: opts.level,
    });
  }

  const transport = pino.transport({ targets });
  return pino({ level: opts.level }, transport);
}
