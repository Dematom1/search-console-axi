import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";
import { collectCoverage, coveragePaths, groupCoverage, coverageCsv } from "../dist/src/coverage.js";
import { readUrls } from "../dist/src/coverage-input.js";

// Fields and omission semantics: UrlInspectionResult.IndexStatusInspectionResult,
// https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult
const indexed = {
  indexStatusResult: {
    verdict: "PASS",
    coverageState: "Submitted and indexed",
    googleCanonical: "https://example.com/canonical",
    userCanonical: "https://example.com/canonical",
    lastCrawlTime: "2026-01-01T00:00:00Z",
  },
};
const excluded = {
  indexStatusResult: {
    verdict: "NEUTRAL",
    coverageState: "Crawled - currently not indexed",
    lastCrawlTime: "2025-11-01T00:00:00Z",
  },
};

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "sc-coverage-"));
  const original = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  t.after(async () => {
    if (original === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = original;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("coverage paces under 600/minute, saves results, resumes without repeats and refresh still consumes quota", async (t) => {
  const dir = await sandbox(t);
  let clock = Date.parse("2026-01-02T00:00:00Z");
  const starts = [];
  const waits = [];
  const options = {
    site: "sc-domain:example.com",
    urls: ["https://example.com/a", "https://example.com/b", "https://example.com/a"],
    state: join(dir, "progress.json"),
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    inspect: async () => {
      starts.push(clock);
      return indexed;
    },
  };
  const first = await collectCoverage(options);
  assert.equal(first.total, 2);
  assert.equal(first.inspected, 2);
  assert.equal(first.remaining, 0);
  assert.equal(first.quota.local_attempts_24h, 2);
  assert.ok(starts[1] - starts[0] >= 100);
  assert.equal(waits.length, 2);
  assert.equal((await collectCoverage(options)).inspected, 0);
  assert.equal(starts.length, 2);
  assert.equal(JSON.parse(await readFile(options.state, "utf8")).rows.length, 2);
  // A different progress file cannot reset this property's quota or last-request pacing.
  const refreshed = await collectCoverage({ ...options, state: join(dir, "other.json"), urls: [options.urls[0]] });
  assert.equal(refreshed.quota.local_attempts_24h, 3);
  assert.ok(starts[2] - starts[1] >= 100);
  assert.equal((await collectCoverage({ ...options, refresh: true })).inspected, 2);
});

test("documented 2000/day local ceiling stops cleanly and continues across days", async (t) => {
  const dir = await sandbox(t);
  let clock = Date.parse("2026-01-02T00:00:00Z");
  const paths = coveragePaths("sc-domain:example.com", join(dir, "progress.json"));
  await mkdir(dirname(paths.ledger), { recursive: true });
  await writeFile(paths.ledger, JSON.stringify({ attempts: Array(2000).fill(clock - 1000), blockedUntil: 0 }));
  let calls = 0;
  const options = {
    site: "sc-domain:example.com",
    urls: ["https://example.com/a"],
    state: paths.state,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    inspect: async () => {
      calls++;
      return indexed;
    },
  };
  const stopped = await collectCoverage(options);
  assert.equal(stopped.stop, "daily_limit");
  assert.equal(stopped.remaining, 1);
  assert.equal(stopped.quota.local_remaining, 0);
  assert.equal(calls, 0);
  clock += 86_400_001;
  const resumed = await collectCoverage(options);
  assert.equal(resumed.inspected, 1);
  assert.equal(resumed.remaining, 0);
  assert.equal(calls, 1);
});

test("quota responses preserve finished URLs and reserve failed attempts; no automatic retries", async (t) => {
  const dir = await sandbox(t);
  let clock = Date.parse("2026-01-02T00:00:00Z");
  let calls = 0;
  const options = {
    site: "sc-domain:example.com",
    urls: ["https://example.com/a", "https://example.com/b", "https://example.com/c"],
    state: join(dir, "progress.json"),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    inspect: async () => {
      if (++calls === 2) throw { response: { status: 429 } };
      return indexed;
    },
  };
  const stopped = await collectCoverage(options);
  assert.equal(stopped.inspected, 1);
  assert.equal(stopped.remaining, 2);
  assert.equal(stopped.stop, "api_quota");
  assert.equal(stopped.quota.local_attempts_24h, 2);
  assert.equal((await collectCoverage(options)).inspected, 0);
  assert.equal(calls, 2);
  clock += 86_400_001;
  assert.equal((await collectCoverage(options)).inspected, 2);
  assert.equal(calls, 4);
  const denied = await collectCoverage({
    ...options,
    refresh: true,
    inspect: async () => {
      throw { response: { status: 403, data: { error: { errors: [{ reason: "quotaExceeded" }] } } } };
    },
  });
  assert.equal(denied.stop, "api_quota");
});

test("non-quota failure and invalid state cannot lose completed results or reset accounting", async (t) => {
  const dir = await sandbox(t);
  let calls = 0;
  const state = join(dir, "progress.json");
  const options = {
    site: "sc-domain:example.com",
    urls: ["https://example.com/a", "https://example.com/b"],
    state,
    inspect: async () => {
      if (++calls === 2) throw new Error("transport");
      return indexed;
    },
  };
  await assert.rejects(collectCoverage(options), /progress was saved/);
  assert.equal(JSON.parse(await readFile(state, "utf8")).rows.length, 1);
  assert.equal((await collectCoverage(options)).inspected, 1);
  await writeFile(state, "broken");
  await assert.rejects(collectCoverage(options), /Cannot read coverage state/);
  assert.equal(await readFile(state, "utf8"), "broken");
});

test("signal during the only inspection reports interruption after saving it", async (t) => {
  const dir = await sandbox(t);
  const options = {
    site: "sc-domain:example.com",
    urls: ["https://example.com/a"],
    state: join(dir, "progress.json"),
    inspect: async () => {
      process.emit("SIGINT");
      return indexed;
    },
  };
  const result = await collectCoverage(options);
  assert.equal(result.stop, "interrupted");
  assert.equal(result.inspected, 1);
  assert.equal(result.remaining, 0);
  assert.equal(JSON.parse(await readFile(options.state, "utf8")).rows.length, 1);
});

test("SIGINT saves the completed URL, releases locks and resumes on rerun", async (t) => {
  const dir = await sandbox(t);
  const options = {
    site: "sc-domain:example.com",
    urls: ["https://example.com/a", "https://example.com/b"],
    state: join(dir, "progress.json"),
    inspect: async () => {
      process.emit("SIGINT");
      return indexed;
    },
  };
  const stopped = await collectCoverage(options);
  assert.equal(stopped.stop, "interrupted");
  assert.equal(stopped.inspected, 1);
  assert.equal(stopped.remaining, 1);
  assert.equal((await collectCoverage({ ...options, inspect: async () => indexed })).inspected, 1);
});

test("group counts, omitted canonicals/crawl times and JSON/CSV rows follow documented fields", async (t) => {
  const dir = await sandbox(t);
  const time = Date.parse("2026-01-02T00:00:00Z");
  let call = 0;
  const result = await collectCoverage({
    site: "sc-domain:example.com",
    urls: [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
      "https://example.com/e",
    ],
    state: join(dir, "progress.json"),
    now: () => time,
    sleep: async () => {},
    inspect: async () =>
      [
        indexed,
        indexed,
        excluded,
        {
          indexStatusResult: {
            ...indexed.indexStatusResult,
            googleCanonical: "https://example.com/other",
            lastCrawlTime: "2025-12-15T00:00:00Z",
          },
        },
        { indexStatusResult: {} },
      ][call++],
  });
  const groups = groupCoverage(result.rows, time);
  assert.deepEqual(
    groups.map(({ count, canonical, last_crawl }) => ({ count, canonical, last_crawl })),
    [
      { count: 2, canonical: "same", last_crawl: "under_7d" },
      { count: 1, canonical: "unknown", last_crawl: "30d_or_older" },
      { count: 1, canonical: "different", last_crawl: "7_to_29d" },
      { count: 1, canonical: "unknown", last_crawl: "unknown" },
    ],
  );
  assert.deepEqual(groups[0].urls, ["https://example.com/a", "https://example.com/b"]);
  assert.equal(JSON.parse(JSON.stringify(result)).rows[2].googleCanonical, "");
  assert.equal(result.rows[2].coverageState, "Crawled - currently not indexed");
  const csv = coverageCsv([{ ...result.rows[0], coverageState: 'has, comma and "quotes"' }]);
  assert.match(csv, /^url,coverageState,verdict,googleCanonical,userCanonical,lastCrawlTime,inspectedAt\r\n/);
  assert.ok(csv.includes('"has, comma and ""quotes"""'));
});

test("sitemap index expands children, XML entities and namespaces, deduplicates and breaks cycles", async (t) => {
  const dir = await sandbox(t);
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    res.setHeader("Content-Type", "application/xml");
    const docs = {
      "/index": `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${base}/a</loc></sitemap><sitemap><loc>${base}/b</loc></sitemap><sitemap><loc>${base}/index</loc></sitemap></sitemapindex>`,
      "/a": "<urlset><url><loc>https://example.com/a?x=1&amp;y=2</loc></url><url><loc>https://example.com/b</loc></url></urlset>",
      "/b": '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc><![CDATA[https://example.com/b]]></sm:loc></sm:url></sm:urlset>',
      "/empty": "<urlset/>",
      "/bad": "<urlset><url></urlset>",
      "/dtd": '<!DOCTYPE x [<!ENTITY foo "bar">]><urlset/>',
      "/oversized": "oversized",
    };
    if (req.url === "/oversized") {
      res.write(Buffer.alloc(52_428_801));
      res.end();
    } else res.end(docs[req.url] ?? "bad");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await readUrls({ sitemap: base + "/index" })).sort(), [
    "https://example.com/a?x=1&y=2",
    "https://example.com/b",
  ]);
  assert.deepEqual(await readUrls({ sitemap: base + "/empty" }), []);
  await assert.rejects(readUrls({ sitemap: base + "/bad" }), /Invalid sitemap XML/);
  await assert.rejects(readUrls({ sitemap: base + "/dtd" }), /Invalid sitemap XML/);
  await assert.rejects(readUrls({ sitemap: base + "/oversized" }), /Cannot fetch sitemap/);
  const file = join(dir, "urls.txt");
  await writeFile(file, "\r\nhttps://example.com/a\r\nhttps://example.com/a\n https://example.com/b \n");
  assert.deepEqual(await readUrls({ file }), ["https://example.com/a", "https://example.com/b"]);
  await writeFile(file, "https://user:secret@example.com/a");
  await assert.rejects(readUrls({ file }), /without credentials/);
});

test("fake Google CLI: shared read-only Inspection endpoint, stdin, resume and JSON/CSV exports", async (t) => {
  const dir = await sandbox(t);
  const cli = fileURLToPath(new URL("../dist/bin/search-console-axi.js", import.meta.url));
  const preload = fileURLToPath(new URL("./harness/preload.mjs", import.meta.url));
  const scenario = join(dir, "scenario.json");
  await writeFile(
    scenario,
    JSON.stringify({
      responses: [
        {
          method: "GET",
          path: "/sites",
          body: { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] },
        },
        { method: "POST", path: "/urlInspection/index:inspect", body: { inspectionResult: indexed } },
      ],
    }),
  );
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const log = join(dir, "requests.jsonl");
  const env = {
    ...process.env,
    SEARCH_CONSOLE_AXI_SA_KEY: JSON.stringify({
      type: "service_account",
      client_email: "fake@example.invalid",
      private_key: privateKey,
    }),
    FAKE_GSC_SCENARIO: scenario,
    FAKE_LOG: log,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    XDG_STATE_HOME: dir,
  };
  const args = ["coverage", "-", "--site", "sc-domain:example.com"];
  const run = (extra) =>
    spawnSync(process.execPath, ["--import", preload, cli, ...args, ...extra], {
      encoding: "utf8",
      env,
      input: "https://example.com/a\nhttps://example.com/a\n",
    });
  const first = run([]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(decode(first.stdout).groups[0].verdict, "PASS");
  const json = run(["--format", "json"]);
  assert.equal(json.status, 0, json.stdout);
  assert.equal(JSON.parse(json.stdout).inspected, 0);
  assert.equal(JSON.parse(json.stdout).rows.length, 1);
  const csv = run(["--format", "csv"]);
  assert.equal(csv.status, 0, csv.stdout);
  assert.match(csv.stdout, /^url,coverageState/);
  assert.equal(decode(csv.stderr).remaining, 0);
  const entries = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const inspections = entries.filter((entry) => entry.url?.includes("/urlInspection/index:inspect"));
  assert.equal(inspections.length, 1);
  assert.deepEqual(JSON.parse(inspections[0].body), {
    inspectionUrl: "https://example.com/a",
    siteUrl: "sc-domain:example.com",
    languageCode: "en-US",
  });
  assert.ok(!entries.some((entry) => entry.url?.includes("indexing.googleapis.com")));
  const invalid = run(["--format", "invalid"]);
  assert.equal(invalid.status, 2);
  await writeFile(
    scenario,
    JSON.stringify({
      responses: [
        {
          method: "GET",
          path: "/sites",
          body: { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] },
        },
        {
          method: "POST",
          path: "/urlInspection/index:inspect",
          status: 429,
          body: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } },
        },
      ],
    }),
  );
  const quota = run(["--refresh", "--format", "json"]);
  assert.equal(quota.status, 0, quota.stdout + quota.stderr);
  assert.equal(JSON.parse(quota.stdout).stop, "api_quota");
  assert.equal(JSON.parse(quota.stdout).remaining, 1);
  const allRequests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(allRequests.filter((entry) => entry.url?.includes("/urlInspection/index:inspect")).length, 2);
});
