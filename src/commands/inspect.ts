import { decode, encode } from "@toon-format/toon";
import { getAuthClient } from "../auth.js";
import { inspectUrl } from "../google.js";
import { parseArgs, usage } from "../args.js";
import { helpText, type Help } from "../help.js";
import { resolveSite, validateSite } from "../site.js";

export const help: Help = {
  purpose: "Inspect a URL's Google index status.",
  flags: {
    "--site <site>": "Select property; defaults to configured or first verified site",
    "--quota-project <id>": "Set quota project",
    "--help": "Show this help",
  },
  examples: [
    "search-console-axi inspect https://example.com/",
    "search-console-axi inspect https://example.com/ --site sc-domain:example.com",
  ],
  next: ["search-console-axi report", "search-console-axi setup check"],
};
export async function run(args: string[] = []): Promise<string> {
  const parsed = parseArgs(args, ["--site", "--quota-project"]);
  if (parsed.positionals.length !== 1) usage("usage: search-console-axi inspect <url> [--site <site>]");
  const url = parsed.positionals[0]!;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    usage("inspect requires an absolute HTTP(S) URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
    usage("inspect requires an absolute HTTP(S) URL");
  if (parsedUrl.username || parsedUrl.password) usage("inspect URL must not contain credentials");
  const requestedSite = parsed.flags.get("--site");
  if (typeof requestedSite === "string") validateSite(requestedSite);
  const quotaProject = parsed.flags.get("--quota-project");
  const auth = await getAuthClient({ quotaProject: typeof quotaProject === "string" ? quotaProject : undefined });
  const resolution = await resolveSite(auth, typeof requestedSite === "string" ? requestedSite : undefined);
  if (resolution.kind === "unavailable")
    return usage("No verified Search Console sites visible; configure --site or grant access.");
  const { site, site_source } = resolution;
  const result: unknown = decode(await inspectUrl(auth, url, site));
  const output =
    result && typeof result === "object" && !Array.isArray(result)
      ? { ...result, site, site_source }
      : { result, site, site_source };
  return encode(output);
}
export const name = "inspect";
export const command = { name, help: helpText(name, help), run };
