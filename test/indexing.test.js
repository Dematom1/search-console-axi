import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { parseArgs } from "../dist/src/args.js";
import { assertTokenExchange } from "./harness/assert-token-log.mjs";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = JSON.stringify({ type: "service_account", client_email: "fake@example.invalid", private_key: privateKey });
const keyFor = (projectId) =>
  JSON.stringify({
    type: "service_account",
    client_email: "fake@example.invalid",
    private_key: privateKey,
    project_id: projectId,
  });
const preload = new URL("./harness/preload.mjs", import.meta.url).pathname;
const scenarioPath = new URL("./harness/scenarios/home.json", import.meta.url).pathname;
const bin = new URL("../dist/bin/search-console-axi.js", import.meta.url).pathname;
const multipart = (statuses) => {
  const parts = Array.from({ length: statuses.length }, (_, index) => statuses.length - index - 1)
    .map(
      (index) =>
        [
          "--response",
          "Content-Type: application/http",
          `Content-ID: <response-item-${index}>`,
          "",
          `HTTP/1.1 ${statuses[index]} Result`,
          "Content-Type: application/json",
          "",
          "{}",
        ].join("\r\n") + "\r\n",
    )
    .join("");
  return `${parts}--response--\r\n`;
};
const envFor = (dir, scenario, log, projectId) => ({
  ...process.env,
  SEARCH_CONSOLE_AXI_SA_KEY: projectId ? keyFor(projectId) : key,
  GOOGLE_APPLICATION_CREDENTIALS: "",
  FAKE_GSC_SCENARIO: scenario,
  FAKE_LOG: log,
  XDG_CONFIG_HOME: dir,
  CLOUDSDK_CONFIG: dir,
});

test("indexing arguments support equals values and dash positionals", () => {
  assert.deepEqual(parseArgs(["--type=updated", "-"], ["--type"]), {
    positionals: ["-"],
    flags: new Map([["--type", "updated"]]),
  });
});

test("indexing status sanitizes API errors through fake subprocesses", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-indexing-errors-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [status, expected] of [
    [403, "Access denied"],
    [429, "quota exceeded"],
    [401, "Authentication failed"],
    [404, "No notification metadata found"],
  ]) {
    const scenarioFile = join(dir, `status-${status}.json`);
    const log = join(dir, `status-${status}.jsonl`);
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        responses: [
          { method: "GET", path: "/urlNotifications/metadata", status, body: { error: { message: "SECRET" } } },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", preload, bin, "indexing", "status", "https://example.com/jobs/1"],
      { encoding: "utf8", env: envFor(dir, scenarioFile, log) },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(expected), result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET/);
    const logText = readFileSync(log, "utf8");
    assert.doesNotThrow(() => assertTokenExchange(logText));
    assert.equal(logText.split("https://indexing.googleapis.com/v3/urlNotifications/metadata").length - 1, 1);
  }
});

test("confirmed batch chunks 101 URLs and correlates out-of-order responses", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-batch-chunks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  scenario.responses = scenario.responses.filter((entry) => entry.path !== "/batch");
  const firstStatuses = Array(100).fill(200);
  firstStatuses[2] = 403;
  scenario.responses.push(
    {
      method: "POST",
      path: "/batch",
      once: true,
      raw: multipart(firstStatuses),
      headers: { "content-type": 'multipart/mixed; boundary="response"' },
    },
    {
      method: "POST",
      path: "/batch",
      once: true,
      raw: multipart([429]),
      headers: { "content-type": 'multipart/mixed; boundary="response"' },
    },
  );
  const scenarioFile = join(dir, "scenario.json");
  const urlsFile = join(dir, "urls.txt");
  const log = join(dir, "requests.jsonl");
  const urls = Array.from({ length: 101 }, (_, index) => `https://example.com/jobs/${index}`);
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  writeFileSync(urlsFile, urls.join("\n"));
  const result = spawnSync(
    process.execPath,
    ["--import", preload, bin, "indexing", "batch", urlsFile, "--type=updated", "--confirm"],
    { encoding: "utf8", env: envFor(dir, scenarioFile, log) },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const output = decode(result.stdout);
  assert.equal(output.request_count, 101);
  assert.equal(output.submitted, 99);
  assert.equal(output.failed, 2);
  assert.equal(output.results[2].http_status, 403);
  assert.equal(output.results[100].http_status, 429);
  assert.deepEqual(
    output.results.map((item) => item.url),
    urls,
  );
  const logText = readFileSync(log, "utf8");
  assert.doesNotThrow(() => assertTokenExchange(logText));
  const entries = logText.trim().split("\n").map(JSON.parse);
  const batches = entries.filter((entry) => entry.url?.includes("indexing.googleapis.com/batch"));
  assert.equal(batches.length, 2);
  assert.equal((batches[0].body.match(/Content-Type: application\/http/g) ?? []).length, 100);
  assert.equal((batches[1].body.match(/Content-Type: application\/http/g) ?? []).length, 1);
});

test("quota follows pagination and reports observed values without guessing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-quota-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scenarioFile = join(dir, "scenario.json");
  const log = join(dir, "requests.jsonl");
  writeFileSync(
    scenarioFile,
    JSON.stringify({
      responses: [
        {
          method: "GET",
          path: "/consumerQuotaMetrics",
          query: { pageToken: null },
          body: {
            nextPageToken: "next-page",
            metrics: [
              {
                metric: "indexing.googleapis.com/publish_requests",
                consumerQuotaLimits: [{ unit: "1/d/{project}", quotaBuckets: [{ effectiveLimit: "800" }] }],
              },
            ],
          },
        },
        {
          method: "GET",
          path: "/consumerQuotaMetrics",
          query: { pageToken: "next-page" },
          body: {
            metrics: [
              {
                metric: "indexing.googleapis.com/metadata_requests",
                consumerQuotaLimits: [{ unit: "1/m/{project}", quotaBuckets: [{ effectiveLimit: "180" }] }],
              },
            ],
          },
        },
        {
          method: "GET",
          path: "/timeSeries",
          body: {
            timeSeries: [
              {
                resource: { labels: { method: "PublishUrlNotification" } },
                points: [{ value: { int64Value: "17" } }],
              },
            ],
          },
        },
      ],
    }),
  );
  const result = spawnSync(process.execPath, ["--import", preload, bin, "indexing", "quota"], {
    encoding: "utf8",
    env: envFor(dir, scenarioFile, log, "fixture-project"),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = decode(result.stdout);
  assert.deepEqual(
    output.limits.map((item) => item.effective_limit),
    ["800", "180"],
  );
  assert.equal(output.usage_today.by_method[0].requests, "17");
  assert.equal(output.documented_defaults.publish_per_day, 200);
  const requests = readFileSync(log, "utf8");
  assert.doesNotThrow(() => assertTokenExchange(requests));
  assert.equal(requests.split("consumerQuotaMetrics").length - 1, 2);
  assert.ok(requests.includes("timeSeries"));
});

test("quota and indexing status redact disabled-service and insufficient-scope errors", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-quota-errors-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [reason, expected] of [
    ["SERVICE_DISABLED", "Enable the"],
    ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "OAuth scope"],
  ]) {
    const scenarioFile = join(dir, `${reason}.json`);
    const quotaLog = join(dir, `${reason}-quota.jsonl`);
    const statusLog = join(dir, `${reason}-status.jsonl`);
    const error = { error: { details: [{ reason }], message: "SECRET" } };
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        responses: [
          { method: "GET", path: "/consumerQuotaMetrics", status: 403, body: error },
          { method: "GET", path: "/timeSeries", status: 403, body: error },
          { method: "GET", path: "/urlNotifications/metadata", status: 403, body: error },
        ],
      }),
    );
    const quotaResult = spawnSync(process.execPath, ["--import", preload, bin, "indexing", "quota"], {
      encoding: "utf8",
      env: envFor(dir, scenarioFile, quotaLog, "fixture-project"),
    });
    assert.equal(quotaResult.status, 0, quotaResult.stdout + quotaResult.stderr);
    const quota = decode(quotaResult.stdout);
    const quotaText = `${JSON.stringify(quota.limits)} ${quota.usage_today.status}`;
    assert.ok(quotaText.includes(expected), quotaText);
    assert.doesNotMatch(quotaResult.stdout, /SECRET/);
    assert.doesNotThrow(() => assertTokenExchange(readFileSync(quotaLog, "utf8")));

    const statusResult = spawnSync(
      process.execPath,
      ["--import", preload, bin, "indexing", "status", "https://example.com/jobs/1"],
      { encoding: "utf8", env: envFor(dir, scenarioFile, statusLog, "fixture-project") },
    );
    assert.equal(statusResult.status, 1, statusResult.stdout + statusResult.stderr);
    assert.ok(statusResult.stdout.includes(expected), statusResult.stdout);
    assert.doesNotMatch(statusResult.stdout, /SECRET/);
    assert.doesNotThrow(() => assertTokenExchange(readFileSync(statusLog, "utf8")));
  }
});

test("uncertain batch transport outcome is unknown and is never retried", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-batch-uncertain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  scenario.responses = scenario.responses.filter((entry) => entry.path !== "/batch");
  const scenarioFile = join(dir, "scenario.json");
  const urlsFile = join(dir, "urls.txt");
  const log = join(dir, "requests.jsonl");
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  writeFileSync(urlsFile, "https://example.com/jobs/1\nhttps://example.com/jobs/2\n");
  const result = spawnSync(
    process.execPath,
    ["--import", preload, bin, "indexing", "batch", urlsFile, "--type=updated", "--confirm"],
    { encoding: "utf8", env: envFor(dir, scenarioFile, log) },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const output = decode(result.stdout);
  assert.equal(output.failed, 2);
  assert.deepEqual(
    output.results.map((item) => item.status),
    ["unknown", "unknown"],
  );
  const logText = readFileSync(log, "utf8");
  assert.doesNotThrow(() => assertTokenExchange(logText));
  const batches = logText
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((entry) => entry.url?.includes("indexing.googleapis.com/batch"));
  assert.equal(batches.length, 1);
});
