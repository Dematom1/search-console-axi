import { decode, encode } from "@toon-format/toon";
import { getAuthClient } from "../auth.js";
import { inspectUrl } from "../google.js";
import { parseArgs, usage } from "../args.js";
import { helpText, type Help } from "../help.js";
import { resolveSite } from "../site.js";

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
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
      usage("inspect requires an absolute HTTP(S) URL");
  } catch (error) {
    if (error instanceof Error && error.message.includes("HTTP(S)")) throw error;
    usage("inspect requires an absolute HTTP(S) URL");
  }
  const quotaProject = parsed.flags.get("--quota-project");
  const auth = await getAuthClient({ quotaProject: typeof quotaProject === "string" ? quotaProject : undefined });
  const requestedSite = parsed.flags.get("--site");
  const { site, site_source } = await resolveSite(auth, typeof requestedSite === "string" ? requestedSite : undefined);
  const result: unknown = decode(await inspectUrl(auth, url, site));
  const output =
    result && typeof result === "object" && !Array.isArray(result)
      ? { ...result, site, site_source }
      : { result, site, site_source };
  return encode(output);
}
export const command = { name: "inspect", help: helpText("inspect", help), run };
