#!/usr/bin/env node
import { runPair } from "./cli/pair.js";
import { runStart } from "./cli/start.js";
import { runUnpair } from "./cli/unpair.js";
import { runProfiles } from "./cli/profiles.js";

const [, , subcommand, ...rest] = process.argv;

async function main() {
  switch (subcommand) {
    case "pair":      return runPair(rest);
    case "start":     return runStart(rest);
    case "unpair":    return runUnpair(rest);
    case "profiles":  return runProfiles(rest);
    case "version":   console.log(process.env.npm_package_version ?? "0.2.0-dev"); return;
    case undefined:
    case "help":      printHelp(); return;
    default:          console.error(`unknown subcommand: ${subcommand}`); printHelp(); process.exit(2);
  }
}

function printHelp() {
  console.log(`claude-slackbot — CLI

  pair --profile <name> --server <url> --code <PAIR-...>
  start [--profile <name>]
  unpair --profile <name>
  profiles list | default <name>
  version
  help
`);
}

main().catch((err) => { console.error(err); process.exit(1); });
