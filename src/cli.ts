import { AxiError } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { command as setup } from "./commands/setup.js";
import { command as report } from "./commands/report.js";
import { command as inspect } from "./commands/inspect.js";
import { command as indexing } from "./commands/indexing.js";
import { usage } from "./args.js";
import { helpText } from "./help.js";
import { getAuthClient, setupCommand } from "./auth.js";
import { runHome } from "./google.js";

const description =
  "Google Search Console reporting, URL inspection, and preview-gated Indexing API notifications for agents";
export const commands = [setup, report, inspect, indexing];
const registry = new Map(commands.map((command) => [command.name, command]));
export function getCommandHelp(args: string[]): string {
  if (!args.length)
    return helpText("search-console-axi", {
      purpose: description,
      flags: { "--help": "Show help", "--version": "Show version" },
      examples: ["search-console-axi", "search-console-axi report"],
      next: commands.map((command) => `search-console-axi ${command.name}`),
    });
  if (args[0] === "setup" && args[1]) {
    const actionHelp = {
      check: { purpose: "Check credentials and Search Console access.", flags: { "--help": "Show this help" }, examples: ["search-console-axi setup check"], next: ["search-console-axi report"] },
      status: { purpose: "Show configured credentials and setup status.", flags: { "--help": "Show this help" }, examples: ["search-console-axi setup status"], next: ["search-console-axi setup check"] },
      site: { purpose: "Save the default Search Console property.", flags: { "<url>": "Required property URL", "--help": "Show this help" }, examples: ["search-console-axi setup site https://example.com/"], next: ["search-console-axi report"] },
    }[args[1] as "check" | "status" | "site"];
    if (actionHelp) return helpText(`setup ${args[1]}`, actionHelp);
  }
  if (args[0] === "indexing" && args[1]) {
    const actionHelp = {
      publish: { purpose: "Preview or submit one URL notification.", flags: { "<url>": "Required HTTP(S) URL", "--type <updated|deleted>": "Required notification type", "--confirm": "Submit the previewed target", "--help": "Show this help" }, examples: ["search-console-axi indexing publish https://example.com/ --type updated"], next: ["search-console-axi indexing status <url>"] },
      status: { purpose: "Read notification metadata for a URL.", flags: { "<url>": "Required HTTP(S) URL", "--help": "Show this help" }, examples: ["search-console-axi indexing status https://example.com/"], next: ["search-console-axi indexing publish <url> --type updated"] },
      batch: { purpose: "Preview or submit URL notifications from a file or stdin.", flags: { "<file|->": "Required input; '-' reads stdin", "--type <updated|deleted>": "Required notification type", "--confirm": "Submit the previewed targets", "--help": "Show this help" }, examples: ["search-console-axi indexing batch urls.txt --type deleted"], next: ["search-console-axi indexing status <url>"] },
      quota: { purpose: "Read Indexing API quota usage.", flags: { "--help": "Show this help" }, examples: ["search-console-axi indexing quota"], next: ["search-console-axi indexing status <url>"] },
    }[args[1] as "publish" | "status" | "batch" | "quota"];
    if (actionHelp) return helpText(`indexing ${args[1]}`, actionHelp);
  }
  const command = registry.get(args[0]!);
  if (command) return command.help;
  return getCommandHelp([]);
}
export async function runAxiCli(args = process.argv.slice(2)): Promise<void> {
  process.env.METADATA_SERVER_DETECTION ??= "none";
  try {
    if (args.includes("--help") || args.includes("-h")) {
      process.stdout.write(
        getCommandHelp(args.slice(0, args.indexOf(args.includes("--help") ? "--help" : "-h"))) + "\n",
      );
      return;
    }
    if (args.length === 0) {
      try {
        process.stdout.write((await runHome(await getAuthClient())) + "\n");
      } catch {
        process.stdout.write((await setupCommand(["status"])) + "\n");
      }
      return;
    }
    const [name, ...rest] = args;
    if (name === "--version") {
      const { readFileSync } = await import("node:fs");
      process.stdout.write(
        `${JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version}\n`,
      );
      return;
    }
    const command = registry.get(name!);
    if (!command) usage(`Unknown command '${name}'`);
    process.stdout.write((await command.run(rest)) + "\n");
  } catch (error) {
    const axi = error instanceof AxiError ? error : undefined;
    const code = axi?.code ?? "INTERNAL_ERROR";
    process.stdout.write(
      encode({
        error: { code, message: error instanceof Error ? error.message : String(error) },
        help: axi?.suggestions ?? [],
      }) + "\n",
    );
    process.exitCode = code === "VALIDATION_ERROR" ? 2 : 1;
  }
}
