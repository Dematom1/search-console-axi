import assert from "node:assert/strict";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { indexingCommand } from "../dist/src/commands/indexing.js";

test("indexing parser supports equals values and validates every target before credentials", async () => {
  const preview = decode(await indexingCommand(["publish", "https://example.com/jobs/1", "--type=updated"]));
  assert.equal(preview.mode, "preview");
  assert.equal(preview.type, "URL_UPDATED");
  await assert.rejects(
    indexingCommand(["publish", "https://example.com/jobs/1", "--type=updated", "--type=deleted"]),
    (error) => error.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    indexingCommand(["publish", "https://example.com/jobs/1", "--type", "--confirm"]),
    (error) => error.code === "VALIDATION_ERROR",
  );
});
