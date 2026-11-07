import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { assertTokenExchange } from "./harness/assert-token-log.mjs";

const cli = new URL("../dist/bin/search-console-axi.js", import.meta.url).pathname;
const preload = new URL("./harness/preload.mjs", import.meta.url).pathname;
const scenario = new URL("./harness/scenarios/home.json", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = JSON.stringify({
  type: "service_account",
  client_email: "fake@example.invalid",
  private_key: privateKey,
});

test("standalone inspect resolves a site and rejects malformed URLs before auth", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-inspect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "inspect.jsonl");
  const inspected = spawnSync(process.execPath, ["--import", preload, cli, "inspect", "https://example.com/"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SEARCH_CONSOLE_AXI_SA_KEY: key,
      FAKE_GSC_SCENARIO: scenario,
      FAKE_LOG: log,
      XDG_CONFIG_HOME: dir,
    },
  });
  assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
  assert.equal(decode(inspected.stdout).indexStatusResult.verdict, "PASS");
  assert.doesNotMatch(inspected.stdout, /setup inspect/);
  assert.doesNotThrow(() => assertTokenExchange(readFileSync(log, "utf8")));

  const invalidLog = join(dir, "invalid.jsonl");
  const invalid = spawnSync(process.execPath, ["--import", preload, cli, "inspect", "file:///tmp/page"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SEARCH_CONSOLE_AXI_SA_KEY: key,
      FAKE_GSC_SCENARIO: scenario,
      FAKE_LOG: invalidLog,
      XDG_CONFIG_HOME: dir,
    },
  });
  assert.equal(invalid.status, 2, invalid.stdout);
  assert.match(decode(invalid.stdout).error.message, /HTTP\(S\) URL/);
  assert.deepEqual(
    readFileSync(invalidLog, "utf8").trim().split("\n").map(JSON.parse),
    [{ max_concurrency: 0 }],
  );
});
