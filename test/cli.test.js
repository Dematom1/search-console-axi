import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { spawnSync } from "node:child_process";
import { JWT, UserRefreshClient } from "google-auth-library";
import { getAuthClient, setupCommand } from "../dist/bin/auth.js";
import { runHome, inspectUrl } from "../dist/bin/setup-check.js";

const cli = new URL("../dist/bin/search-console-axi.js", import.meta.url);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const scopes = ["https://www.googleapis.com/auth/webmasters.readonly"];
const permissionDenialsUnreliable = process.platform === "win32" || process.getuid?.() === 0;
const run = (args, env = {}) =>
  execFileSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "search-console-axi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const setEnv = (t, name, value) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => (previous === undefined ? delete process.env[name] : (process.env[name] = previous)));
};
const isolateAuthEnv = (t) => {
  const dir = temp(t);
  const env = {
    XDG_CONFIG_HOME: dir,
    SEARCH_CONSOLE_AXI_SA_KEY: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    google_application_credentials: undefined,
    CLOUDSDK_CONFIG: dir,
    GOOGLE_CLOUD_QUOTA_PROJECT: undefined,
  };
  for (const [name, value] of Object.entries(env)) setEnv(t, name, value);
  return env;
};
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
const mockAuth = (request) => ({
  type: "service_account",
  source: "SEARCH_CONSOLE_AXI_SA_KEY",
  email: "sc-agent@example.invalid",
  client: { request },
});

test("CLI reports its version and live home without credentials", (t) => {
  assert.equal(run(["--version"]).trim(), version);
  const home = decode(
    run([], { ...isolateAuthEnv(t), SEARCH_CONSOLE_AXI_SA_KEY: "{}", GOOGLE_APPLICATION_CREDENTIALS: "" }),
  );
  assert.equal(home.auth.status, "invalid");
  assert.equal(home.setup.guide.length > 0, true);
});

test("ADC requests only the Search Console read-only scope", async (t) => {
  isolateAuthEnv(t);
  const client = new UserRefreshClient();
  client.setCredentials({ access_token: "test-access-token" });
  let options;
  const auth = await getAuthClient({
    authFactory: (opts) => {
      options = opts;
      return { getApplicationDefault: async () => ({ credential: client, projectId: null }) };
    },
  });
  assert.equal(auth.type, "authorized_user");
  assert.deepEqual(options.scopes, scopes);
});

test("GOOGLE_APPLICATION_CREDENTIALS accepts authorized-user ADC files", async (t) => {
  const { XDG_CONFIG_HOME: dir } = isolateAuthEnv(t);
  const credentialsPath = join(dir, "adc.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      type: "authorized_user",
      client_id: "client",
      client_secret: "secret",
      refresh_token: "refresh",
      quota_project_id: "fixture-project",
      universe_domain: "googleapis.com",
    }),
  );
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);
  const auth = await getAuthClient();
  assert.ok(auth.client instanceof UserRefreshClient);
  assert.equal(auth.client.credentials.refresh_token, "refresh");
  assert.equal(auth.client.universeDomain, "googleapis.com");
  assert.equal(auth.quotaProjectId, "fixture-project");
  assert.equal(auth.type, "authorized_user");
  assert.equal(auth.source, "GOOGLE_APPLICATION_CREDENTIALS");
});

test("auth status does not guess a credential type for an invalid ADC path", async (t) => {
  isolateAuthEnv(t);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", "");
  const status = decode(await setupCommand(["status"]));
  assert.equal(status.auth.status, "invalid");
  assert.equal("type" in status.auth, false);
});

test("malformed and unsupported ADC credential JSON are typed validation errors", async (t) => {
  const { XDG_CONFIG_HOME } = isolateAuthEnv(t);
  for (const [name, content] of [
    ["malformed.json", "{"],
    ["unsupported.json", "{}"],
  ]) {
    const credentialsPath = join(XDG_CONFIG_HOME, name);
    writeFileSync(credentialsPath, content);
    setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);
    const env = { ...process.env, XDG_CONFIG_HOME, GOOGLE_APPLICATION_CREDENTIALS: credentialsPath };
    const setup = spawnSync(process.execPath, [cli.pathname, "setup"], { encoding: "utf8", env });
    assert.equal(setup.status, 2, setup.stdout);
    assert.match(setup.stdout, /VALIDATION_ERROR/);
    const status = spawnSync(process.execPath, [cli.pathname, "setup", "status"], { encoding: "utf8", env });
    assert.equal(status.status, 0, status.stdout);
    assert.equal(decode(status.stdout).auth.status, "invalid");
  }
});

test("credential validation covers all sources and CLI consumers", (t) => {
  const { XDG_CONFIG_HOME: dir } = isolateAuthEnv(t);
  const credentialsPath = join(dir, "application_default_credentials.json");
  const savedDir = join(dir, "search-console-axi");
  const savedPath = join(savedDir, "config.json");
  mkdirSync(savedDir);
  const inspection = ["inspect", "https://example.com/page", "--site", "sc-domain:example.com"];
  for (const source of ["explicit", "lowercase", "default", "env", "configured"]) {
    writeFileSync(savedPath, JSON.stringify(source === "configured" ? { serviceAccountPath: credentialsPath } : {}));
    for (const content of [
      "{",
      JSON.stringify({ type: source === "env" || source === "configured" ? "service_account" : "authorized_user" }),
    ]) {
      writeFileSync(credentialsPath, content);
      const env = {
        ...process.env,
        GOOGLE_APPLICATION_CREDENTIALS: source === "explicit" ? credentialsPath : undefined,
        google_application_credentials: source === "lowercase" ? credentialsPath : undefined,
        SEARCH_CONSOLE_AXI_SA_KEY: source === "env" ? content : undefined,
        GOOGLE_CLOUD_PROJECT: "fixture-project",
      };
      for (const args of [["setup"], ["setup", "check"], ["setup", ...inspection], inspection]) {
        const output = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8", env });
        assert.equal(output.status, 2, `${source}: ${args}: ${output.stdout}`);
        assert.match(output.stdout, /VALIDATION_ERROR/);
        assert.doesNotMatch(output.stdout, /UNKNOWN/);
      }
      for (const args of [["setup", "status"], []]) {
        const output = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8", env });
        assert.equal(output.status, 0, output.stdout);
        assert.equal(decode(output.stdout).auth.status, "invalid");
      }
    }
  }
});

test("credential shapes reject missing, empty, and mistyped fields before loading", async (t) => {
  const { XDG_CONFIG_HOME: dir } = isolateAuthEnv(t);
  const credentialsPath = join(dir, "application_default_credentials.json");
  const user = { type: "authorized_user", client_id: "client", client_secret: "secret", refresh_token: "refresh" };
  for (const valid of [user, JSON.parse(key)]) {
    const required =
      valid.type === "authorized_user"
        ? ["client_id", "client_secret", "refresh_token"]
        : ["client_email", "private_key"];
    for (const field of [...required, "private_key_id", "project_id", "quota_project_id", "universe_domain"]) {
      for (const value of [null, 42, {}, [], "", " ", ...(required.includes(field) ? [undefined] : [])]) {
        writeFileSync(credentialsPath, JSON.stringify({ ...valid, [field]: value }));
        await assert.rejects(getAuthClient(), (error) => error.code === "VALIDATION_ERROR");
      }
    }
  }
  for (const invalid of [null, [], {}, { ...user, type: "unsupported" }]) {
    writeFileSync(credentialsPath, JSON.stringify(invalid));
    await assert.rejects(getAuthClient(), (error) => error.code === "VALIDATION_ERROR");
  }
});

test("default ADC loads both supported credential kinds without guessing", async (t) => {
  const { XDG_CONFIG_HOME: dir } = isolateAuthEnv(t);
  const credentialsPath = join(dir, "application_default_credentials.json");
  for (const data of [
    JSON.parse(key),
    { type: "authorized_user", client_id: "client", client_secret: "secret", refresh_token: "refresh" },
  ]) {
    writeFileSync(credentialsPath, JSON.stringify({ ...data, quota_project_id: "fixture-project" }));
    const auth = await getAuthClient();
    assert.equal(auth.type, data.type);
    assert.equal(auth.source, "ADC");
    assert.equal(auth.quotaProjectId, "fixture-project");
    if (data.type === "service_account") {
      assert.ok(auth.client instanceof JWT);
      assert.equal(auth.client.key, privateKey);
      assert.deepEqual(auth.client.scopes, scopes);
    } else {
      assert.ok(auth.client instanceof UserRefreshClient);
      assert.equal(auth.client.credentials.refresh_token, "refresh");
    }
    const status = decode(await setupCommand(["status"]));
    assert.equal(status.auth.status, "configured");
    assert.equal(status.auth.type, data.type);
  }
});

test("missing ADC stays distinct from invalid credentials for every command", async (t) => {
  isolateAuthEnv(t);
  const options = {
    authFactory: () => ({
      getApplicationDefault: async () => {
        throw new Error("Could not load the default credentials");
      },
    }),
  };
  await assert.rejects(
    getAuthClient(options),
    (error) => error.kind === "missing-credentials" && error.code === "AUTH_CONFIG_ERROR",
  );
  for (const args of [[], ["check"], ["status"]]) {
    assert.equal(decode(await setupCommand(args, options)).auth.status, "not configured");
  }
  await assert.rejects(
    setupCommand(["inspect", "https://example.com", "--site", "sc-domain:example.com"], options),
    (error) => error.code === "AUTH_CONFIG_ERROR",
  );
});

test("quota-project setup verifies and persists the requested local value", async (t) => {
  const { XDG_CONFIG_HOME } = isolateAuthEnv(t);
  const output = decode(
    await setupCommand(["--quota-project", "fixture-project"], {
      authFactory: () => ({
        getApplicationDefault: async () => {
          throw new Error("Could not load the default credentials");
        },
      }),
    }),
  );
  assert.equal(output.setup.status, "incomplete");
  assert.deepEqual(JSON.parse(readFileSync(join(XDG_CONFIG_HOME, "search-console-axi", "config.json"), "utf8")), {
    quotaProjectId: "fixture-project",
  });
});

test("service-account setup treats malformed and invalid key contents as validation errors", (t) => {
  const { XDG_CONFIG_HOME } = isolateAuthEnv(t);
  for (const [name, content] of [
    ["malformed.json", "{"],
    ["invalid.json", "{}"],
  ]) {
    const keyPath = join(XDG_CONFIG_HOME, name);
    writeFileSync(keyPath, content);
    const result = spawnSync(process.execPath, [cli.pathname, "setup", "service-account", keyPath], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME },
    });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stdout, /VALIDATION_ERROR/);
  }
});

test("setup reports invalid credential and config input as validation errors", async (t) => {
  const { XDG_CONFIG_HOME } = isolateAuthEnv(t);
  setEnv(t, "SEARCH_CONSOLE_AXI_SA_KEY", "{}");
  await assert.rejects(setupCommand([]), (error) => error.code === "VALIDATION_ERROR");

  setEnv(t, "SEARCH_CONSOLE_AXI_SA_KEY", undefined);
  mkdirSync(join(XDG_CONFIG_HOME, "search-console-axi"), { recursive: true });
  writeFileSync(join(XDG_CONFIG_HOME, "search-console-axi", "config.json"), "{");
  await assert.rejects(setupCommand([]), (error) => error.code === "VALIDATION_ERROR");
  assert.equal(decode(await setupCommand(["status"])).auth.status, "invalid");
});

test("service-account JSON env takes precedence without persisting or printing its key", async (t) => {
  const { XDG_CONFIG_HOME: dir } = isolateAuthEnv(t);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(t, "SEARCH_CONSOLE_AXI_SA_KEY", key);
  const auth = await getAuthClient();
  assert.ok(auth.client instanceof JWT);
  assert.equal(auth.source, "SEARCH_CONSOLE_AXI_SA_KEY");
  const status = decode(await setupCommand(["status"]));
  assert.equal(status.auth.account_email, "sc-agent@example.invalid");
  assert.equal(JSON.stringify(status).includes("private_key"), false);
  assert.equal(existsSync(join(dir, "search-console-axi", "config.json")), false);
});

test("setup check is ready with Search Console access alone", async (t) => {
  isolateAuthEnv(t);
  const credential = new UserRefreshClient();
  credential.request = async ({ url }) => {
    assert.equal(url, "https://searchconsole.googleapis.com/webmasters/v3/sites");
    return { data: { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" }] } };
  };
  const output = decode(
    await setupCommand(["check"], {
      authFactory: () => ({ getApplicationDefault: async () => ({ credential, projectId: null }) }),
    }),
  );
  assert.equal(output.setup.status, "ready");
  assert.deepEqual(output.sites, [{ site_url: "sc-domain:example.com", permission: "siteRestrictedUser" }]);
});

test("empty Search Console site lists explain no resources may exist", async (t) => {
  isolateAuthEnv(t);
  const auth = mockAuth(async () => ({ data: { siteEntry: [] } }));
  const expected = "No Search Console sites visible to this account - grant access as in step 4, or none exist.";
  const home = decode(await runHome(auth));
  assert.equal(home.sites, expected);

  const credential = new UserRefreshClient();
  credential.request = async () => ({ data: { siteEntry: [] } });
  const check = decode(
    await setupCommand(["check"], {
      authFactory: () => ({ getApplicationDefault: async () => ({ credential, projectId: null }) }),
    }),
  );
  assert.match(check.setup.missing[0], /No verified Search Console sites/);
});

test("disabled Search Console APIs produce enable-project guidance for both Google error shapes", async (t) => {
  isolateAuthEnv(t);
  const failures = [
    {
      message: "API disabled",
      details: [
        {
          reason: "SERVICE_DISABLED",
          metadata: { service: "searchconsole.googleapis.com", consumer: "projects/12345" },
        },
      ],
    },
    {
      message: "Google Search Console API has not been used in project 67890 before or it is disabled",
      errors: [{ reason: "accessNotConfigured" }],
    },
  ];
  for (const [index, googleError] of failures.entries()) {
    const failRequest = async () => {
      throw Object.assign(new Error("forbidden"), { response: { status: 403, data: { error: googleError } } });
    };
    const auth = mockAuth(failRequest);
    const credential = new UserRefreshClient();
    credential.request = failRequest;
    const setup = decode(
      await setupCommand(["check"], {
        authFactory: () => ({ getApplicationDefault: async () => ({ credential, projectId: null }) }),
      }),
    );
    assert.match(setup.setup.missing[0], /Enable /);
    assert.match(setup.setup.missing[0], index === 0 ? /searchconsole\.googleapis\.com/ : /Google Search Console API/);
    assert.match(setup.setup.missing[0], index === 0 ? /12345/ : /67890/);
    const home = decode(await runHome(auth));
    assert.match(home.error, /Enable /);
    await assert.rejects(inspectUrl(auth, "https://example.com", "sc-domain:example.com"), /Enable /);
  }
});

test("ordinary Search Console 403 errors retain access-denied guidance", async (t) => {
  isolateAuthEnv(t);
  const failRequest = async () => {
    throw Object.assign(new Error("forbidden"), {
      response: { status: 403, data: { error: { message: "Insufficient Permission" } } },
    });
  };
  const auth = mockAuth(failRequest);
  const credential = new UserRefreshClient();
  credential.request = failRequest;
  const setup = decode(
    await setupCommand(["check"], {
      authFactory: () => ({ getApplicationDefault: async () => ({ credential, projectId: null }) }),
    }),
  );
  assert.match(setup.setup.missing[0], /Search Console access denied/);

  const home = decode(await runHome(auth));
  assert.match(home.error, /Search Console access denied/);
  await assert.rejects(
    inspectUrl(auth, "https://example.com", "sc-domain:example.com"),
    /Search Console access denied/,
  );
});

test("home reports Search Console queries, pages, and low-CTR opportunities", async () => {
  const calls = [];
  const auth = mockAuth(async (request) => {
    calls.push(request);
    if (request.url.endsWith("/sites")) return { data: { siteEntry: [{ siteUrl: "sc-domain:example.com" }] } };
    if (request.url.includes("searchAnalytics/query"))
      return {
        data: { rows: [{ keys: ["https://example.com/page"], clicks: 4, impressions: 500, ctr: 0.008, position: 3 }] },
      };
    throw new Error("Unexpected request");
  });
  const output = decode(await runHome(auth));
  assert.equal(output.tool, "search-console-axi");
  assert.equal(output.site, "sc-domain:example.com");
  assert.equal(output.top_queries.length, 1);
  assert.equal(output.top_pages.length, 1);
  assert.equal(output.low_ctr_opportunities.length, 1);
  assert.equal(output.totals.ctr, "0.8%");
  assert.equal(output.totals.position, 3);
  assert.equal(typeof output.totals.position, "number");
  assert.equal(output.top_queries[0].ctr, "0.8%");
  assert.equal(output.top_pages[0].position, 3);
  assert.equal(typeof output.top_pages[0].position, "number");
  assert.equal(output.low_ctr_opportunities[0].ctr, "0.8%");
  assert.equal(calls.length, 5);
  const reports = calls.filter((call) => call.url.includes("searchAnalytics/query"));
  const dates = reports.map(({ data }) => [data.startDate, data.endDate]);
  const orderedQueries = reports.filter(({ data }) => data.orderBy);
  assert.deepEqual(
    orderedQueries.map(({ data }) => [data.orderBy[0].field, data.orderBy[0].direction]).sort(),
    [
      ["clicks", "descending"],
      ["clicks", "descending"],
      ["impressions", "descending"],
    ].sort(),
  );
  assert.equal(dates.length, 4);
  assert.ok(dates.every(([start, end]) => /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)));
  assert.ok(dates.every(([start, end]) => start === dates[0][0] && end === dates[0][1]));
  assert.equal(Date.parse(`${dates[0][1]}T00:00:00Z`) - Date.parse(`${dates[0][0]}T00:00:00Z`), 6 * 86_400_000);
  const pacificToday = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  const yesterday = new Date(
    Date.UTC(Number(pacificToday.year), Number(pacificToday.month) - 1, Number(pacificToday.day)) - 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  assert.equal(dates[0][1], yesterday);
});

test("home skips unverified sites and setup check marks all-unverified accounts incomplete", async (t) => {
  isolateAuthEnv(t);
  const calls = [];
  const auth = mockAuth(async (request) => {
    calls.push(request);
    if (request.url.endsWith("/sites"))
      return {
        data: {
          siteEntry: [
            { siteUrl: "sc-domain:unverified.example", permissionLevel: "siteUnverifiedUser" },
            { siteUrl: "sc-domain:verified.example", permissionLevel: "siteRestrictedUser" },
          ],
        },
      };
    return { data: { rows: [] } };
  });
  const home = decode(await runHome(auth));
  assert.equal(home.site, "sc-domain:verified.example");
  assert.equal(home.sites, 1);
  assert.equal(calls.length, 5);

  const credential = new UserRefreshClient();
  credential.request = async () => ({
    data: { siteEntry: [{ siteUrl: "sc-domain:unverified.example", permissionLevel: "siteUnverifiedUser" }] },
  });
  const check = decode(
    await setupCommand(["check"], {
      authFactory: () => ({ getApplicationDefault: async () => ({ credential, projectId: null }) }),
    }),
  );
  assert.equal(check.setup.status, "incomplete");
  assert.match(check.setup.missing[0], /No verified Search Console sites/);
});

test("URL inspection uses the read-only index inspection endpoint", async () => {
  let seen;
  const output = decode(
    await inspectUrl(
      mockAuth(async (request) => {
        seen = request;
        return { data: { inspectionResult: { indexStatusResult: { verdict: "PASS" } } } };
      }),
      "https://example.com/page",
      "sc-domain:example.com",
    ),
  );
  assert.equal(seen.url, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
  assert.deepEqual(seen.data, {
    inspectionUrl: "https://example.com/page",
    siteUrl: "sc-domain:example.com",
    languageCode: "en-US",
  });
  assert.equal(output.indexStatusResult.verdict, "PASS");
});

test("setup rejects unsupported actions as validation errors with exit 2", (t) => {
  const env = { ...isolateAuthEnv(t) };
  const result = spawnSync(process.execPath, [cli.pathname, "setup", "hooks"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /VALIDATION_ERROR/);
  assert.match(result.stdout, /valid actions are setup, check, status, service-account, inspect, uninstall/);
});

test("missing credential files are typed actionable errors", (t) => {
  const { XDG_CONFIG_HOME: dir } = isolateAuthEnv(t);
  const path = join(dir, "missing.json");
  const savedDir = join(dir, "search-console-axi");
  mkdirSync(savedDir);
  const inspect = ["inspect", "https://example.com", "--site", "sc-domain:example.com"];
  for (const source of ["explicit", "configured"]) {
    writeFileSync(
      join(savedDir, "config.json"),
      JSON.stringify(source === "configured" ? { serviceAccountPath: path } : {}),
    );
    const env = { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: source === "explicit" ? path : undefined };
    for (const args of [
      ["setup"],
      ["setup", "check"],
      ["setup", ...inspect],
      inspect,
      ["setup", "service-account", path],
    ]) {
      const result = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8", env });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stdout, /AUTH_CONFIG_ERROR/);
      assert.match(result.stdout, /missing.json/);
      assert.match(result.stdout, /check that the file exists and is readable/i);
    }
    for (const args of [["setup", "status"], []]) {
      const result = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8", env });
      assert.equal(result.status, 0, result.stdout);
      assert.equal(decode(result.stdout).auth.status, "invalid");
    }
  }
});

test(
  "service-account setup saves exact local registration and denied writes preserve files",
  { skip: permissionDenialsUnreliable },
  (t) => {
    const dir = temp(t);
    const configHome = join(dir, "config");
    const keyPath = join(dir, "fixture.json");
    const savedDir = join(configHome, "search-console-axi");
    const configPath = join(savedDir, "config.json");
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(
      keyPath,
      JSON.stringify({
        type: "service_account",
        client_email: "fixture@example.invalid",
        private_key: "synthetic-only",
      }),
    );
    writeFileSync(configPath, '{\n  "quotaProjectId": "old-project"\n}\n');
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      SEARCH_CONSOLE_AXI_SA_KEY: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
    };
    const setup = spawnSync(process.execPath, [cli.pathname, "setup", "service-account", keyPath], {
      encoding: "utf8",
      env,
    });
    assert.equal(setup.status, 0, setup.stdout);
    const expected = { quotaProjectId: "old-project", serviceAccountPath: keyPath };
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), expected);
    const before = readFileSync(configPath, "utf8");
    chmodSync(savedDir, 0o555);
    const result = spawnSync(process.execPath, [cli.pathname, "setup", "service-account", keyPath], {
      encoding: "utf8",
      env,
    });
    chmodSync(savedDir, 0o755);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /CONFIG_ERROR/);
    assert.match(result.stdout, /writable/);
    assert.equal(readFileSync(configPath, "utf8"), before);
    chmodSync(savedDir, 0o555);
    const quota = spawnSync(process.execPath, [cli.pathname, "setup", "--quota-project", "fixture-project"], {
      encoding: "utf8",
      env,
    });
    chmodSync(savedDir, 0o755);
    assert.equal(quota.status, 1);
    assert.match(quota.stdout, /CONFIG_ERROR/);
    assert.equal(readFileSync(configPath, "utf8"), before);
  },
);

test(
  "unreadable saved config is a typed failure, not an absent registration",
  { skip: permissionDenialsUnreliable },
  (t) => {
    const dir = temp(t);
    const configDir = join(dir, "search-console-axi");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir);
    writeFileSync(configPath, '{"quotaProjectId":"fixture-project"}\n');
    chmodSync(configPath, 0);
    const result = spawnSync(process.execPath, [cli.pathname, "setup", "status"], {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: dir },
    });
    chmodSync(configPath, 0o600);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /CONFIG_ERROR/);
    assert.equal(readFileSync(configPath, "utf8"), '{"quotaProjectId":"fixture-project"}\n');
  },
);

test("uninstall verifies the saved registration is actually absent", async (t) => {
  const { XDG_CONFIG_HOME: dir } = isolateAuthEnv(t);
  assert.deepEqual(decode(await setupCommand(["uninstall"])).auth, {
    status: "not configured",
    config: "already absent",
  });
  const config = join(dir, "search-console-axi", "config.json");
  const fs = await import("node:fs");
  fs.mkdirSync(join(dir, "search-console-axi"), { recursive: true });
  writeFileSync(config, "{}\n");
  assert.deepEqual(decode(await setupCommand(["uninstall"])).auth, { status: "removed", config: "removed" });
  assert.equal(existsSync(config), false);
});
