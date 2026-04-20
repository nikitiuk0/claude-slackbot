import { z } from "zod";

const EnvSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN required"),
  SLACK_APP_TOKEN: z.string().min(1, "SLACK_APP_TOKEN required"),
  ALLOWED_USER_IDS: z
    .string()
    .min(1, "ALLOWED_USER_IDS required")
    .transform((s) =>
      s.split(",").map((x) => x.trim()).filter((x) => x.length > 0)
    )
    .refine((arr) => arr.length > 0, "ALLOWED_USER_IDS must be non-empty"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  LOG_FILE: z.string().default("./data/logs/daemon.log"),
});

const JsonSchema = z.object({
  workdir: z.string().min(1),
  claudeBinary: z.string().default("claude"),
  maxParallelJobs: z.number().int().positive().default(3),
  stallSoftNoticeMinutes: z.number().positive().default(5),
  stallHardStopHours: z.number().positive().default(24),
  slackEditCoalesceMs: z.number().positive().default(3000),
  ownerDisplayName: z.string().min(1),
  /** Days of inactivity after which a thread's state/milestones/attachments
   *  are purged by the janitor. 0 disables the janitor. */
  archiveIdleDays: z.number().nonnegative().default(7),
});

export type Config = {
  slackBotToken: string;
  slackAppToken: string;
  allowedUserIds: string[];
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  logFile: string;
  workdir: string;
  claudeBinary: string;
  maxParallelJobs: number;
  stallSoftNoticeMinutes: number;
  stallHardStopHours: number;
  slackEditCoalesceMs: number;
  ownerDisplayName: string;
  archiveIdleDays: number;
};

export function loadConfig(input: {
  env: Record<string, string | undefined>;
  json: unknown;
}): Config {
  const env = EnvSchema.parse(input.env);
  const json = JsonSchema.parse(input.json);
  return {
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackAppToken: env.SLACK_APP_TOKEN,
    allowedUserIds: env.ALLOWED_USER_IDS,
    logLevel: env.LOG_LEVEL,
    logFile: env.LOG_FILE,
    ...json,
  };
}
