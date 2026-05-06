import { z } from "zod";

const Schema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  DATABASE_PATH: z.string().min(1).default("./data/claude-slackbot.sqlite"),
  SERVER_PRIVATE_KEY_PATH: z.string().min(1),
  SERVER_PUBLIC_KEY_PATH: z.string().min(1),
  PUBLIC_SERVER_URL: z.string().url(),
  PUBLIC_WS_URL: z.string().regex(/^wss?:\/\//, "PUBLIC_WS_URL must start with ws(s)://"),
  ALLOWED_NPM_PUBLISHER: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8443),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_FILE: z.string().default(""),
});

export type ServerConfig = {
  slackBotToken: string;
  slackAppToken: string;
  databasePath: string;
  serverPrivateKeyPath: string;
  serverPublicKeyPath: string;
  publicServerUrl: string;
  publicWsUrl: string;
  allowedNpmPublisher: string;
  port: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  logFile: string;
};

export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = Schema.parse(env);
  return {
    slackBotToken: parsed.SLACK_BOT_TOKEN,
    slackAppToken: parsed.SLACK_APP_TOKEN,
    databasePath: parsed.DATABASE_PATH,
    serverPrivateKeyPath: parsed.SERVER_PRIVATE_KEY_PATH,
    serverPublicKeyPath: parsed.SERVER_PUBLIC_KEY_PATH,
    publicServerUrl: parsed.PUBLIC_SERVER_URL,
    publicWsUrl: parsed.PUBLIC_WS_URL,
    allowedNpmPublisher: parsed.ALLOWED_NPM_PUBLISHER,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    logFile: parsed.LOG_FILE,
  };
}
