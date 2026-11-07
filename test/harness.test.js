import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { parseArgs } from "../dist/src/args.js";
import { assertTokenExchange } from "./harness/assert-token-log.mjs";

const fakeKey = (projectId) => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return JSON.stringify({
    type: "service_account",
    client_email: "fake@example.invalid",
    private_key: privateKey,
    ...(projectId ? { project_id: projectId } : {}),
  });
};
const paths = () => ({
  preload: fileURLToPath(new URL("./harness/preload.mjs", import.meta.url)),
  scenario: fileURLToPath(new URL("./harness/scenarios/home.json", import.meta.url)),
  bin: fileURLToPath(new URL("../dist/bin/search-console-axi.js", import.meta.url)),
});

test("strict parser handles inline values, signed values, repeated flags, empty values and dash positional", () => {
  assert.deepEqual(parseArgs(["--days=-5", "-"], ["--days"]), {
    positionals: ["-"],
    flags: new Map([["--days", "-5"]]),
  });
  assert.equal(parseArgs(["--site", "sc-domain:example.com"], ["--site"]).flags.get("--site"), "sc-domain:example.com");
  assert.equal(parseArgs(["--days", "-5"], ["--days"]).flags.get("--days"), "-5");
  for (const args of [["--days="], ["--days", "--site"], ["--days", "1", "--days", "2"], ["--other"]])
    assert.throws(() => parseArgs(args, ["--days", "--site"]));
});

test("fake subprocess intercepts the OAuth token exchange and all Search Console traffic", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-harness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "requests.jsonl");
  const { preload, scenario, bin } = paths();
  const result = spawnSync(process.execPath, ["--import", preload, bin], {
    encoding: "utf8",
    env: {
      ...process.env,
      SEARCH_CONSOLE_AXI_SA_KEY: fakeKey(),
      METADATA_SERVER_DETECTION: "none",
      FAKE_GSC_SCENARIO: scenario,
      FAKE_LOG: log,
      XDG_CONFIG_HOME: dir,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const logText = readFileSync(log, "utf8");
  assert.doesNotThrow(() => assertTokenExchange(logText));
  assert.match(logText, /searchconsole\.googleapis\.com\/webmasters\/v3\/sites/);
  assert.match(logText, /searchAnalytics\/query/);
  const inspectLog = join(dir, "inspect.jsonl");
  const inspected = spawnSync(process.execPath, ["--import", preload, bin, "inspect", "https://example.com/"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SEARCH_CONSOLE_AXI_SA_KEY: fakeKey(),
      FAKE_GSC_SCENARIO: scenario,
      FAKE_LOG: inspectLog,
      XDG_CONFIG_HOME: dir,
    },
  });
  assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
  assert.equal(decode(inspected.stdout).indexStatusResult.verdict, "PASS");
  assert.doesNotMatch(inspected.stdout, /setup inspect/);
  const inspectRequests = readFileSync(inspectLog, "utf8").trim().split("\n").map(JSON.parse);
  assert.doesNotThrow(() => assertTokenExchange(inspectRequests.map((item) => JSON.stringify(item)).join("\n")));
  const inspection = inspectRequests.find((item) => item.url?.includes("urlInspection/index:inspect"));
  assert.deepEqual(JSON.parse(inspection.body), {
    inspectionUrl: "https://example.com/",
    siteUrl: "sc-domain:a.example",
    languageCode: "en-US",
  });
});

test("setup, report, and indexing commands intercept OAuth and API traffic", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-command-harness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { preload, scenario, bin } = paths();
  for (const [name, args, expectedPath, input] of [
    ["setup-check", ["setup", "check"], "/sites"],
    ["report", ["report"], "/searchAnalytics/query"],
    ["indexing-status", ["indexing", "status", "https://example.com/"], "/urlNotifications/metadata"],
    [
      "indexing-publish",
      ["indexing", "publish", "https://example.com/jobs/1", "--type=updated", "--confirm"],
      "/urlNotifications:publish",
    ],
    [
      "indexing-batch",
      ["indexing", "batch", "-", "--type=updated", "--confirm"],
      "/batch",
      "https://example.com/jobs/1\n",
    ],
    ["indexing-quota", ["indexing", "quota"], "/consumerQuotaMetrics"],
  ]) {
    const log = join(dir, `${name}.jsonl`);
    const result = spawnSync(process.execPath, ["--import", preload, bin, ...args], {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        SEARCH_CONSOLE_AXI_SA_KEY: fakeKey(name === "indexing-quota" ? "fake-project" : undefined),
        FAKE_GSC_SCENARIO: scenario,
        FAKE_LOG: log,
        XDG_CONFIG_HOME: dir,
      },
    });
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    const output = decode(result.stdout);
    if (name === "setup-check") {
      assert.equal(output.setup.status, "ready");
      assert.deepEqual(output.sites[0], { site_url: "sc-domain:z.example", permission: "siteOwner" });
    }
    if (name === "report") {
      assert.equal(output.site_source, "first_verified");
      assert.equal(output.top_queries.length, 1);
      assert.equal(output.top_pages.length, 1);
      assert.equal(output.low_ctr_opportunities.length, 1);
      assert.equal(output.totals.ctr, "0.8%");
      assert.equal(output.totals.position, 3);
    }
    if (name === "indexing-status") {
      assert.equal(output.latest_update.type, "URL_UPDATED");
      assert.match(output.note, /not crawl or index status/);
    }
    if (name === "indexing-publish") assert.equal(output.results[0].status, "submitted");
    if (name === "indexing-batch") assert.equal(output.submitted, 1);
    if (name === "indexing-quota") assert.equal(output.usage_today.total_observed_requests, "17");
    const logText = readFileSync(log, "utf8");
    assert.doesNotThrow(() => assertTokenExchange(logText), name);
    assert.ok(logText.includes(expectedPath), `${name}: ${logText}`);
    if (name === "indexing-quota") assert.ok(logText.includes("monitoring.googleapis.com/v3/projects/"));
  }
});

test("report requests match selected site, date range, dimensions, ordering, and limits", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-report-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { preload, scenario, bin } = paths();
  const cases = [
    { args: [], site: "sc-domain:a.example", startDate: "2026-10-31", endDate: "2026-11-06" },
    {
      args: ["--days", "3", "--site", "sc-domain:z.example"],
      site: "sc-domain:z.example",
      startDate: "2026-11-04",
      endDate: "2026-11-06",
    },
  ];
  for (const [index, item] of cases.entries()) {
    const log = join(dir, `${index}.jsonl`);
    const result = spawnSync(process.execPath, ["--import", preload, bin, "report", ...item.args], {
      encoding: "utf8",
      env: {
        ...process.env,
        SEARCH_CONSOLE_AXI_SA_KEY: fakeKey(),
        FAKE_GSC_SCENARIO: scenario,
        FAKE_LOG: log,
        FAKE_NOW: "2026-11-07T12:00:00Z",
        XDG_CONFIG_HOME: dir,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const requests = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((request) => request.method === "POST" && request.url.includes("/searchAnalytics/query"));
    const dateRange = { startDate: item.startDate, endDate: item.endDate };
    const expectedBodies = [
      dateRange,
      { ...dateRange, dimensions: ["query"], rowLimit: 10, orderBy: [{ field: "clicks", direction: "descending" }] },
      { ...dateRange, dimensions: ["page"], rowLimit: 10, orderBy: [{ field: "clicks", direction: "descending" }] },
      {
        ...dateRange,
        dimensions: ["page"],
        rowLimit: 1000,
        orderBy: [{ field: "impressions", direction: "descending" }],
      },
    ];
    assert.deepEqual(
      requests,
      expectedBodies.map((body) => ({
        method: "POST",
        url: `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(item.site)}/searchAnalytics/query`,
        body: JSON.stringify(body),
      })),
    );
  }
});

test("authorized-user ADC credentials exchange tokens through the fake transport", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-authorized-user-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const credentials = join(dir, "adc.json");
  writeFileSync(
    credentials,
    JSON.stringify({
      type: "authorized_user",
      client_id: "fixture-client",
      client_secret: "fixture-secret",
      refresh_token: "fixture-refresh",
    }),
  );
  const { preload, scenario, bin } = paths();
  const log = join(dir, "requests.jsonl");
  const env = {
    ...process.env,
    GOOGLE_APPLICATION_CREDENTIALS: credentials,
    FAKE_GSC_SCENARIO: scenario,
    FAKE_LOG: log,
    XDG_CONFIG_HOME: dir,
    CLOUDSDK_CONFIG: dir,
  };
  delete env.SEARCH_CONSOLE_AXI_SA_KEY;
  const result = spawnSync(process.execPath, ["--import", preload, bin, "setup", "check"], {
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(decode(result.stdout).auth.type, "authorized_user");
  assert.equal(decode(result.stdout).auth.source, "GOOGLE_APPLICATION_CREDENTIALS");
  assert.doesNotMatch(result.stdout, /fixture-secret|fixture-refresh/);
  assert.doesNotThrow(() => assertTokenExchange(readFileSync(log, "utf8")));
});

test("invalid CLI arguments fail before any fake request, including token exchange", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { preload, scenario, bin } = paths();
  const cases = [
    ["inspect", "--bogus"],
    ["inspect", "file:///tmp/page"],
    ["report", "--site"],
    ["report", "--days=abc"],
    ["setup", "--quota-project", "--site", "x"],
    ["setup", "hooks"],
    ["indexing", "publish", "https://x/", "--type=bogus"],
    ["indexing", "publish", "https://example.com/", "--confirm"],
    ["indexing", "publish", "https://example.com/", "--type=updated", "--confim"],
    ["indexing", "status", "https://user:password@example.com/"],
    ["indexing", "status", "file:///tmp/page"],
    ["indexing", "status", "https:example.com"],
    ["indexing", "status", "https://example.com/#fragment"],
    ["indexing", "status", "https://example.com/", "--confirm"],
    ["indexing", "status", "https://example.com/", "extra"],
    ["indexing", "quota", "unexpected"],
  ];
  for (const [index, args] of cases.entries()) {
    const log = join(dir, `${index}.jsonl`);
    const result = spawnSync(process.execPath, ["--import", preload, bin, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        SEARCH_CONSOLE_AXI_SA_KEY: fakeKey(),
        FAKE_GSC_SCENARIO: scenario,
        FAKE_LOG: log,
        XDG_CONFIG_HOME: dir,
      },
    });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /VALIDATION_ERROR/);
    assert.doesNotMatch(readFileSync(log, "utf8"), /oauth2|searchconsole|indexing/);
  }
});

test("Indexing write previews avoid credentials and network access", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-indexing-preview-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { preload, scenario, bin } = paths();
  const log = join(dir, "preview.jsonl");
  const result = spawnSync(
    process.execPath,
    ["--import", preload, bin, "indexing", "publish", "https://example.com/jobs/1", "--type=updated"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SEARCH_CONSOLE_AXI_SA_KEY: "invalid credential sentinel",
        FAKE_GSC_SCENARIO: scenario,
        FAKE_LOG: log,
        XDG_CONFIG_HOME: dir,
      },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(decode(result.stdout).mode, "preview");
  assert.doesNotMatch(result.stdout, /invalid credential sentinel/);
  assert.doesNotMatch(readFileSync(log, "utf8"), /oauth2|indexing.googleapis.com/);
});

test("Search Console command failures preserve empty-site, disabled-API, and access-denied guidance", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-errors-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { preload, bin } = paths();
  const cases = [
    {
      name: "empty-home",
      args: [],
      response: { body: { siteEntry: [] } },
      status: 0,
      expected: "No Search Console sites visible",
    },
    {
      name: "empty-report",
      args: ["report"],
      response: { body: { siteEntry: [] } },
      status: 2,
      expected: "No verified Search Console sites visible",
    },
    {
      name: "unverified-setup",
      args: ["setup", "check"],
      response: { body: { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteUnverifiedUser" }] } },
      status: 0,
      expected: "No verified Search Console sites",
    },
    {
      name: "disabled-setup",
      args: ["setup", "check"],
      response: {
        status: 403,
        body: {
          error: {
            message: "API disabled",
            details: [
              {
                reason: "SERVICE_DISABLED",
                metadata: { service: "searchconsole.googleapis.com", consumer: "projects/12345" },
              },
            ],
          },
        },
      },
      status: 0,
      expected: "Enable searchconsole.googleapis.com in 12345",
    },
    {
      name: "disabled-report",
      args: ["report"],
      response: {
        status: 403,
        body: { error: { message: "API disabled", errors: [{ reason: "accessNotConfigured" }] } },
      },
      status: 1,
      expected: "Enable Google Search Console API",
    },
    {
      name: "disabled-inspect-sites",
      args: ["inspect", "https://example.com/"],
      response: {
        status: 403,
        body: {
          error: {
            message: "API disabled",
            details: [
              {
                reason: "SERVICE_DISABLED",
                metadata: { service: "searchconsole.googleapis.com", consumer: "projects/12345" },
              },
            ],
          },
        },
      },
      status: 1,
      expected: "Enable searchconsole.googleapis.com in 12345",
    },
    {
      name: "disabled-inspect",
      args: ["inspect", "https://example.com/"],
      responses: [
        {
          method: "GET",
          path: "/sites",
          body: { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] },
        },
        {
          method: "POST",
          path: "/urlInspection/index:inspect",
          status: 403,
          body: {
            error: {
              message: "API disabled",
              details: [
                {
                  reason: "SERVICE_DISABLED",
                  metadata: { service: "searchconsole.googleapis.com", consumer: "projects/12345" },
                },
              ],
            },
          },
        },
      ],
      status: 1,
      expected: "Enable searchconsole.googleapis.com in 12345",
    },
    {
      name: "denied-setup",
      args: ["setup", "check"],
      response: { status: 403, body: { error: { message: "Insufficient Permission" } } },
      status: 0,
      expected: "Search Console access denied",
    },
    {
      name: "denied-report",
      args: ["report"],
      response: { status: 403, body: { error: { message: "Insufficient Permission" } } },
      status: 0,
      expected: "Search Console access denied",
    },
    {
      name: "denied-inspect",
      args: ["inspect", "https://example.com/"],
      responses: [
        {
          method: "GET",
          path: "/sites",
          body: { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] },
        },
        {
          method: "POST",
          path: "/urlInspection/index:inspect",
          status: 403,
          body: { error: { message: "Insufficient Permission" } },
        },
      ],
      status: 1,
      expected: "Search Console access denied",
    },
  ];
  for (const item of cases) {
    const scenarioFile = join(dir, `${item.name}.json`);
    const log = join(dir, `${item.name}.jsonl`);
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        responses: item.responses ?? [{ method: "GET", path: "/sites", ...item.response }],
      }),
    );
    const result = spawnSync(process.execPath, ["--import", preload, bin, ...item.args], {
      encoding: "utf8",
      env: {
        ...process.env,
        SEARCH_CONSOLE_AXI_SA_KEY: fakeKey(),
        FAKE_GSC_SCENARIO: scenarioFile,
        FAKE_LOG: log,
        XDG_CONFIG_HOME: dir,
      },
    });
    assert.equal(result.status, item.status, `${item.name}: ${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes(item.expected), `${item.name}: ${result.stdout}`);
    const requests = readFileSync(log, "utf8");
    assert.doesNotThrow(() => assertTokenExchange(requests), item.name);
    assert.ok(requests.includes("searchconsole.googleapis.com/webmasters/v3/sites"));
  }
});

test("fake rejects unknown hosts; absence of token exchange is detectable without making a live call", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-unknown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "requests.jsonl");
  const { preload, scenario } = paths();
  const script =
    "fetch('https://not-google.invalid/').then(() => process.exit(1), error => { if (!error.message.includes('unknown host')) process.exit(2) })";
  const result = spawnSync(process.execPath, ["--import", preload, "--eval", script], {
    encoding: "utf8",
    env: { ...process.env, FAKE_GSC_SCENARIO: scenario, FAKE_LOG: log },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => assertTokenExchange(readFileSync(log, "utf8")), /not intercepted by the fake/);
});
