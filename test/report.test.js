import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";
import { assertTokenExchange } from "./harness/assert-token-log.mjs";

const key = () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return JSON.stringify({ type: "service_account", client_email: "fake@example.invalid", private_key: privateKey });
};
const preload = fileURLToPath(new URL("./harness/preload.mjs", import.meta.url));
const scenario = fileURLToPath(new URL("./harness/scenarios/home.json", import.meta.url));
const bin = fileURLToPath(new URL("../dist/bin/search-console-axi.js", import.meta.url));
const baseEnv = { ...process.env };
for (const name of [
  "SEARCH_CONSOLE_AXI_SITE",
  "SEARCH_CONSOLE_AXI_SA_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "google_application_credentials",
  "CLOUDSDK_CONFIG",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "HOME",
])
  delete baseEnv[name];

test("report resolves sites by flag, environment, saved config, then stable verified order", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-site-resolution-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (name, args, extraEnv = {}) => {
    const log = join(dir, `${name}.jsonl`);
    const result = spawnSync(process.execPath, ["--import", preload, bin, ...args], {
      encoding: "utf8",
      env: {
        ...baseEnv,
        SEARCH_CONSOLE_AXI_SA_KEY: key(),
        FAKE_GSC_SCENARIO: scenario,
        FAKE_LOG: log,
        XDG_CONFIG_HOME: dir,
        ...extraEnv,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const requests = readFileSync(log, "utf8");
    assert.doesNotThrow(() => assertTokenExchange(requests));
    assert.ok(requests.includes("/sites"));
    return decode(result.stdout);
  };

  assert.deepEqual(
    (({ site, site_source }) => ({ site, site_source }))(run("flag", ["report", "--site=sc-domain:flag.example"])),
    { site: "sc-domain:flag.example", site_source: "flag" },
  );
  assert.deepEqual(
    (({ site, site_source }) => ({ site, site_source }))(
      run("environment", ["report"], { SEARCH_CONSOLE_AXI_SITE: "sc-domain:env.example" }),
    ),
    { site: "sc-domain:env.example", site_source: "environment" },
  );
  const saveLog = join(dir, "save.jsonl");
  const save = spawnSync(process.execPath, ["--import", preload, bin, "setup", "site", "sc-domain:saved.example"], {
    encoding: "utf8",
    env: {
      ...baseEnv,
      XDG_CONFIG_HOME: dir,
      FAKE_GSC_SCENARIO: scenario,
      FAKE_LOG: saveLog,
    },
  });
  assert.equal(save.status, 0, save.stdout + save.stderr);
  assert.deepEqual((({ site, site_source }) => ({ site, site_source }))(run("saved", ["report"])), {
    site: "sc-domain:saved.example",
    site_source: "saved_config",
  });
  rmSync(join(dir, "search-console-axi", "config.json"));
  assert.deepEqual((({ site, site_source }) => ({ site, site_source }))(run("first", ["report"])), {
    site: "sc-domain:a.example",
    site_source: "first_verified",
  });
});
