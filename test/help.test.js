import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
const bin = new URL("../dist/bin/search-console-axi.js", import.meta.url);
test("CLI version matches package metadata", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const result = spawnSync(process.execPath, [bin.pathname, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), version);
});

test("every command and subcommand help route decodes without credentials or network", () => {
  const cases = [
    [],
    ["setup"],
    ["setup", "check"],
    ["setup", "status"],
    ["setup", "site"],
    ["setup", "service-account"],
    ["setup", "uninstall"],
    ["report"],
    ["inspect"],
    ["indexing"],
    ["indexing", "publish"],
    ["indexing", "status"],
    ["indexing", "batch"],
    ["indexing", "quota"],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [bin.pathname, ...args, "--help"], {
      encoding: "utf8",
      env: { ...process.env, SEARCH_CONSOLE_AXI_SA_KEY: undefined },
    });
    assert.equal(result.status, 0, `${args}: ${result.stdout} ${result.stderr}`);
    assert.doesNotThrow(() => decode(result.stdout));
  }
});

test("unconfigured bare home is fast and silent on stderr", (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsc-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const start = Date.now();
  const result = spawnSync(process.execPath, [bin.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CLOUDSDK_CONFIG: join(home, "gcloud"),
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      SEARCH_CONSOLE_AXI_SA_KEY: undefined,
      METADATA_SERVER_DETECTION: undefined,
    },
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stderr, "");
  assert.ok(Date.now() - start < 1000);
});
