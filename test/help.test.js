import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { commands } from "../dist/src/cli.js";

const bin = new URL("../dist/bin/search-console-axi.js", import.meta.url);
test("every registered command has decodable help without credentials or network", () => {
  assert.ok(commands.length > 0 && commands.every((command) => command.name && command.help));
  for (const command of commands) assert.doesNotThrow(() => decode(command.help));
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
