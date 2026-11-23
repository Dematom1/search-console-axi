import { appendFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import type { Row } from "./coverage.js";

type Refresh = { id: string; urls: string[]; done: string[] };
type Snapshot = { version: 1; site: string; rows: Row[]; refresh?: Refresh };
type Event = { kind: "row"; row: Row; refresh: string | null } | { kind: "refresh"; id: string; urls: string[] };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function parseRow(value: unknown): Row {
  const row = object(value);
  if (
    !["url", "inspectedAt", "coverageState", "verdict", "googleCanonical", "userCanonical", "lastCrawlTime"].every(
      (key) => typeof row[key] === "string",
    )
  )
    throw new Error("Invalid row");
  return row as Row;
}
function parseRefresh(value: unknown): Refresh {
  const refresh = object(value);
  if (typeof refresh.id !== "string" || !strings(refresh.urls) || !strings(refresh.done))
    throw new Error("Invalid refresh");
  return { id: refresh.id, urls: refresh.urls, done: refresh.done };
}
function parseSnapshot(value: unknown, site: string): Snapshot {
  const state = object(value);
  if (state.version !== 1 || state.site !== site || !Array.isArray(state.rows)) throw new Error("State mismatch");
  return {
    version: 1,
    site,
    rows: state.rows.map(parseRow),
    ...(state.refresh === undefined ? {} : { refresh: parseRefresh(state.refresh) }),
  };
}
function parseEvent(value: unknown): Event {
  const event = object(value);
  if (event.kind === "row" && (event.refresh === null || typeof event.refresh === "string"))
    return { kind: "row", row: parseRow(event.row), refresh: event.refresh };
  if (event.kind === "refresh" && typeof event.id === "string" && strings(event.urls))
    return { kind: "refresh", id: event.id, urls: event.urls };
  throw new Error("Invalid journal event");
}
export async function readJson<T>(path: string, empty: T, parse: (value: unknown) => T): Promise<T> {
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
async function replace(path: string, data: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function saveJson(path: string, value: unknown) {
  await replace(path, JSON.stringify(value));
}

// Each successful row is a durable journal record. Compaction publishes the snapshot
// before removing the journal; replaying both after a crash is idempotent.
export async function openCoverageState(path: string, site: string) {
  const loaded = await readJson<Snapshot | undefined>(path, undefined, (value) => parseSnapshot(value, site));
  const snapshot: Snapshot = loaded ?? { version: 1, site, rows: [] };
  if (!loaded) await saveJson(path, snapshot);
  const rows = new Map(snapshot.rows.map((row) => [row.url, row]));
  let refresh = snapshot.refresh;
  let done = new Set(refresh?.done);
  const journal = `${path}.jsonl`;
  const apply = (event: Event) => {
    if (event.kind === "refresh") {
      refresh = { id: event.id, urls: event.urls, done: [] };
      done = new Set();
    } else {
      rows.set(event.row.url, event.row);
      if (refresh?.id === event.refresh) done.add(event.row.url);
    }
  };
  try {
    const text = await readFile(journal, "utf8");
    const committed = text.slice(0, text.lastIndexOf("\n") + 1);
    for (const line of committed.split("\n").filter(Boolean)) apply(parseEvent(JSON.parse(line)));
    // A killed append can leave an uncommitted partial final record. Remove only that tail.
    if (committed.length !== text.length) await replace(journal, committed);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw new AxiError("Cannot read coverage journal; restore a valid file before retrying.", "STATE_ERROR");
  }
  const append = async (event: Event) => {
    await appendFile(journal, JSON.stringify(event) + "\n", { mode: 0o600 });
    apply(event);
  };
  const finishRefresh = () => {
    if (refresh?.urls.every((url) => done.has(url))) {
      refresh = undefined;
      done.clear();
    }
  };
  finishRefresh();
  return {
    rows,
    async pending(urls: string[], requestedRefresh: boolean) {
      if (requestedRefresh && !refresh) await append({ kind: "refresh", id: randomUUID(), urls });
      const targets = new Set(refresh?.urls);
      return urls.filter((url) => !rows.has(url) || (targets.has(url) && !done.has(url)));
    },
    async record(row: Row) {
      await append({ kind: "row", row, refresh: refresh?.id ?? null });
    },
    async compact() {
      finishRefresh();
      await saveJson(path, {
        version: 1,
        site,
        rows: [...rows.values()],
        ...(refresh ? { refresh: { ...refresh, done: [...done] } } : {}),
      } satisfies Snapshot);
      await unlink(journal).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
