// Usage: tsx src/ops/migrate-broadcast.ts wss://new.example/ws
// Posts to /ops/migrate with the OPS_ADMIN_SECRET shared-secret header.
import { loadConfig } from "../config.js";

async function main() {
  const newUrl = process.argv[2];
  if (!newUrl) {
    console.error("usage: migrate-broadcast <new_ws_url>");
    process.exit(2);
  }
  const cfg = loadConfig(process.env);
  const adminSecret = process.env.OPS_ADMIN_SECRET;
  if (!adminSecret) {
    console.error("OPS_ADMIN_SECRET env not set");
    process.exit(2);
  }
  const res = await fetch(`${cfg.publicServerUrl}/ops/migrate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ops-admin": adminSecret },
    body: JSON.stringify({ new_url: newUrl }),
  });
  if (!res.ok) {
    console.error(`failed: status=${res.status} body=${await res.text()}`);
    process.exit(1);
  }
  console.log(await res.json());
}

main().catch((err) => { console.error(err); process.exit(1); });
