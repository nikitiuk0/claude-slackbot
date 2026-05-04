#!/usr/bin/env node
// Echoes one NDJSON event per 10ms then exits 0.
import { setTimeout as wait } from "node:timers/promises";

const events = [
  { type: "system", subtype: "init", session_id: "fake-sess-1" },
  { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "x.ts" } }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "<slack-summary>\nSummary: ok\n</slack-summary>" }] } },
  { type: "result", subtype: "success" },
];

for (const ev of events) {
  process.stdout.write(JSON.stringify(ev) + "\n");
  await wait(10);
}
process.exit(0);
