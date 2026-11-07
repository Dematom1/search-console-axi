import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCommand } from "../dist/src/auth.js";
import { test } from "node:test";
import { resolveSite } from "../dist/src/site.js";

test("site resolution prefers flag, then environment, then a stable first verified site", async (t) => {
  const previous = process.env.SEARCH_CONSOLE_AXI_SITE;
  t.after(() =>
    previous === undefined
      ? delete process.env.SEARCH_CONSOLE_AXI_SITE
      : (process.env.SEARCH_CONSOLE_AXI_SITE = previous),
  );
  const auth = {
    client: {
      request: async () => ({
        data: {
          siteEntry: [
            { siteUrl: "https://z.example/", permissionLevel: "siteOwner" },
            { siteUrl: "sc-domain:a.example", permissionLevel: "siteRestrictedUser" },
            { siteUrl: "sc-domain:unverified.example", permissionLevel: "siteUnverifiedUser" },
          ],
        },
      }),
    },
  };
  process.env.SEARCH_CONSOLE_AXI_SITE = "sc-domain:env.example";
  assert.deepEqual(await resolveSite(auth, "sc-domain:flag.example"), {
    site: "sc-domain:flag.example",
    site_source: "flag",
  });
  assert.deepEqual(await resolveSite(auth), { site: "sc-domain:env.example", site_source: "environment" });
  delete process.env.SEARCH_CONSOLE_AXI_SITE;
  const configHome = mkdtempSync(join(tmpdir(), "gsc-config-"));
  t.after(() => rmSync(configHome, { recursive: true, force: true }));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  t.after(() =>
    previousConfigHome === undefined
      ? delete process.env.XDG_CONFIG_HOME
      : (process.env.XDG_CONFIG_HOME = previousConfigHome),
  );
  await setupCommand(["site", "sc-domain:saved.example"]);
  assert.deepEqual(await resolveSite(auth), { site: "sc-domain:saved.example", site_source: "saved_config" });
  delete process.env.XDG_CONFIG_HOME;
  assert.deepEqual(await resolveSite(auth), { site: "https://z.example/", site_source: "first_verified" });
  process.env.XDG_CONFIG_HOME = configHome;
});
