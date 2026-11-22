import { AxiError } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { getAuthClient } from "../auth.js";
import { parseArgs, usage } from "../args.js";
import { helpText } from "../help.js";
import { resolveSite, validateSite } from "../site.js";

const writeScope = "https://www.googleapis.com/auth/webmasters";
const note =
  "lastDownloaded is last read. Status is derived from isPending/errors, not the UI status text. Discovered pages are contents[].submitted by content type; no total is invented. indexed is deprecated and not reliable index coverage. Missing API fields are null (unknown), not zero.";
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
function urlInput(value: string): string {
  try {
    const url = new URL(value);
    if (
      !/^https?:\/\//i.test(value) ||
      url.username ||
      url.password ||
      /[\\#\s]/.test(value) ||
      [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      usage("Sitemap must be an absolute HTTP(S) URL without credentials, fragments, or whitespace");
  } catch {
    usage("Sitemap must be an absolute HTTP(S) URL without credentials, fragments, or whitespace");
  }
  return value;
}
function count(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}
function sitemap(value: unknown) {
  const data = object(value);
  const errors = count(data.errors);
  return {
    path: typeof data.path === "string" ? data.path : null,
    type: typeof data.type === "string" ? data.type : null,
    isSitemapsIndex: typeof data.isSitemapsIndex === "boolean" ? data.isSitemapsIndex : null,
    lastSubmitted: typeof data.lastSubmitted === "string" ? data.lastSubmitted : null,
    lastDownloaded: typeof data.lastDownloaded === "string" ? data.lastDownloaded : null,
    isPending: typeof data.isPending === "boolean" ? data.isPending : null,
    status:
      data.isPending === true
        ? "pending"
        : errors !== null && BigInt(errors) > 0n
          ? "errors"
          : data.isPending === false && errors === "0"
            ? "success"
            : "unknown",
    errors,
    warnings: count(data.warnings),
    contents: Array.isArray(data.contents)
      ? data.contents.map((value) => {
          const item = object(value);
          return {
            type: typeof item.type === "string" ? item.type : null,
            submitted: count(item.submitted),
            indexed: count(item.indexed),
          };
        })
      : null,
  };
}
export async function run(args: string[]): Promise<string> {
  const [action, ...rest] = args;
  if (!["list", "get", "submit"].includes(action ?? ""))
    usage("Expected sitemaps list, get, or submit; run search-console-axi sitemaps --help");
  const writing = action === "submit";
  const parsed = parseArgs(
    rest,
    ["--site", "--quota-project"],
    writing ? ["--confirm"] : [],
  );
  if (parsed.positionals.length !== (action === "list" ? 0 : 1))
    usage("Use sitemaps list or sitemaps get|submit <sitemap-url> [--site <property>]");
  const flag = parsed.flags.get("--site");
  const requestedSite = typeof flag === "string" ? validateSite(flag) : undefined;
  const target = action === "list" ? undefined : urlInput(parsed.positionals[0]!);
  if (writing && !requestedSite)
    usage("sitemaps submit requires --site <exact-property> so the preview names the explicit writable target");
  const endpoint = (site: string) =>
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps${target ? `/${encodeURIComponent(target)}` : ""}`;
  if (writing && !parsed.flags.has("--confirm"))
    return encode({
      mode: "preview",
      site: requestedSite,
      path: target,
      method: "PUT",
      url: endpoint(requestedSite!),
      request_count: 1,
      help: ["Repeat the same command with --confirm to submit this exact property and sitemap"],
    });
  try {
    const quota = parsed.flags.get("--quota-project");
    const auth = await getAuthClient({
      quotaProject: typeof quota === "string" ? quota : undefined,
      ...(writing ? { scopes: [writeScope] } : {}),
    });
    // Writes use the exact explicit property, never resolve it to a different property.
    let site = requestedSite!;
    if (!writing) {
      const resolution = await resolveSite(auth, requestedSite);
      if (resolution.kind === "unavailable")
        usage("No verified Search Console sites visible; configure --site or grant access");
      site = resolution.site;
    }
    const response = await auth.client.request<unknown>({
      url: endpoint(site),
      method: writing ? "PUT" : "GET",
      retry: false,
    });
    if (writing)
      return encode({
        mode: "submitted",
        site,
        path: target,
        note: "Submission acknowledged; not a crawl or indexing guarantee",
      });
    if (action === "get") return encode({ site, sitemap: sitemap(response.data), note });
    const data = response.data;
    if (!isObject(data) || (data.sitemap !== undefined && !Array.isArray(data.sitemap)))
      throw new Error("Invalid sitemap list");
    const sitemaps = Array.isArray(data.sitemap) ? [...data.sitemap] : [];
    let pageToken = data.nextPageToken;
    const seenPageTokens = new Set<string>();
    while (typeof pageToken === "string" && pageToken.length > 0) {
      if (seenPageTokens.has(pageToken))
        throw new AxiError("Search Console returned a repeated sitemap page token", "SITEMAPS_ERROR");
      seenPageTokens.add(pageToken);
      const page = await auth.client.request<unknown>({
        url: endpoint(site),
        method: "GET",
        retry: false,
        params: { pageToken },
      });
      const pageData = page.data;
      if (!isObject(pageData) || (pageData.sitemap !== undefined && !Array.isArray(pageData.sitemap)))
        throw new Error("Invalid sitemap list");
      if (Array.isArray(pageData.sitemap)) sitemaps.push(...pageData.sitemap);
      pageToken = pageData.nextPageToken;
    }
    const mapped = sitemaps.map(sitemap);
    return encode({
      site,
      count: mapped.length,
      sitemaps: mapped,
      note,
      help: [
        "search-console-axi sitemaps get <sitemap-url> --site " + site,
        "search-console-axi sitemaps list --site " + site,
      ],
    });
  } catch (error) {
    if (error instanceof AxiError) throw error;
    const response = object(object(error).response);
    const info = object(object(response.data).error);
    const reasons = [
      ...(Array.isArray(info.details) ? info.details : []),
      ...(Array.isArray(info.errors) ? info.errors : []),
    ].map((item) => object(item).reason);
    const scope = writing ? writeScope : "https://www.googleapis.com/auth/webmasters.readonly";
    const message =
      reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || reasons.includes("insufficientPermissions")
        ? `Credentials lack the required OAuth scope ${scope}; reauthorize user ADC explicitly. Existing refresh tokens cannot gain scopes automatically`
        : response.status === 403
          ? `Search Console access denied; check property permissions, API enablement, and required OAuth scope ${scope}`
          : response.status === 404
            ? "Sitemap or property not found; check the exact property and sitemap URL"
            : response.status === 429
              ? "Search Console quota exceeded; wait before retrying"
              : "Sitemaps authentication or API request failed; check credentials and network";
    throw new AxiError(message, "SITEMAPS_ERROR", [
      "Run search-console-axi sitemaps --help. Writes are not retried; after an unknown outcome, use sitemaps get before resubmitting",
    ]);
  }
}
export const name = "sitemaps";
const commonFlags = {
  "--site <property>": "Property; reads default to configured or first verified site; submit requires exact property",
  "--quota-project <id>": "Set quota project",
  "--help": "Show help",
};
export const help = helpText(name, {
  purpose: "List/get submitted sitemaps or preview/submit a sitemap. " + note,
  flags: commonFlags,
  examples: [
    "search-console-axi sitemaps list",
    "search-console-axi sitemaps get https://example.com/sitemap.xml",
    "search-console-axi sitemaps submit https://example.com/sitemap.xml --site sc-domain:example.com",
  ],
  next: ["search-console-axi sitemaps submit --help"],
});
export const command = {
  name,
  help,
  subcommands: Object.fromEntries(
    ["list", "get", "submit"].map((action) => [
      action,
      helpText(`sitemaps ${action}`, {
        purpose:
          action === "submit"
            ? `Preview without credentials; --confirm submits with ${writeScope}. No automatic scope widening or retries.`
            : note,
        flags: {
          ...commonFlags,
          ...(action === "list" ? {} : { "<sitemap-url>": "Required absolute HTTP(S) sitemap URL" }),
          ...(action === "submit" ? { "--confirm": "Submit the exact previewed property and sitemap" } : {}),
        },
        examples: [
          `search-console-axi sitemaps ${action}${action === "list" ? "" : " https://example.com/sitemap.xml"} --site sc-domain:example.com`,
        ],
        next: [],
      }),
    ]),
  ),
  run,
};
