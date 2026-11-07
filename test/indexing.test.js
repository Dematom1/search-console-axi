import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../dist/src/args.js";

test("indexing arguments support equals values and dash positionals", () => {
  assert.deepEqual(parseArgs(["--type=updated", "-"], ["--type"]), {
    positionals: ["-"],
    flags: new Map([["--type", "updated"]]),
  });
});
