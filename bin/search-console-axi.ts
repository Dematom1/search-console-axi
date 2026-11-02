#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { readFileSync } from "node:fs";
import { getAuthClient, setupCommand } from "./auth.js";
import { runHome } from "./setup-check.js";

const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const description = "Read-only Google Search Console reporting and URL inspection for agents";
const args = process.argv.slice(2);
await runAxiCli({
  description,
  version,
  argv: args,
  topLevelHelp: `${description}\n\nUsage: search-console-axi [--help] [--version]\n\nCommands:\n  setup    Configure, inspect, or remove authentication\n  inspect  Inspect a URL's index status`,
  commands: {
    setup: setupCommand,
    inspect: (args) => setupCommand(["inspect", ...args]),
  },
  home: async () => {
    try {
      return await runHome(await getAuthClient());
    } catch {
      return setupCommand(["status"]);
    }
  },
});
