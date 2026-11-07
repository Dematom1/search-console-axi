import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { commands } from "../dist/src/cli.js";

test("inspect is standalone, supports an optional site, and rejects malformed URLs before auth", () => {
  assert.equal(
    commands.some((command) => command.name === "inspect"),
    true,
  );
  const cli = new URL("../dist/bin/search-console-axi.js", import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname, "inspect", "file:///tmp/page"], {
    encoding: "utf8",
    env: { ...process.env, SEARCH_CONSOLE_AXI_SA_KEY: undefined },
  });
  assert.equal(result.status, 2);
  assert.match(decode(result.stdout).error.message, /HTTP\(S\) URL/);
  assert.doesNotMatch(result.stdout, /setup inspect/);
});
