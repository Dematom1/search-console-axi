import { setupCommand } from "../auth.js";
import { helpText, type Help } from "../help.js";

export const help: Help = {
  purpose: "Configure credentials and verify Search Console access.",
  flags: { "--quota-project <id>": "Set quota project", "--help": "Show this help" },
  examples: ["search-console-axi setup", "search-console-axi setup check"],
  next: ["search-console-axi report", "search-console-axi inspect <url>"],
};
export const command = { name: "setup", help: helpText("setup", help), run: (args: string[]) => setupCommand(args) };
