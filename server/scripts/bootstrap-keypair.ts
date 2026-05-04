// One-time bootstrap: generates the server's Ed25519 service keypair.
// Run: `npx tsx server/scripts/bootstrap-keypair.ts`
// Writes to ./server/data/server-ed25519.{key,pub}.
import { generateAndSaveServiceKey } from "../src/identity/service-key.js";

async function main() {
  await generateAndSaveServiceKey({
    privatePath: "./data/server-ed25519.key",
    publicPath: "./data/server-ed25519.pub",
  });
  console.log("server keypair written to server/data/server-ed25519.{key,pub}");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
