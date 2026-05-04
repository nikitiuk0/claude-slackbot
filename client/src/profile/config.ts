import { z } from "zod";

const Schema = z.object({
  serverUrl: z.string().url(),
  workdir: z.string().min(1),
  claudeBinary: z.string().default("claude"),
  maxParallelJobs: z.number().int().positive().default(3),
  stallSoftNoticeMinutes: z.number().positive().default(5),
  stallHardStopHours: z.number().positive().default(24),
  slackEditCoalesceMs: z.number().positive().default(3000),
  archiveIdleDays: z.number().nonnegative().default(7),
});

export type ProfileConfig = z.infer<typeof Schema>;

export function parseProfileConfig(raw: unknown): ProfileConfig {
  return Schema.parse(raw);
}
