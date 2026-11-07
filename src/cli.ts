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
  const command = registry.get(args[0]!);
  if (command) {
    const action = args[1];
    if (action && "subcommands" in command && action in command.subcommands)
      return command.subcommands[action as keyof typeof command.subcommands];
    return command.help;
  }
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
