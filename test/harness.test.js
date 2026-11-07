import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
  preload: new URL("./harness/preload.mjs", import.meta.url).pathname,
  scenario: new URL("./harness/scenarios/home.json", import.meta.url).pathname,
  bin: new URL("../dist/bin/search-console-axi.js", import.meta.url).pathname,
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
  assert.doesNotThrow(() => assertTokenExchange(readFileSync(inspectLog, "utf8")));
  assert.match(readFileSync(inspectLog, "utf8"), /urlInspection\/index:inspect/);
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
    if (name === "setup-check") assert.equal(output.setup.status, "ready");
    if (name === "report") assert.equal(output.site_source, "first_verified");
    if (name === "indexing-status") assert.equal(output.latest_update.type, "URL_UPDATED");
    if (name === "indexing-publish") assert.equal(output.results[0].status, "submitted");
    if (name === "indexing-batch") assert.equal(output.submitted, 1);
    if (name === "indexing-quota") assert.equal(output.usage_today.total_observed_requests, 17);
    const logText = readFileSync(log, "utf8");
    assert.doesNotThrow(() => assertTokenExchange(logText), name);
    assert.ok(logText.includes(expectedPath), `${name}: ${logText}`);
    if (name === "indexing-quota") assert.ok(logText.includes("monitoring.googleapis.com/v3/projects/"));
  }
});

test("invalid CLI arguments fail before any fake request, including token exchange", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { preload, scenario, bin } = paths();
  const cases = [
    ["inspect", "--bogus"],
    ["report", "--site"],
    ["report", "--days=abc"],
    ["setup", "--quota-project", "--site", "x"],
    ["indexing", "publish", "https://x/", "--type=bogus"],
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
