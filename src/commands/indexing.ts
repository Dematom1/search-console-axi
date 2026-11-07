import { AxiError } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getAuthClient, type AuthProvider } from "../auth.js";
import { helpText } from "../help.js";
import { parseArgs } from "../args.js";

const base = "https://indexing.googleapis.com";
export const indexingScopes = ["https://www.googleapis.com/auth/indexing"];
const usageHelp = `Indexing API: JobPosting or BroadcastEvent embedded in VideoObject pages only.
Service accounts must be Search Console property owners. Notifications do not guarantee indexing.
Usage:
  search-console-axi indexing publish <url> --type updated|deleted [--confirm]
  search-console-axi indexing status <url>
  search-console-axi indexing batch <file|-> --type updated|deleted [--confirm]
  search-console-axi indexing quota
Batch input: one HTTP(S) URL per line; '-' reads stdin. Preview lists every URL and request count.
Writes preview without credentials; --confirm submits. Each URL is the explicit writable target.
Deleted pages must first return 404/410 or contain noindex. No automatic retries.
Quota uses the configured quota project (sent with requests), then the credential project_id.
Examples:
  search-console-axi indexing publish https://example.com/jobs/1 --type updated
  search-console-axi indexing batch urls.txt --type deleted --confirm
  search-console-axi indexing status https://example.com/jobs/1`;
const invalid = (message: string): never => {
  throw new AxiError(message, "VALIDATION_ERROR", [usageHelp]);
};
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
function statusCode(error: unknown): number {
  const response = object(object(error).response);
  return typeof response.status === "number" ? response.status : 0;
}
function reasons(error: unknown): unknown[] {
  const body = object(object(object(error).response).data);
  const info = object(body.error);
  return [...(Array.isArray(info.details) ? info.details : []), ...(Array.isArray(info.errors) ? info.errors : [])].map(
    (item) => object(item).reason,
  );
}
function failure(status: number): string {
  if (status === 403)
    return "Access denied: verify the service account is an owner of the Search Console property, the Indexing API is enabled, and credentials grant the indexing scope";
  if (status === 429) return "Indexing API quota exceeded; wait for quota reset or request a quota increase";
  if (status === 401) return "Authentication failed; check configured credentials and indexing scope";
  if (status === 404) return "No notification metadata found for this URL";
  return status
    ? `Indexing API request failed (HTTP ${status})`
    : "Indexing API authentication or network request failed";
}
async function request(auth: AuthProvider, options: Parameters<AuthProvider["client"]["request"]>[0]) {
  try {
    return await auth.client.request<unknown>({ ...options, retry: false });
  } catch (error) {
    const why = reasons(error);
    const message =
      why.includes("SERVICE_DISABLED") || why.includes("accessNotConfigured")
        ? "Enable the Google Indexing API in the request's consumer project"
        : why.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
          ? "Credentials lack the https://www.googleapis.com/auth/indexing OAuth scope; reauthorize user ADC or check the service-account configuration"
          : failure(statusCode(error));
    throw new AxiError(message, "INDEXING_ERROR", [
      "Check `search-console-axi indexing --help`; do not blindly retry a submission with an unknown outcome",
    ]);
  }
}
function urlInput(value: string): string {
  try {
    const url = new URL(value);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1_000_000 - 1024)
      return invalid("URL exceeds the batch part size limit of 1 MB");
    if (
      !/^https?:\/\//i.test(value) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      /[\\#\s]/.test(value) ||
      [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return invalid("URLs must be absolute HTTP(S) URLs without credentials, fragments, or whitespace");
    return value;
  } catch (error) {
    if (error instanceof AxiError) throw error;
    return invalid("Expected an absolute HTTP(S) URL without credentials");
  }
}
function metadata(value: unknown) {
  const data = object(value);
  const notification = (value: unknown) => {
    const item = object(value);
    return {
      ...(item.type === "URL_UPDATED" || item.type === "URL_DELETED" ? { type: item.type } : {}),
      ...(typeof item.notifyTime === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(item.notifyTime)
        ? { notify_time: item.notifyTime }
        : {}),
    };
  };
  return { latest_update: notification(data.latestUpdate), latest_remove: notification(data.latestRemove) };
}

export function parseBatch(body: string, contentType: string, urls: string[]) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const delimiter = boundary?.[1] ?? boundary?.[2];
  const parts = delimiter ? body.split(`--${delimiter}`).slice(1, -1) : [];
  const byId = new Map<number, { status: number; metadata: ReturnType<typeof metadata> }>();
  const duplicates = new Set<number>();
  for (const part of parts) {
    const id = /Content-ID:\s*<(?:response-)?item-(\d+)>/i.exec(part)?.[1];
    const http = /HTTP\/1\.[01]\s+(\d{3})[^\r\n]*\r?\n/.exec(part);
    if (id === undefined || !http) continue;
    const index = Number(id);
    const status = Number(http[1]);
    if (byId.has(index)) duplicates.add(index);
    const payload = part
      .slice((http.index ?? 0) + http[0].length)
      .split(/\r?\n\r?\n/)
      .slice(1)
      .join("\n\n")
      .trim();
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      data = undefined;
    }
    byId.set(index, {
      status: status >= 200 && status < 300 && data === undefined ? 0 : status,
      metadata: metadata(object(data).urlNotificationMetadata ?? data),
    });
  }
  return urls.map((url, index) => {
    const item = byId.get(index);
    if (!item || duplicates.has(index) || !item.status)
      return {
        url,
        status: "unknown",
        http_status: 0,
        error: "Missing or malformed batch result; check status before retrying",
      };
    return item.status >= 200 && item.status < 300
      ? { url, status: "submitted", http_status: item.status, ...item.metadata }
      : { url, status: "failed", http_status: item.status, error: failure(item.status) };
  });
}

export async function indexingCommand(args: string[], suppliedAuth?: AuthProvider): Promise<string> {
  const [action, ...rest] = args;
  if (!["publish", "status", "batch", "quota"].includes(action ?? ""))
    return invalid("Expected indexing publish, status, batch, or quota");
  const writing = action === "publish" || action === "batch";
  const parsed = parseArgs(rest, writing ? ["--type"] : [], writing ? ["--confirm"] : []);
  const positionals = parsed.positionals;
  const typeValue = parsed.flags.get("--type");
  if (writing && typeValue !== undefined && typeValue !== "updated" && typeValue !== "deleted")
    return invalid("--type requires updated or deleted");
  const type = typeValue === "updated" ? "URL_UPDATED" : typeValue === "deleted" ? "URL_DELETED" : undefined;
  const confirm = parsed.flags.has("--confirm");
  if (positionals.length !== (action === "quota" ? 0 : 1) || (writing && !type))
    return invalid("Invalid arguments; writes require one target and --type updated|deleted");
  const target = positionals[0] ?? "";
  let urls: string[] = [];
  if (action === "batch") {
    let text: string;
    try {
      text = readFileSync(target === "-" ? 0 : target, "utf8");
    } catch {
      return invalid("Could not read batch input; check the supplied file path or stdin");
    }
    urls = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(urlInput);
    if (!urls.length) return invalid("Batch input contains no URLs");
  } else if (action !== "quota") urls = [urlInput(target)];
  if (writing && !confirm)
    return encode({
      mode: "preview",
      type,
      request_count: urls.length,
      http_request_count: action === "batch" ? Math.ceil(urls.length / 100) : 1,
      urls,
      help: ["Repeat the same command with --confirm to submit these exact targets"],
    });
  let auth = suppliedAuth;
  if (!auth) {
    try {
      auth = await getAuthClient({
        scopes:
          action === "quota"
            ? [
                "https://www.googleapis.com/auth/cloud-platform.read-only",
                "https://www.googleapis.com/auth/monitoring.read",
              ]
            : indexingScopes,
      });
    } catch (error) {
      if (error instanceof AxiError) throw error;
      throw new AxiError("Could not load configured Google credentials", "AUTH_CONFIG_ERROR", [
        "Check credential paths and variables with search-console-axi setup status",
      ]);
    }
  }
  if (action === "quota") return quota(auth);
  if (action === "status") {
    const response = await request(auth, {
      url: `${base}/v3/urlNotifications/metadata`,
      params: { url: target },
      method: "GET",
    });
    return encode({
      url: target,
      ...metadata(response.data),
      note: "Notification receipt only; not crawl or index status",
    });
  }
  if (action === "publish") {
    const response = await request(auth, {
      url: `${base}/v3/urlNotifications:publish`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: { url: target, type },
    });
    return encode({
      mode: "submitted",
      request_count: 1,
      results: [{ url: target, status: "submitted", ...metadata(object(response.data).urlNotificationMetadata) }],
    });
  }
  const results = [];
  for (let start = 0; start < urls.length; start += 100) {
    const chunk = urls.slice(start, start + 100);
    const boundary = `axi_${randomUUID()}`;
    const data =
      chunk
        .map(
          (url, index) =>
            `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item-${index}>\r\n\r\nPOST /v3/urlNotifications:publish HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ url, type })}\r\n`,
        )
        .join("") + `--${boundary}--\r\n`;
    try {
      const response = await request(auth, {
        url: `${base}/batch`,
        method: "POST",
        headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
        data,
        responseType: "text",
      });
      results.push(
        ...parseBatch(
          typeof response.data === "string" ? response.data : "",
          response.headers.get("content-type") ?? "",
          chunk,
        ),
      );
    } catch (error) {
      // A batch transport failure can occur after acceptance; never retry automatically.
      results.push(
        ...chunk.map((url) => ({
          url,
          status: "unknown",
          http_status: 0,
          error: error instanceof AxiError ? error.message : "Batch outcome unknown; check status before retrying",
        })),
      );
    }
  }
  const failed = results.filter((item) => item.status !== "submitted").length;
  if (failed) process.exitCode = 1;
  return encode({ mode: "submitted", request_count: urls.length, submitted: results.length - failed, failed, results });
}

function pacificMidnight(now: Date): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const midnight = Date.parse(`${date}T00:00:00Z`);
  let instant = midnight;
  for (let i = 0; i < 3; i++) {
    const offset = new Intl.DateTimeFormat("en", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" })
      .formatToParts(new Date(instant))
      .find((part) => part.type === "timeZoneName")?.value;
    const hours = Number(/GMT([+-]\d+)/.exec(offset ?? "")?.[1] ?? 0);
    instant = midnight - hours * 3_600_000;
  }
  return new Date(instant).toISOString();
}
function quotaFailure(error: unknown, service: "Service Usage" | "Cloud Monitoring"): string {
  const why = reasons(error);
  if (why.includes("SERVICE_DISABLED") || why.includes("accessNotConfigured"))
    return `Enable the ${service} API in the selected project; no measurement is available`;
  const scope =
    service === "Service Usage" ? "cloud-platform.read-only or cloud-platform" : "monitoring.read or cloud-platform";
  if (why.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return `Credentials lack a required OAuth scope: ${scope}`;
  const permission = service === "Service Usage" ? "serviceusage.quotas.get" : "monitoring.timeSeries.list";
  return statusCode(error) === 403
    ? `Access denied: requires ${permission} on the selected project and ${scope} OAuth scope`
    : `${service} unavailable; check API enablement and configured credentials`;
}
async function quota(auth: AuthProvider): Promise<string> {
  const documented_defaults = {
    source: "https://developers.google.com/search/apis/indexing-api/v3/quota-pricing",
    publish_per_day: 200,
    metadata_per_minute: 180,
    requests_per_minute: 380,
    note: "Documentation only; not this project's measured limits",
  };
  const projectId = auth.quotaProjectId ?? auth.projectId;
  if (!projectId)
    return encode({
      limits: "unavailable: no quota project or credential project_id",
      usage_today: "unavailable: configure a quota project with search-console-axi setup --quota-project <project>",
      documented_defaults,
    });
  const project = encodeURIComponent(projectId);
  const now = new Date();
  const start = pacificMidnight(now);
  const limits: { metric: string; unit: string; effective_limit: string; dimensions: Record<string, unknown> }[] = [];
  const usage: { method: string; requests: bigint }[] = [];
  let limitsError: string | undefined;
  let usageError: string | undefined;
  try {
    let pageToken: string | undefined;
    do {
      const response = await auth.client.request<unknown>({
        url: `https://serviceusage.googleapis.com/v1beta1/projects/${project}/services/indexing.googleapis.com/consumerQuotaMetrics`,
        params: { view: "FULL", pageSize: 200, ...(pageToken ? { pageToken } : {}) },
        retry: false,
      });
      const data = object(response.data);
      for (const value of Array.isArray(data.metrics) ? data.metrics : []) {
        const metric = object(value);
        for (const value of Array.isArray(metric.consumerQuotaLimits) ? metric.consumerQuotaLimits : []) {
          const limit = object(value);
          for (const value of Array.isArray(limit.quotaBuckets) ? limit.quotaBuckets : []) {
            const bucket = object(value);
            if (
              typeof metric.metric === "string" &&
              typeof limit.unit === "string" &&
              (typeof bucket.effectiveLimit === "string" || typeof bucket.effectiveLimit === "number")
            )
              limits.push({
                metric: metric.metric,
                unit: limit.unit,
                effective_limit: String(bucket.effectiveLimit),
                dimensions: object(bucket.dimensions),
              });
          }
        }
      }
      pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;
    } while (pageToken);
  } catch (error) {
    limitsError = quotaFailure(error, "Service Usage");
  }
  try {
    let pageToken: string | undefined;
    do {
      const response = await auth.client.request<unknown>({
        url: `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries`,
        params: {
          filter:
            'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api" AND resource.labels.service="indexing.googleapis.com"',
          "interval.startTime": start,
          "interval.endTime": now.toISOString(),
          view: "FULL",
          pageSize: 100000,
          ...(pageToken ? { pageToken } : {}),
        },
        retry: false,
      });
      const data = object(response.data);
      for (const value of Array.isArray(data.timeSeries) ? data.timeSeries : []) {
        const series = object(value);
        const labels = object(object(series.resource).labels);
        if (!Array.isArray(series.points) || !series.points.length) continue;
        let requests = 0n;
        for (const point of series.points) {
          const count = object(object(point).value).int64Value;
          if (typeof count !== "string" || !/^\d+$/.test(count)) throw new Error("Invalid count");
          requests += BigInt(count);
        }
        usage.push({ method: typeof labels.method === "string" ? labels.method : "unspecified", requests });
      }
      pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;
    } while (pageToken);
  } catch (error) {
    usageError = quotaFailure(error, "Cloud Monitoring");
  }
  const counts = new Map<string, bigint>();
  for (const item of usage) counts.set(item.method, (counts.get(item.method) ?? 0n) + item.requests);
  const by_method = [...counts].map(([method, requests]) => ({ method, requests: requests.toString() }));
  return encode({
    project: projectId,
    project_source: auth.quotaProjectId ? "quota_project" : "credential_project",
    limits: limitsError ?? (limits.length ? limits : "No quota limits returned; unknown, not zero"),
    usage_today: {
      start,
      end: now.toISOString(),
      timezone: "America/Los_Angeles",
      source: "Cloud Monitoring serviceruntime.googleapis.com/api/request_count",
      status: usageError ?? (usage.length ? "observed" : "No time series returned; unknown, not zero"),
      ...(usageError || !usage.length
        ? {}
        : {
            total_observed_requests: by_method.reduce((sum, item) => sum + BigInt(item.requests), 0n).toString(),
            by_method,
          }),
      note: "Observed completed API requests, including failures; not authoritative publish quota consumption. Metrics may lag up to 30 minutes",
    },
    documented_defaults,
  });
}

export const name = "indexing";
export const help = helpText(name, {
  purpose:
    "Indexing API: JobPosting or BroadcastEvent embedded in VideoObject pages only. Notifications do not guarantee indexing.",
  flags: {
    "--type <updated|deleted>": "Notification type",
    "--confirm": "Submit previewed targets",
    "--help": "Show this help",
  },
  examples: ["search-console-axi indexing publish https://example.com/jobs/1 --type updated"],
  next: ["search-console-axi indexing quota"],
});
export const run = (args: string[]) => indexingCommand(args);
export const command = {
  name,
  help,
  subcommands: {
    publish: helpText("indexing publish", {
      purpose: "Preview or submit one URL notification.",
      flags: {
        "<url>": "Required HTTP(S) URL",
        "--type <updated|deleted>": "Required notification type",
        "--confirm": "Submit the previewed target",
        "--help": "Show this help",
      },
      examples: ["search-console-axi indexing publish https://example.com/ --type updated"],
      next: ["search-console-axi indexing status <url>"],
    }),
    status: helpText("indexing status", {
      purpose: "Read notification metadata for a URL.",
      flags: { "<url>": "Required HTTP(S) URL", "--help": "Show this help" },
      examples: ["search-console-axi indexing status https://example.com/"],
      next: ["search-console-axi indexing publish <url> --type updated"],
    }),
    batch: helpText("indexing batch", {
      purpose: "Preview or submit URL notifications from a file or stdin.",
      flags: {
        "<file|->": "Required input; '-' reads stdin",
        "--type <updated|deleted>": "Required notification type",
        "--confirm": "Submit the previewed targets",
        "--help": "Show this help",
      },
      examples: ["search-console-axi indexing batch urls.txt --type deleted"],
      next: ["search-console-axi indexing status <url>"],
    }),
    quota: helpText("indexing quota", {
      purpose: "Read Indexing API quota usage.",
      flags: { "--help": "Show this help" },
      examples: ["search-console-axi indexing quota"],
      next: ["search-console-axi indexing status <url>"],
    }),
  },
  run,
};
