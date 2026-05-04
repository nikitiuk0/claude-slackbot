import { mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(opts: { level: string; logFile: string }): Logger {
  const isTty = process.stdout.isTTY;
  const targets: pino.TransportTargetOptions[] = [];

  targets.push(
    isTty
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", destination: 1 },
          level: opts.level,
        }
      : { target: "pino/file", options: { destination: 1 }, level: opts.level }
  );

  if (opts.logFile) {
    const dest = resolvePath(opts.logFile);
    mkdirSync(dirname(dest), { recursive: true });
    targets.push({
      target: "pino/file",
      options: { destination: dest, mkdir: true, append: true },
      level: opts.level,
    });
  }

  return pino({ level: opts.level }, pino.transport({ targets }));
}
