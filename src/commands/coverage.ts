import { decode, encode } from "@toon-format/toon";
import { parseArgs, usage } from "../args.js";
import { getAuthClient } from "../auth.js";
import { inspectUrl } from "../google.js";
import { resolveSite, validateSite } from "../site.js";
import { helpText, type Help } from "../help.js";
import { readUrls, validateUrl } from "../coverage-input.js";
import { collectCoverage, coverageCsv, groupCoverage } from "../coverage.js";

export const help: Help = {
  purpose:
    "Read URL Inspection coverage for explicit URLs (not the Page indexing report). Saves progress locally; rerun to resume.",
  flags: {
    "--sitemap <url>": "Fetch a sitemap or sitemap index; mutually exclusive with file/stdin input",
    "--site <site>": "Select property; defaults to configured or first verified site",
    "--state <file>": "Progress file; default: user state directory, per property",
    "--refresh": "Re-inspect completed URLs without resetting quota accounting",
    "--format <toon|json|csv>": "Default toon: grouped counts and URL lists; json/csv: per-URL rows",
    "--quota-project <id>": "Set quota project",
    "--help": "Show help",
  },
  examples: [
    "search-console-axi coverage --sitemap https://example.com/sitemap.xml --site sc-domain:example.com",
    "search-console-axi coverage urls.txt --state coverage.json --format json",
    "search-console-axi coverage - --format csv < urls.txt",
  ],
  next: ["search-console-axi inspect <url>", "search-console-axi coverage --help"],
};
export async function run(args: string[] = []): Promise<string> {
  const parsed = parseArgs(args, ["--sitemap", "--site", "--state", "--format", "--quota-project"], ["--refresh"]);
  const value = (flag: string) => {
    const v = parsed.flags.get(flag);
    return typeof v === "string" ? v : undefined;
  };
  const sitemap = value("--sitemap");
  if (sitemap ? parsed.positionals.length !== 0 : parsed.positionals.length !== 1)
    usage("usage: search-console-axi coverage <file|-> OR coverage --sitemap <url>");
  if (sitemap) validateUrl(sitemap);
  const format = value("--format") ?? "toon";
  if (!["toon", "json", "csv"].includes(format)) usage("--format must be toon, json or csv");
  const requestedSite = value("--site");
  if (requestedSite) validateSite(requestedSite);
  const urls = await readUrls(sitemap ? { sitemap } : { file: parsed.positionals[0]! });
  const auth = await getAuthClient({ quotaProject: value("--quota-project") });
  const resolution = await resolveSite(auth, requestedSite);
  if (resolution.kind === "unavailable")
    usage("No verified Search Console sites visible; configure --site or grant access.");
  const result = await collectCoverage({
    site: resolution.site,
    urls,
    state: value("--state"),
    refresh: parsed.flags.has("--refresh"),
    inspect: async (url) => decode(await inspectUrl(auth, url, resolution.site)),
  });
  if (format === "json") return JSON.stringify(result);
  const { rows, ...summary } = result;
  if (format === "csv") {
    process.stderr.write(encode(summary) + "\n");
    return coverageCsv(rows);
  }
  return encode({
    ...summary,
    groups: groupCoverage(rows),
    help: result.remaining ? ["Rerun the same command after quota is available; finished URLs are saved."] : [],
  });
}
export const name = "coverage";
export const command = { name, help: helpText(name, help), run };
