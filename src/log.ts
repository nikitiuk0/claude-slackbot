import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  const isTty = process.stdout.isTTY;
  return pino({
    level,
    transport: isTty
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        }
      : undefined,
  });
}
