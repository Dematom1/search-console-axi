import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { parseBatch } from "../dist/src/commands/indexing.js";

const cli = new URL("../dist/bin/search-console-axi.js", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = JSON.stringify({
  type: "service_account",
  client_email: "sc-agent@example.invalid",
  private_key: privateKey,
});
const response = (id, status, body) =>
  `--response_boundary\r\nContent-Type: application/http\r\nContent-ID: <response-item-${id}>\r\n\r\nHTTP/1.1 ${status} Result\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n`;
const homeFor = (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsc-setup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
};
const run = (home, args, extra = {}) => {
  const env = { ...process.env };
  for (const name of [
    "SEARCH_CONSOLE_AXI_SA_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "google_application_credentials",
    "CLOUDSDK_CONFIG",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
  ])
    delete env[name];
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CLOUDSDK_CONFIG: join(home, ".gcloud"),
      ...extra,
    },
  });
};

test("batch parser marks malformed, duplicate, missing, successful, and failed results", () => {
  const urls = ["https://example.com/1", "https://example.com/2"];
  assert.deepEqual(
    parseBatch("bad", "text/plain", urls).map((item) => item.status),
    ["unknown", "unknown"],
  );
  const duplicate = response(0, 200, {}) + response(0, 200, {}) + "--response_boundary--\r\n";
  assert.deepEqual(
    parseBatch(duplicate, "multipart/mixed; boundary=response_boundary", urls).map((item) => item.status),
    ["unknown", "unknown"],
  );
  const mixed =
    response(1, 403, { error: { message: "denied" } }) +
    response(0, 200, { urlNotificationMetadata: { latestUpdate: { type: "URL_UPDATED" } } }) +
    "--response_boundary--\r\n";
  const results = parseBatch(mixed, "multipart/mixed; boundary=response_boundary", urls);
  assert.deepEqual(
    results.map((item) => item.status),
    ["submitted", "failed"],
  );
  assert.equal(results[0].latest_update.type, "URL_UPDATED");
  assert.equal(results[1].http_status, 403);
});

test("setup status reports missing, invalid, authorized-user, and service-account credentials", (t) => {
  const home = homeFor(t);
  let result = run(home, ["setup", "status"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(decode(result.stdout).auth.status, "not configured");
  result = run(home, ["setup", "status"], { SEARCH_CONSOLE_AXI_SA_KEY: "{}" });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(decode(result.stdout).auth.status, "invalid");
  result = run(home, ["setup", "status"], { GOOGLE_APPLICATION_CREDENTIALS: "" });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(decode(result.stdout).auth.status, "invalid");
  assert.equal("type" in decode(result.stdout).auth, false);

  const adc = join(home, "adc.json");
  writeFileSync(
    adc,
    JSON.stringify({
      type: "authorized_user",
      client_id: "fixture-client",
      client_secret: "fixture-secret",
      refresh_token: "fixture-refresh",
      quota_project_id: "fixture-project",
      universe_domain: "googleapis.com",
    }),
  );
  result = run(home, ["setup", "status"], { GOOGLE_APPLICATION_CREDENTIALS: adc });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual((({ status, type, source }) => ({ status, type, source }))(decode(result.stdout).auth), {
    status: "configured",
    type: "authorized_user",
    source: "GOOGLE_APPLICATION_CREDENTIALS",
  });
  result = run(home, ["setup", "status"], { SEARCH_CONSOLE_AXI_SA_KEY: key });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(decode(result.stdout).auth.type, "service_account");
  assert.equal(decode(result.stdout).auth.account_email, "sc-agent@example.invalid");
  assert.doesNotMatch(result.stdout, /private_key|BEGIN PRIVATE KEY/);
  assert.equal(existsSync(join(home, ".config", "search-console-axi", "config.json")), false);
});

test("setup persists quota and service-account settings, then uninstalls them", (t) => {
  const home = homeFor(t);
  let result = run(home, ["setup", "--quota-project=fixture-project"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(decode(result.stdout).setup.status, "incomplete");
  const config = join(home, ".config", "search-console-axi", "config.json");
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { quotaProjectId: "fixture-project" });

  const keyFile = join(home, "key.json");
  writeFileSync(keyFile, key);
  result = run(home, ["setup", "service-account", keyFile]);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), {
    quotaProjectId: "fixture-project",
    serviceAccountPath: keyFile,
  });
  result = run(home, ["setup", "uninstall"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(existsSync(config), false);
});

test("malformed credentials and config fail as validation errors before network access", (t) => {
  const home = homeFor(t);
  const malformed = join(home, "malformed.json");
  writeFileSync(malformed, "{");
  let result = run(home, ["setup"], { GOOGLE_APPLICATION_CREDENTIALS: malformed });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /VALIDATION_ERROR/);
  const missing = run(home, ["setup"], { GOOGLE_APPLICATION_CREDENTIALS: join(home, "missing.json") });
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stdout, /AUTH_CONFIG_ERROR/);

  result = run(home, ["setup"], { SEARCH_CONSOLE_AXI_SA_KEY: "{}" });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /VALIDATION_ERROR/);
  const configDir = join(home, ".config", "search-console-axi");
  const config = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(config, "{");
  result = run(home, ["setup"]);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /VALIDATION_ERROR/);
  assert.equal(decode(run(home, ["setup", "status"]).stdout).auth.status, "invalid");
});
