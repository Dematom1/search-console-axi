#!/usr/bin/env node
import { runAxiCli } from "axi-sdk-js";
import { readFileSync } from "node:fs";
import { getAuthClient, setupCommand } from "./auth.js";
import { runHome } from "./setup-check.js";
import { indexingCommand } from "./indexing.js";

const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const description =
  "Google Search Console reporting, URL inspection, and preview-gated Indexing API notifications for agents";
const args = process.argv.slice(2);
await runAxiCli({
  description,
  version,
  argv: args,
  topLevelHelp: `${description}\n\nUsage: search-console-axi [--help] [--version]\n\nCommands:\n  setup    Configure, inspect, or remove authentication\n  inspect  Inspect a URL's index status\n  indexing Publish notifications, read metadata, batch, and view quota`,
  commands: {
    setup: setupCommand,
    indexing: (args) => indexingCommand(args),
    inspect: (args) =>
      args.includes("--help") || args.includes("-h")
        ? "usage: search-console-axi inspect <url> --site <site> [--quota-project <project>]\n"
        : setupCommand(["inspect", ...args]),
  },
  home: async () => {
    try {
      return await runHome(await getAuthClient());
    } catch {
      return setupCommand(["status"]);
    }
  },
});
