import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { AxiError } from "axi-sdk-js";

// Official per-property URL Inspection limits: 2,000/day, 600/minute.
// https://developers.google.com/webmaster-tools/limits#url_inspection
export const DAILY_LIMIT = 2000;
export const INTERVAL_MS = 110; // Below 600/minute, including across resumed runs.
const DAY = 86_400_000;
const fields = ["coverageState", "verdict", "googleCanonical", "userCanonical", "lastCrawlTime"] as const;
export type Row = { url: string; inspectedAt: string } & Record<(typeof fields)[number], string>;
type State = { version: 1; site: string; rows: Row[] };
type Ledger = { attempts: number[]; blockedUntil: number };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}

// Fields documented at https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult
export function inspectionRow(url: string, value: unknown, now: number): Row {
  const result = record(value);
  const status = record(result.indexStatusResult ?? {});
  const text = (key: (typeof fields)[number]) => {
    const value = status[key];
    if (value !== undefined && typeof value !== "string") throw new Error("Invalid inspection field");
    return value ?? "";
  };
  return {
    url,
    inspectedAt: new Date(now).toISOString(),
    coverageState: text("coverageState"),
    verdict: text("verdict"),
    googleCanonical: text("googleCanonical"),
    userCanonical: text("userCanonical"),
    lastCrawlTime: text("lastCrawlTime"),
  };
}

async function load<T>(path: string, empty: T, parse: (value: unknown) => T): Promise<T> {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return empty;
    throw new AxiError(
      "Cannot read coverage state or quota ledger; restore a valid file before retrying.",
      "STATE_ERROR",
    );
  }
}
async function save(path: string, data: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
async function lock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Never guess whether a concurrent writer is alive. A crash leaves a removable lock, not corrupt state.
  try {
    await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    throw new AxiError(
      `Coverage state is locked or unwritable: ${path}. If no coverage process is running, remove the stale lock and retry.`,
      "STATE_ERROR",
    );
  }
  return () => unlink(path);
}

export function coveragePaths(site: string, state?: string) {
  const xdg = process.env.XDG_STATE_HOME;
  const root = join(
    xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"),
    "search-console-axi",
    "coverage",
  );
  const id = createHash("sha256").update(site).digest("hex");
  return { state: resolve(state ?? join(root, `${id}.json`)), ledger: join(root, `${id}.quota.json`) };
}

function parseState(value: unknown, site: string): State {
  const state = record(value);
  if (state.version !== 1 || state.site !== site || !Array.isArray(state.rows)) throw new Error("State mismatch");
  const rows = state.rows.map((item: unknown) => {
    const row = record(item);
    if (
      typeof row.url !== "string" ||
      typeof row.inspectedAt !== "string" ||
      !fields.every((key) => typeof row[key] === "string")
    )
      throw new Error("Invalid row");
    return {
      url: row.url,
      inspectedAt: row.inspectedAt,
      ...Object.fromEntries(fields.map((key) => [key, row[key]])),
    } as Row;
  });
  return { version: 1, site, rows };
}
function parseLedger(value: unknown): Ledger {
  const ledger = record(value);
  if (
    !Array.isArray(ledger.attempts) ||
    !ledger.attempts.every((time: unknown) => typeof time === "number" && Number.isFinite(time) && time >= 0) ||
    typeof ledger.blockedUntil !== "number" ||
    !Number.isFinite(ledger.blockedUntil)
  )
    throw new Error("Invalid ledger");
  return { attempts: ledger.attempts, blockedUntil: ledger.blockedUntil };
}

export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("response" in error)) return false;
  if (!error.response || typeof error.response !== "object") return false;
  const response = record(error.response);
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return /quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|QUOTA_EXCEEDED/.test(
    JSON.stringify(response.data),
  );
}

export async function collectCoverage(options: {
  site: string;
  urls: string[];
  state?: string;
  refresh?: boolean;
  inspect: (url: string) => Promise<unknown>;
  now?: () => number;
  monotonicNow?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}) {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep = options.sleep ?? setTimeout;
  const paths = coveragePaths(options.site, options.state);
  if (paths.state === paths.ledger || paths.state === `${paths.ledger}.lock`)
    throw new AxiError("State path conflicts with quota ledger.", "VALIDATION_ERROR");
  const unlockLedger = await lock(`${paths.ledger}.lock`);
  let unlockState: (() => Promise<void>) | undefined;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    unlockState = await lock(`${paths.state}.lock`);
    const state = await load(paths.state, { version: 1, site: options.site, rows: [] } satisfies State, (value) =>
      parseState(value, options.site),
    );
    const ledger = await load(paths.ledger, { attempts: [], blockedUntil: 0 }, parseLedger);
    ledger.attempts = ledger.attempts.map((time) => Math.min(time, now()));
    const rows = new Map(state.rows.map((row) => [row.url, row]));
    const urls = [...new Set(options.urls)];
    const pending = urls.filter((url) => options.refresh || !rows.has(url));
    let inspected = 0;
    let lastRequestAt: number | undefined;
    let stop = "complete";
    for (const url of pending) {
      if (interrupted) {
        stop = "interrupted";
        break;
      }
      ledger.attempts = ledger.attempts.filter((time) => time > now() - DAY);
      if (ledger.blockedUntil > now()) {
        stop = "api_quota";
        break;
      }
      if (ledger.attempts.length >= DAILY_LIMIT) {
        stop = "daily_limit";
        break;
      }
      const latest = Math.max(0, ...ledger.attempts);
      const delay =
        lastRequestAt === undefined
          ? Math.max(0, latest + INTERVAL_MS - now())
          : Math.max(0, INTERVAL_MS - (monotonicNow() - lastRequestAt));
      const waitingSince = monotonicNow();
      while (monotonicNow() - waitingSince < delay) await sleep(delay - (monotonicNow() - waitingSince));
      lastRequestAt = monotonicNow();
      // Reserve quota before sending: interruptions and failed calls must not refund an attempt.
      ledger.attempts.push(now());
      await save(paths.ledger, ledger);
      let result: unknown;
      try {
        result = await options.inspect(url);
      } catch (error) {
        if (isQuotaError(error)) {
          ledger.blockedUntil = now() + DAY;
          await save(paths.ledger, ledger);
          stop = "api_quota";
          break;
        }
        throw new AxiError(
          "URL Inspection failed; progress was saved. Check access and network, then rerun the same command.",
          "API_ERROR",
        );
      }
      const row = inspectionRow(url, result, now());
      rows.set(url, row);
      state.rows = [...rows.values()];
      // ponytail: rewrite the JSON snapshot per URL; use SQLite if retained results outgrow memory or write throughput.
      await save(paths.state, state);
      inspected++;
      if (interrupted) {
        stop = "interrupted";
        break;
      }
    }
    ledger.attempts = ledger.attempts.filter((time) => time > now() - DAY);
    const resumeAt = Math.max(
      ledger.blockedUntil,
      ledger.attempts.length >= DAILY_LIMIT ? Math.min(...ledger.attempts) + DAY : 0,
    );
    return {
      site: options.site,
      state: paths.state,
      total: urls.length,
      inspected,
      remaining: pending.length - inspected,
      stop,
      quota: {
        per_day: DAILY_LIMIT,
        per_minute: 600,
        local_attempts_24h: ledger.attempts.length,
        local_remaining: Math.max(0, DAILY_LIMIT - ledger.attempts.length),
        resume_after: resumeAt > now() ? new Date(resumeAt).toISOString() : "",
        scope:
          "Local coverage attempts only; external usage is unknown. Conservative rolling 24h budget; API quota errors pause 24h.",
      },
      rows: urls.flatMap((url) => (rows.has(url) ? [rows.get(url)!] : [])),
    };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    try {
      await unlockState?.();
    } finally {
      await unlockLedger();
    }
  }
}

export function groupCoverage(rows: Row[], now = Date.now()) {
  const groups = new Map<
    string,
    {
      coverage_state: string;
      verdict: string;
      canonical: string;
      canonical_match: string;
      last_crawl: string;
      count: number;
      urls: string[];
    }
  >();
  for (const row of rows) {
    const age = now - Date.parse(row.lastCrawlTime);
    const values = {
      coverage_state: row.coverageState || "unknown",
      verdict: row.verdict || "unknown",
      canonical: row.googleCanonical || "unknown",
      canonical_match:
        !row.googleCanonical || !row.userCanonical
          ? "unknown"
          : row.googleCanonical === row.userCanonical
            ? "same"
            : "different",
      last_crawl:
        !Number.isFinite(age) || age < 0
          ? "unknown"
          : age < 7 * DAY
            ? "under_7d"
            : age < 30 * DAY
              ? "7_to_29d"
              : "30d_or_older",
    };
    const key = JSON.stringify(values);
    const group = groups.get(key) ?? { ...values, count: 0, urls: [] };
    group.count++;
    group.urls.push(row.url);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function coverageCsv(rows: Row[]): string {
  const columns = ["url", ...fields, "inspectedAt"] as const;
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  return [columns.join(","), ...rows.map((row) => columns.map((key) => quote(row[key])).join(","))].join("\r\n");
}
