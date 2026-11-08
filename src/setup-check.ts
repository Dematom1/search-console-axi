import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import type { AuthProvider } from "./auth.js";
import { setupGuide } from "./setup-guide.js";
import { searchDateRange } from "./period.js";
import { isValidSite, type SiteResolution } from "./site.js";
export { setupGuide } from "./setup-guide.js";

const API = "https://searchconsole.googleapis.com/webmasters/v3/sites";
const verifiedPermissions = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);

type Site = { siteUrl: string; permissionLevel?: string };

export function apiDisabledMessage(error: unknown): string | undefined {
  if (
    !error ||
    typeof error !== "object" ||
    !("response" in error) ||
    !error.response ||
    typeof error.response !== "object"
  )
    return undefined;
  const response = error.response;
  if (!("status" in response) || response.status !== 403 || !("data" in response)) return undefined;
  const body = response.data;
  if (!body || typeof body !== "object" || !("error" in body) || !body.error || typeof body.error !== "object")
    return undefined;
  const googleError = body.error;
  const details = "details" in googleError && Array.isArray(googleError.details) ? googleError.details : [];
  const legacy = "errors" in googleError && Array.isArray(googleError.errors) ? googleError.errors : [];
  const reasons = [
    ...details.flatMap((detail) => (detail && typeof detail === "object" && "reason" in detail ? [detail.reason] : [])),
    ...legacy.flatMap((detail) => (detail && typeof detail === "object" && "reason" in detail ? [detail.reason] : [])),
  ];
  if (!reasons.some((reason) => reason === "SERVICE_DISABLED" || reason === "accessNotConfigured")) return undefined;
  const metadata = details.find(
    (detail) =>
      detail &&
      typeof detail === "object" &&
      "metadata" in detail &&
      detail.metadata &&
      typeof detail.metadata === "object",
  );
  const service =
    metadata && "metadata" in metadata && metadata.metadata && "service" in metadata.metadata
      ? metadata.metadata.service
      : undefined;
  const consumer =
    metadata && "metadata" in metadata && metadata.metadata && "consumer" in metadata.metadata
      ? metadata.metadata.consumer
      : undefined;
  const message = "message" in googleError && typeof googleError.message === "string" ? googleError.message : "";
  const api =
    typeof service === "string"
      ? service
      : (message.match(/[\w.-]+\.googleapis\.com/)?.[0] ?? "Google Search Console API");
  const project =
    (typeof consumer === "string" ? consumer.match(/projects\/([^/]+)/)?.[1] : undefined) ??
    message.match(/project\s+([\w.-]+)/i)?.[1] ??
    "your Google Cloud project";
  return `Enable ${api} in ${project} to use Search Console.`;
}

const ACCESS_DENIED =
  "Search Console access denied. Add the authenticated account in Search Console Settings > Users and permissions.";

export async function request(auth: AuthProvider, url: string, method = "GET", data?: object): Promise<unknown> {
  try {
    const response = await auth.client.request({ url, method, ...(data ? { data } : {}) });
    return response.data;
  } catch (error) {
    if (error instanceof Error && "response" in error && error.response && typeof error.response === "object") {
      const response = error.response;
      if ("status" in response && response.status === 403) error.message = apiDisabledMessage(error) ?? ACCESS_DENIED;
    }
    throw error;
  }
}

export async function sites(auth: AuthProvider): Promise<Site[]> {
  const data = await request(auth, API);
  if (!data || typeof data !== "object" || !("siteEntry" in data) || !Array.isArray(data.siteEntry)) return [];
  return data.siteEntry.flatMap((site) =>
    site &&
    typeof site === "object" &&
    "siteUrl" in site &&
    typeof site.siteUrl === "string" &&
    isValidSite(site.siteUrl)
      ? [
          {
            siteUrl: site.siteUrl,
            ...("permissionLevel" in site && typeof site.permissionLevel === "string"
              ? { permissionLevel: site.permissionLevel }
              : {}),
          },
        ]
      : [],
  );
}

export async function runSetupCheck(auth: AuthProvider): Promise<string> {
  try {
    const accessible = await sites(auth);
    const reportable = accessible.filter((site) => verifiedPermissions.has(site.permissionLevel ?? ""));
    const missing = reportable.length
      ? []
      : ["No verified Search Console sites visible to this account - grant access as in step 4, or none exist."];
    return encode({
      auth: { type: auth.type, source: auth.source, ...(auth.email ? { account_email: auth.email } : {}) },
      setup: { status: missing.length ? "incomplete" : "ready", missing, guide: setupGuide },
      sites: accessible
        .slice(0, 100)
        .map(({ siteUrl, permissionLevel }) => ({ site_url: siteUrl, permission: permissionLevel ?? "" })),
      truncated: accessible.length > 100,
    });
  } catch (error) {
    const status =
      error &&
      typeof error === "object" &&
      "response" in error &&
      error.response &&
      typeof error.response === "object" &&
      "status" in error.response
        ? error.response.status
        : undefined;
    const message =
      error instanceof Error && error.message.startsWith("Enable ")
        ? error.message
        : status === 403
          ? ACCESS_DENIED
          : "Search Console API request failed. Check API access and network connectivity.";
    return encode({
      auth: { type: auth.type, source: auth.source },
      setup: { status: "incomplete", missing: [message], guide: setupGuide },
    });
  }
}

export async function runHome(auth: AuthProvider, selection: Promise<SiteResolution>, days = 7): Promise<string> {
  try {
    const resolution = await selection;
    if (resolution.kind === "unavailable")
      return encode({
        tool: "search-console-axi",
        sites: resolution.visibleSiteCount
          ? "No verified Search Console sites visible to this account - grant access as in step 4, or none exist."
          : "No Search Console sites visible to this account - grant access as in step 4, or none exist.",
        help: ["Run search-console-axi setup for access instructions."],
      });
    const { site, site_source, verifiedSiteCount } = resolution;
    const range = searchDateRange();
    const dateRange =
      days === 7
        ? range
        : {
            ...range,
            startDate: new Date(Date.parse(range.endDate) - (days - 1) * 86_400_000).toISOString().slice(0, 10),
          };
    const query = async (dimension: "query" | "page", orderBy: string) => {
      const result = await request(auth, `${API}/${encodeURIComponent(site)}/searchAnalytics/query`, "POST", {
        ...dateRange,
        dimensions: [dimension],
        rowLimit: 10,
        orderBy: [{ field: orderBy, direction: "descending" }],
      });
      return result && typeof result === "object" && "rows" in result && Array.isArray(result.rows) ? result.rows : [];
    };
    const [summaryRows, queries, pages] = await Promise.all([
      request(auth, `${API}/${encodeURIComponent(site)}/searchAnalytics/query`, "POST", {
        ...dateRange,
      }).then((result) =>
        result && typeof result === "object" && "rows" in result && Array.isArray(result.rows) ? result.rows : [],
      ),
      query("query", "clicks"),
      query("page", "clicks"),
    ]);
    const opportunityRows = await request(auth, `${API}/${encodeURIComponent(site)}/searchAnalytics/query`, "POST", {
      ...dateRange,
      dimensions: ["page"],
      rowLimit: 1000,
      orderBy: [{ field: "impressions", direction: "descending" }],
    });
    const rows =
      opportunityRows &&
      typeof opportunityRows === "object" &&
      "rows" in opportunityRows &&
      Array.isArray(opportunityRows.rows)
        ? opportunityRows.rows
        : [];
    const opportunities = rows
      .filter(
        (row) =>
          row &&
          typeof row === "object" &&
          "ctr" in row &&
          typeof row.ctr === "number" &&
          row.ctr < 0.02 &&
          "impressions" in row &&
          typeof row.impressions === "number" &&
          row.impressions > 100,
      )
      .slice(0, 10);
    const formatRows = (items: unknown[]) =>
      items.map((item) =>
        item && typeof item === "object"
          ? {
              ...item,
              ...("ctr" in item && typeof item.ctr === "number" ? { ctr: `${(item.ctr * 100).toFixed(1)}%` } : {}),
              ...("position" in item && typeof item.position === "number"
                ? { position: Number(item.position.toFixed(1)) }
                : {}),
            }
          : item,
      );
    return encode({
      tool: "search-console-axi",
      site,
      site_source,
      sites: verifiedSiteCount,
      period: `last ${days} complete days`,
      totals: formatRows([summaryRows[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 }])[0],
      top_queries: formatRows(queries),
      top_pages: formatRows(pages),
      low_ctr_opportunities: formatRows(opportunities),
      help: [
        "Run search-console-axi setup check to verify access.",
        "Run search-console-axi inspect <url> --site <site> to check indexing.",
      ],
    });
  } catch (error) {
    if (error instanceof AxiError && error.code === "VALIDATION_ERROR") throw error;
    if (!(error instanceof Error && error.message === ACCESS_DENIED)) process.exitCode = 1;
    return encode({
      tool: "search-console-axi",
      status: "error",
      ...(error instanceof Error && (error.message.startsWith("Enable ") || error.message === ACCESS_DENIED)
        ? { error: error.message }
        : {}),
      help: ["Run search-console-axi setup check for access guidance."],
    });
  }
}

export async function inspectUrl(auth: AuthProvider, url: string, siteUrl: string): Promise<string> {
  const data = await request(auth, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", "POST", {
    inspectionUrl: url,
    siteUrl,
    languageCode: "en-US",
  });
  return encode(data && typeof data === "object" && "inspectionResult" in data ? data.inspectionResult : data);
}
