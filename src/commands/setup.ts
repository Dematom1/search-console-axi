import { setupCommand } from "../auth.js";
import { helpText, type Help } from "../help.js";

export const help: Help = {
  purpose: "Configure credentials and verify Search Console access.",
  flags: { "--quota-project <id>": "Set quota project", "--help": "Show this help" },
  examples: ["search-console-axi setup", "search-console-axi setup check"],
  next: ["search-console-axi report", "search-console-axi inspect <url>"],
};
export const name = "setup";
export const run = (args: string[]) => setupCommand(args);
export const command = {
  name,
  help: helpText("setup", help),
  subcommands: {
    check: helpText("setup check", {
      purpose: "Check credentials and Search Console access.",
      flags: { "--quota-project <id>": "Set quota project", "--help": "Show this help" },
      examples: ["search-console-axi setup check"],
      next: ["search-console-axi report"],
    }),
    status: helpText("setup status", {
      purpose: "Show configured credentials and setup status.",
      flags: { "--quota-project <id>": "Set quota project", "--help": "Show this help" },
      examples: ["search-console-axi setup status"],
      next: ["search-console-axi setup check"],
    }),
    site: helpText("setup site", {
      purpose: "Save the default Search Console property.",
      flags: { "<url>": "Required property URL", "--help": "Show this help" },
      examples: ["search-console-axi setup site https://example.com/"],
      next: ["search-console-axi report"],
    }),
    "service-account": helpText("setup service-account", {
      purpose: "Configure a service-account key file.",
      flags: {
        "<key.json>": "Required service-account key file",
        "--quota-project <id>": "Set quota project",
        "--help": "Show this help",
      },
      examples: ["search-console-axi setup service-account key.json"],
      next: ["search-console-axi setup check"],
    }),
    uninstall: helpText("setup uninstall", {
      purpose: "Remove saved Search Console configuration.",
      flags: { "--help": "Show this help" },
      examples: ["search-console-axi setup uninstall"],
      next: ["search-console-axi setup"],
    }),
  },
  run,
};
