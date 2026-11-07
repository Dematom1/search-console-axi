import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseArgs } from "../dist/src/args.js";
import { assertTokenExchange } from "./harness/assert-token-log.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const fakeKey = JSON.stringify({ type: "service_account", client_email: "fake@example.invalid", private_key: privateKey });
const paths = () => ({
  preload: new URL("./harness/preload.mjs", import.meta.url).pathname,
  scenario: new URL("./harness/scenarios/home.json", import.meta.url).pathname,
  bin: new URL("../dist/bin/search-console-axi.js", import.meta.url).pathname,
});

test("indexing arguments support equals values and dash positionals", () => {
  assert.deepEqual(parseArgs(["--type=updated", "-"], ["--type"]), {
    positionals: ["-"],
    flags: new Map([["--type", "updated"]]),
  });
});

test("confirmed batch chunks 101 URLs and correlates out-of-order responses without retry", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gsc-batch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const urls = Array.from({ length: 101 }, (_, i) => `https://example.com/jobs/${i}`);
  const multipart = (count) => {
    const items = Array.from({ length: count }, (_, i) => i).reverse().map((i) =>
      `--response\r\nContent-Type: application/http\r\nContent-ID: <response-item-${i}>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}\r\n`,
    );
    return `${items.join("")}--response--\r\n`;
  };
  const scenario = JSON.parse(readFileSync(paths().scenario, "utf8"));
  scenario.responses.push({
    method: "POST", path: "indexing.googleapis.com/batch", raw: multipart(100),
    headers: { "content-type": 'multipart/mixed; boundary="response"' },
  });
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  writeFileSync(join(dir, "urls.txt"), urls.join("\n"));
  const log = join(dir, "requests.jsonl");
  const { preload, bin } = paths();
  const result = spawnSync(process.execPath, ["--import", preload, bin, "indexing", "batch", join(dir, "urls.txt"), "--type=updated", "--confirm"], {
    encoding: "utf8",
    env: { ...process.env, SEARCH_CONSOLE_AXI_SA_KEY: fakeKey, FAKE_GSC_SCENARIO: join(dir, "scenario.json"), FAKE_LOG: log, XDG_CONFIG_HOME: dir },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.request_count, 101);
  assert.equal(output.submitted, 101);
  assert.deepEqual(output.results.map((item) => item.url), urls);
  const entries = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.doesNotThrow(() => assertTokenExchange(readFileSync(log, "utf8")));
  const batches = entries.filter((entry) => entry.url.includes("indexing.googleapis.com/batch"));
  assert.equal(batches.length, 2);
  assert.equal((batches[0].body.match(/Content-Type: application\/http/g) ?? []).length, 100);
  assert.equal((batches[1].body.match(/Content-Type: application\/http/g) ?? []).length, 1);
});
