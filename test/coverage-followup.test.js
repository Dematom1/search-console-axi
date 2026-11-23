import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectCoverage, coveragePaths } from "../dist/src/coverage.js";
import { readUrls } from "../dist/src/coverage-input.js";

const indexed = { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } };
const site = "sc-domain:example.com";
const urls = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];
async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "sc-followup-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
function patchFs(t, key, replacement) {
  const original = fs[key];
  fs[key] = (...args) => replacement(original, ...args);
  syncBuiltinESMExports();
  t.after(() => {
    fs[key] = original;
    syncBuiltinESMExports();
  });
}
function clock() {
  let wall = Date.parse("2026-01-02T00:00:00Z");
  let mono = 0;
  return {
    now: () => wall,
    monotonicNow: () => mono,
    sleep: async (ms) => {
      wall += ms;
      mono += ms;
    },
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
  };
}

test("out-of-property URLs are skipped before quota, including prefix and domain boundaries", async (t) => {
  const dir = await sandbox(t);
  for (const [property, accepted, rejected] of [
    [
      site,
      ["https://example.com/a", "https://sub.example.com/b"],
      ["https://notexample.com/a", "https://example.com.evil.test/b"],
    ],
    [
      "https://example.com/shop/",
      ["https://example.com/shop/a", "https://example.com/shop/b"],
      ["https://example.com/shopper/a", "http://example.com/shop/a"],
    ],
  ]) {
    const calls = [];
    const result = await collectCoverage({
      site: property,
      urls: [accepted[0], ...rejected, accepted[1]],
      state: join(dir, String(accepted[0].length) + ".json"),
      ...clock(),
      inspect: async (url) => {
        calls.push(url);
        return indexed;
      },
    });
    assert.deepEqual(calls, accepted);
    assert.equal(result.quota.local_attempts_24h, 2);
    assert.equal(result.total, 4);
    assert.equal(result.remaining, 0);
    assert.deepEqual(
      result.skipped,
      rejected.map((url) => ({ url, reason: "out of property" })),
    );
  }
});

test("an active refresh survives daily limits and signals without repeating its finished URLs", async (t) => {
  const dir = await sandbox(t);
  const time = clock();
  const state = join(dir, "refresh.json");
  const calls = [];
  const options = {
    site,
    urls,
    state,
    ...time,
    inspect: async (url) => {
      calls.push(url);
      return indexed;
    },
  };
  await collectCoverage(options);
  const paths = coveragePaths(site, state);
  await writeFile(paths.ledger, JSON.stringify({ attempts: Array(1999).fill(time.now()), blockedUntil: 0 }));
  calls.length = 0;
  const partial = await collectCoverage({ ...options, refresh: true });
  assert.equal(partial.stop, "daily_limit");
  assert.deepEqual(calls, [urls[0]]);
  time.advance(86_400_001);
  calls.length = 0;
  assert.equal((await collectCoverage({ ...options, refresh: true })).inspected, 2);
  assert.deepEqual(calls, urls.slice(1));
  calls.length = 0;
  const interrupted = await collectCoverage({
    ...options,
    refresh: true,
    inspect: async (url) => {
      calls.push(url);
      process.emit("SIGINT");
      return indexed;
    },
  });
  assert.equal(interrupted.stop, "interrupted");
  assert.equal(interrupted.remaining, 2);
  calls.length = 0;
  // Omitting --refresh also continues the active pass rather than trusting old cached rows.
  assert.equal((await collectCoverage(options)).inspected, 2);
  assert.deepEqual(calls, urls.slice(1));
  calls.length = 0;
  assert.equal((await collectCoverage({ ...options, refresh: true })).inspected, 3);
  assert.deepEqual(calls, urls);
});

test("inspection dispatches stay 110ms apart despite a slow first quota write", async (t) => {
  const dir = await sandbox(t);
  const time = clock();
  let writes = 0;
  patchFs(t, "rename", async (original, from, to) => {
    await original(from, to);
    if (String(to).endsWith(".quota.json")) time.advance(++writes === 1 ? 150 : 1);
  });
  const starts = [];
  await collectCoverage({
    site,
    urls: urls.slice(0, 2),
    state: join(dir, "pacing.json"),
    ...time,
    inspect: async () => {
      starts.push(time.monotonicNow());
      return indexed;
    },
  });
  assert.equal(starts.length, 2);
  assert.ok(starts[0] >= 110);
  assert.ok(starts[1] - starts[0] >= 110, String(starts));
});

test("interruption during pacing never dispatches or reserves a new inspection", async (t) => {
  const dir = await sandbox(t);
  const time = clock();
  let calls = 0;
  const result = await collectCoverage({
    site,
    urls,
    state: join(dir, "wait.json"),
    ...time,
    sleep: async (ms) => {
      await time.sleep(ms);
      process.emit("SIGINT");
    },
    inspect: async () => {
      calls++;
      return indexed;
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.stop, "interrupted");
  assert.equal(result.remaining, 3);
  assert.equal(result.quota.local_attempts_24h, 0);
});

test("interruption during reservation keeps the charge but never dispatches", async (t) => {
  const dir = await sandbox(t);
  const time = clock();
  let reserved = false;
  patchFs(t, "rename", async (original, from, to) => {
    await original(from, to);
    if (String(to).endsWith(".quota.json") && !reserved) {
      reserved = true;
      process.emit("SIGTERM");
    }
  });
  let calls = 0;
  const options = {
    site,
    urls: [urls[0]],
    state: join(dir, "reserve.json"),
    ...time,
    inspect: async () => {
      calls++;
      return indexed;
    },
  };
  const stopped = await collectCoverage(options);
  assert.equal(stopped.stop, "interrupted");
  assert.equal(stopped.quota.local_attempts_24h, 1);
  assert.equal(stopped.remaining, 1);
  assert.equal(calls, 0);
  assert.equal((await collectCoverage(options)).quota.local_attempts_24h, 2);
  assert.equal(calls, 1);
});

test("signal handlers protect both lock removals and are removed even when unlock fails", async (t) => {
  const dir = await sandbox(t);
  const time = clock();
  const before = process.listenerCount("SIGINT");
  const locks = [];
  patchFs(t, "unlink", async (original, path) => {
    if (String(path).endsWith(".lock")) {
      assert.equal(process.listenerCount("SIGINT"), before + 1);
      process.emit("SIGINT");
      locks.push(path);
      await original(path);
      if (locks.length === 1) throw new Error("injected unlock failure after unlink");
      return;
    }
    return original(path);
  });
  await assert.rejects(
    collectCoverage({ site, urls: [urls[0]], state: join(dir, "locks.json"), ...time, inspect: async () => indexed }),
    /unlock failure/,
  );
  assert.equal(locks.length, 2);
  assert.equal(process.listenerCount("SIGINT"), before);
  for (const path of locks) await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("row commits are append-only and recover after failed compaction and an interrupted final append", async (t) => {
  const dir = await sandbox(t);
  const state = join(dir, "journal.json");
  const time = clock();
  const appendRaw = fs.appendFile;
  let snapshotWrites = 0;
  let appended = 0;
  let compactRenames = 0;
  patchFs(t, "writeFile", async (original, path, data, ...args) => {
    if (String(path).startsWith(state + ".") && String(path).endsWith(".tmp")) snapshotWrites++;
    return original(path, data, ...args);
  });
  patchFs(t, "appendFile", async (original, path, data, ...args) => {
    if (path === state + ".jsonl") {
      appended++;
      assert.equal(JSON.parse(data).kind, "row");
    }
    return original(path, data, ...args);
  });
  patchFs(t, "rename", async (original, from, to) => {
    if (to === state && ++compactRenames === 2) throw new Error("injected compaction failure");
    return original(from, to);
  });
  const targets = Array.from({ length: 20 }, (_, n) => `https://example.com/${n}`);
  const options = { site, urls: targets, state, ...time, inspect: async () => indexed };
  await assert.rejects(collectCoverage(options), /compaction failure/);
  assert.equal(snapshotWrites, 2, "one initial binding and one final snapshot, never one per URL");
  assert.equal(appended, 20, "exactly one journal commit per URL");
  assert.equal((await readFile(state + ".jsonl", "utf8")).trim().split("\n").length, 20);
  // An incomplete last JSONL record was never committed and must not corrupt prior rows.
  await appendRaw(state + ".jsonl", '{"kind":', { encoding: "utf8" });
  let repeated = 0;
  const resumed = await collectCoverage({
    ...options,
    inspect: async () => {
      repeated++;
      return indexed;
    },
  });
  assert.equal(repeated, 0);
  assert.equal(resumed.rows.length, 20);
  assert.equal(JSON.parse(await readFile(state, "utf8")).rows.length, 20);
  await assert.rejects(readFile(state + ".jsonl"), { code: "ENOENT" });
});

test("sitemap entry limits recognize valid non-ASCII namespace prefixes", async (t) => {
  const entry = "<é:url><é:loc>https://example.com/a</é:loc></é:url>";
  let entries = 100_000;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(`<urlset xmlns:é="http://www.sitemaps.org/schemas/sitemap/0.9">${entry.repeat(entries)}</urlset>`),
  );
  assert.deepEqual(await readUrls({ sitemap: "https://example.com/sitemap.xml" }), [urls[0]]);
  entries++;
  await assert.rejects(readUrls({ sitemap: "https://example.com/sitemap.xml" }), /100000 total entries/);
});

test("fake Google coverage selects the exact verified prefix and its quota ledger in either site order", async (t) => {
  const dir = await sandbox(t);
  const cli = fileURLToPath(new URL("../dist/bin/search-console-axi.js", import.meta.url));
  const preload = fileURLToPath(new URL("./harness/preload.mjs", import.meta.url));
  const prefix = "https://example.com/shop/";
  const scenario = join(dir, "google.json");
  const log = join(dir, "google.jsonl");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  for (const properties of [
    [site, prefix],
    [prefix, site],
  ]) {
    await writeFile(
      scenario,
      JSON.stringify({
        responses: [
          {
            method: "GET",
            path: "/sites",
            body: { siteEntry: properties.map((siteUrl) => ({ siteUrl, permissionLevel: "siteOwner" })) },
          },
          { method: "POST", path: "/urlInspection/index:inspect", body: { inspectionResult: indexed } },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", preload, cli, "coverage", "-", "--site", prefix, "--format", "json", "--refresh"],
      {
        encoding: "utf8",
        input: "https://example.com/shop/a\nhttps://elsewhere.invalid/a\n",
        env: {
          ...process.env,
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          XDG_STATE_HOME: dir,
          SEARCH_CONSOLE_AXI_SA_KEY: JSON.stringify({
            type: "service_account",
            client_email: "fake@example.invalid",
            private_key: privateKey,
          }),
          FAKE_GSC_SCENARIO: scenario,
          FAKE_LOG: log,
        },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.site, prefix);
    assert.equal(report.inspected, 1);
    assert.deepEqual(report.skipped, [{ url: "https://elsewhere.invalid/a", reason: "out of property" }]);
    assert.equal(report.state, coveragePaths(prefix).state);
  }
  const inspections = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((entry) => entry.url?.includes("/urlInspection/index:inspect"));
  assert.equal(inspections.length, 2);
  for (const request of inspections) assert.equal(JSON.parse(request.body).siteUrl, prefix);
  assert.equal(JSON.parse(await readFile(coveragePaths(prefix).ledger, "utf8")).attempts.length, 2);
  await assert.rejects(readFile(coveragePaths(site).ledger), { code: "ENOENT" });
});
