#!/usr/bin/env node
// Spawns a long-running child shell, prints the child's PID to stdout
// (so the test can verify it dies), then waits forever.
import { spawn } from "node:child_process";

const child = spawn("sh", ["-c", "sleep 120"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ childPid: child.pid }) + "\n");
// Keep parent alive until killed.
setInterval(() => {}, 60_000);
