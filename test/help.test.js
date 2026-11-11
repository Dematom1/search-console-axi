import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { decode } from "@toon-format/toon";
import { commands } from "../dist/src/cli.js";
const bin = fileURLToPath(new URL("../dist/bin/search-console-axi.js", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const flag of ["--version", "-v", "-V"])
  test(`CLI ${flag} prints published version ${version}`, () => {
    const result = spawnSync(process.execPath, [bin, flag], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, `${version}\n`);
  });

test("every registered command and subcommand help route decodes without credentials or network", (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsc-help-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, CLOUDSDK_CONFIG: join(home, ".gcloud") };
  for (const name of [
    "SEARCH_CONSOLE_AXI_SITE",
    "SEARCH_CONSOLE_AXI_SA_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "google_application_credentials",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
  ])
    delete env[name];
  const cases = [
    [],
    ...commands.flatMap((command) => [
      [command.name],
      ...("subcommands" in command ? Object.keys(command.subcommands).map((action) => [command.name, action]) : []),
    ]),
  ];
  for (const flag of ["--help", "-h"])
    for (const args of cases) {
      const result = spawnSync(process.execPath, [bin, ...args, flag], {
        encoding: "utf8",
        env,
      });
      assert.equal(result.status, 0, `${args} ${flag}: ${result.stdout} ${result.stderr}`);
      assert.doesNotThrow(() => decode(result.stdout));
      const command = commands.find((item) => item.name === args[0]);
      if (args.length === 2 && command && "subcommands" in command)
        assert.equal(result.stdout.trim(), command.subcommands[args[1]]);
    }
});

test("unconfigured bare home is fast and silent on stderr", (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsc-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const started = performance.now();
  const result = spawnSync(process.execPath, [bin], {
    encoding: "utf8",
    timeout: 5000,
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
  assert.ok(performance.now() - started < 1000, "bare home must complete in under one second");
});
