import { getAuthClient } from "../auth.js";
import { runHome } from "../google.js";
import { parseArgs, usage } from "../args.js";
import { helpText, type Help } from "../help.js";

export const help: Help = {
  purpose: "Report Search Console performance for a property.",
  flags: { "--site <site>": "Select property", "--days <1..90>": "Report period", "--help": "Show this help" },
  examples: ["search-console-axi report", "search-console-axi report --site sc-domain:example.com"],
  next: ["search-console-axi inspect <url>", "search-console-axi setup check"],
};
export async function run(args: string[] = []): Promise<string> {
  const parsed = parseArgs(args, ["--site", "--days"]);
  if (parsed.positionals.length) usage("report does not take positional arguments");
  const days = parsed.flags.get("--days");
  if (days !== undefined && (typeof days !== "string" || !/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 90))
    usage("--days must be between 1 and 90");
  const site = parsed.flags.get("--site");
  return runHome(await getAuthClient(), typeof site === "string" ? site : undefined);
}
export const command = { name: "report", help: helpText("report", help), run };
