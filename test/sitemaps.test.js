import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decode } from "@toon-format/toon";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = JSON.stringify({ type: "service_account", client_email: "fake@example.invalid", private_key: privateKey });
const preload = fileURLToPath(new URL("./harness/preload.mjs", import.meta.url));
const bin = fileURLToPath(new URL("../dist/bin/search-console-axi.js", import.meta.url));
const site = "sc-domain:example.com";
const path = "https://example.com/sitemap.xml";
const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`;
function run(t, args, responses = [], credential = key) {
  const dir = mkdtempSync(join(tmpdir(), "gsc-sitemaps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scenario = join(dir, "scenario.json");
  const log = join(dir, "requests.jsonl");
  writeFileSync(
    scenario,
    JSON.stringify({
      responses: [
        {
          method: "GET",
          path: "/webmasters/v3/sites",
          body: { siteEntry: [{ siteUrl: site, permissionLevel: "siteOwner" }] },
        },
        ...responses,
      ].reverse(),
    }),
  );
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    CLOUDSDK_CONFIG: dir,
    SEARCH_CONSOLE_AXI_SA_KEY: credential,
    GOOGLE_APPLICATION_CREDENTIALS: "",
    SEARCH_CONSOLE_AXI_SITE: "",
    FAKE_GSC_SCENARIO: scenario,
    FAKE_LOG: log,
  };
  if (credential === "adc") {
    delete env.SEARCH_CONSOLE_AXI_SA_KEY;
    env.GOOGLE_APPLICATION_CREDENTIALS = join(dir, "adc.json");
    writeFileSync(
      env.GOOGLE_APPLICATION_CREDENTIALS,
      JSON.stringify({ type: "authorized_user", client_id: "fake", client_secret: "SECRET", refresh_token: "SECRET" }),
    );
  }
  const result = spawnSync(process.execPath, ["--import", preload, bin, "sitemaps", ...args], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.stderr, "");
  return {
    ...result,
    output: decode(result.stdout),
    requests: readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((entry) => entry.url),
  };
}
// Oracle: Search Console API Sitemaps resource documents errors/warnings and
// contents[].submitted as separate fields; warnings must not count as errors.
// https://developers.google.com/webmaster-tools/v1/sitemaps#resource
const entry = {
  path,
  type: "sitemap",
  isSitemapsIndex: false,
  lastSubmitted: "2026-11-15T12:00:00Z",
  lastDownloaded: "2026-11-22T12:00:00Z",
  isPending: false,
  errors: "0",
  warnings: "2",
  contents: [
    { type: "web", submitted: "6077", indexed: "12" },
    { type: "image", submitted: "9007199254740993" },
  ],
};
test("sitemaps list and get retain API columns and exact counts", (t) => {
  const list = run(
    t,
    ["list", "--site", site],
    [
      {
        method: "GET",
        path: endpoint,
        body: {
          sitemap: [
            entry,
            { path: "https://example.com/pending.xml", isPending: true },
            { path: "https://example.com/errors.xml", isPending: false, errors: "1" },
          ],
        },
      },
    ],
  );
  assert.equal(list.status, 0, list.stdout);
  assert.equal(list.output.count, 3);
  assert.deepEqual(list.output.sitemaps[0], {
    ...entry,
    status: "success",
    contents: [...entry.contents.slice(0, 1), { ...entry.contents[1], indexed: null }],
  });
  assert.equal(list.output.sitemaps[1].status, "pending");
  assert.equal(list.output.sitemaps[1].errors, null);
  assert.equal(list.output.sitemaps[2].status, "errors");
  assert.match(list.output.note, /deprecated/);
  const token = list.requests.find((request) => request.url.includes("oauth2.googleapis.com"));
  const jwt = new URLSearchParams(token.body).get("assertion");
  assert.equal(
    JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")).scope,
    "https://www.googleapis.com/auth/webmasters.readonly",
  );
  const get = run(t, ["get", path], [{ method: "GET", path: `${endpoint}/${encodeURIComponent(path)}`, body: entry }]);
  assert.equal(get.status, 0, get.stdout);
  assert.deepEqual(get.output.sitemap, list.output.sitemaps[0]);
});
test("list follows page tokens and rejects malformed successful responses", (t) => {
  const result = run(
    t,
    ["list", "--site", site, "--sitemap-index", path],
    [
      {
        method: "GET",
        path: endpoint,
        query: { sitemapIndex: path },
        body: { sitemap: [entry], nextPageToken: "next" },
      },
      {
        method: "GET",
        path: endpoint,
        query: { sitemapIndex: path, pageToken: "next" },
        body: { sitemap: [{ path: "https://example.com/second.xml", errors: "0", warnings: "7" }] },
      },
    ],
  );
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output.count, 2);
  assert.equal(result.output.sitemaps[1].status, "success");
  assert.deepEqual(
    result.requests.filter((request) => request.url.includes("searchconsole.googleapis.com")).map((request) => new URL(request.url).searchParams.get("pageToken")),
    [null, "next"],
  );
  for (const raw of ["[]", JSON.stringify({ sitemap: {} })]) {
    const malformed = run(t, ["list", "--site", site], [{ method: "GET", path: endpoint, raw }]);
    assert.equal(malformed.status, 1, malformed.stdout);
    assert.match(malformed.output.error.message, /request failed/);
  }
});
test("empty list is explicit; index filter is sent", (t) => {
  const result = run(
    t,
    ["list", "--sitemap-index", path],
    [{ method: "GET", path: endpoint, query: { sitemapIndex: path }, body: {} }],
  );
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output.count, 0);
  assert.deepEqual(result.output.sitemaps, []);
});
test("preview and invalid arguments never load credentials or call Google", (t) => {
  const preview = run(t, ["submit", path, "--site", site], [], "not-json");
  assert.equal(preview.status, 0, preview.stdout);
  assert.equal(preview.output.mode, "preview");
  assert.equal(preview.output.site, site);
  assert.equal(preview.output.path, path);
  assert.equal(preview.output.method, "PUT");
  assert.equal(preview.output.url, `${endpoint}/${encodeURIComponent(path)}`);
  assert.equal(preview.requests.length, 0);
  for (const args of [
    ["submit", path],
    ["submit", "https://user:SECRET@example.com/sitemap.xml", "--site", site],
    ["get", "https://example.com/sitemap.xml#fragment"],
    ["list", "--confirm"],
    ["list", "extra"],
    ["get"],
    ["list", "--typo"],
    ["submit", path, "--site", site, "--confirm=false"],
    ["list", "--site", "bad"],
  ]) {
    const result = run(t, args, [], "not-json");
    assert.equal(result.status, 2, result.stdout);
    assert.equal(result.output.error.code, "VALIDATION_ERROR");
    assert.equal(result.requests.length, 0);
    assert.doesNotMatch(result.stdout, /SECRET/);
  }
});
test("confirmed submit uses exact preview target, write scope, and one PUT without site resolution", (t) => {
  const result = run(
    t,
    ["submit", path, "--site", site, "--confirm"],
    [{ method: "PUT", path: `${endpoint}/${encodeURIComponent(path)}`, body: {} }],
  );
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.output.mode, "submitted");
  assert.equal(result.requests.filter((request) => !request.url.includes("oauth2.googleapis.com")).length, 1);
  const token = result.requests.find((request) => request.url.includes("oauth2.googleapis.com"));
  const jwt = new URLSearchParams(token.body).get("assertion");
  assert.equal(
    JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")).scope,
    "https://www.googleapis.com/auth/webmasters",
  );
});
test("read-only ADC fails clearly without scope widening or retries; errors are sanitized", (t) => {
  for (const [status, reason, expected] of [
    [403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", /https:\/\/www.googleapis.com\/auth\/webmasters/],
    [403, "forbidden", /access denied/],
    [404, "notFound", /not found/],
    [429, "rateLimitExceeded", /quota exceeded/],
    [500, "backendError", /request failed/],
  ]) {
    const result = run(
      t,
      ["submit", path, "--site", site, "--confirm"],
      [{ method: "PUT", path: endpoint, status, body: { error: { message: "SECRET", details: [{ reason }] } } }],
      "adc",
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.output.error.message, expected);
    assert.doesNotMatch(result.stdout, /SECRET/);
    assert.equal(result.requests.filter((request) => request.method === "PUT").length, 1);
    const token = result.requests.find((request) => request.url.includes("oauth2.googleapis.com"));
    assert.equal(new URLSearchParams(token.body).has("scope"), false);
  }
});
