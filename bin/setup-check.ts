import { encode } from "@toon-format/toon";
import type { AuthProvider } from "./auth.js";

const API = "https://searchconsole.googleapis.com/webmasters/v3/sites";
export const setupGuide = [
  { step: 1, instruction: "Enable the Google Search Console API in a Google Cloud project." },
  { step: 2, instruction: "Create a service account; it needs no project-level IAM roles." },
  {
    step: 3,
    instruction: "Load its JSON key from your secret manager into SEARCH_CONSOLE_AXI_SA_KEY. Never commit the key.",
  },
  {
    step: 4,
    instruction:
      "In Search Console, add the service-account email under Settings > Users and permissions with Restricted access.",
  },
  {
    step: 5,
    instruction:
      "For personal access, use your own Desktop OAuth client. Search Console reporting uses https://www.googleapis.com/auth/webmasters.readonly; Indexing API commands use https://www.googleapis.com/auth/indexing, and quota reads use https://www.googleapis.com/auth/cloud-platform. Include the needed scopes with gcloud auth application-default login --client-id-file=client.json --scopes=... .",
  },
];

type Site = { siteUrl: string; permissionLevel?: string };

function apiDisabledMessage(error: unknown): string | undefined {
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

async function request(auth: AuthProvider, url: string, method = "GET", data?: object): Promise<unknown> {
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

function searchDateRange(): { startDate: string; endDate: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const today = Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day));
  const format = (offset: number) => new Date(today + offset * 86_400_000).toISOString().slice(0, 10);
  return { startDate: format(-7), endDate: format(-1) };
}

async function sites(auth: AuthProvider): Promise<Site[]> {
  const data = await request(auth, API);
  if (!data || typeof data !== "object" || !("siteEntry" in data) || !Array.isArray(data.siteEntry)) return [];
  return data.siteEntry.flatMap((site) =>
    site && typeof site === "object" && "siteUrl" in site && typeof site.siteUrl === "string"
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
    const reportable = accessible.filter((site) => site.permissionLevel !== "siteUnverifiedUser");
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

export async function runHome(auth: AuthProvider): Promise<string> {
  try {
    const accessible = await sites(auth);
    if (!accessible.length)
      return encode({
        tool: "search-console-axi",
        sites: "No Search Console sites visible to this account - grant access as in step 4, or none exist.",
        help: ["Run search-console-axi setup for access instructions."],
      });
    const reportable = accessible.filter((entry) => entry.permissionLevel !== "siteUnverifiedUser");
    const site = reportable[0]?.siteUrl;
    if (!site)
      return encode({
        tool: "search-console-axi",
        sites: "No verified Search Console sites visible to this account - grant access as in step 4, or none exist.",
        help: ["Run search-console-axi setup for access instructions."],
      });
    const dateRange = searchDateRange();
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
      sites: reportable.length,
      period: "last 7 complete days",
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
