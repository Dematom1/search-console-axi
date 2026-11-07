import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBatch } from "../dist/src/commands/indexing.js";

const response = (id, status, body) =>
  `--response_boundary\r\nContent-Type: application/http\r\nContent-ID: <response-item-${id}>\r\n\r\nHTTP/1.1 ${status} Result\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n`;

test("batch parser marks malformed, duplicate, and missing results unknown", () => {
  const urls = ["https://example.com/1", "https://example.com/2"];
  assert.deepEqual(
    parseBatch("bad", "text/plain", urls).map((item) => item.status),
    ["unknown", "unknown"],
  );
  const duplicate = response(0, 200, {}) + response(0, 200, {});
  assert.deepEqual(
    parseBatch(`${duplicate}--response_boundary--\r\n`, "multipart/mixed; boundary=response_boundary", urls).map(
      (item) => item.status,
    ),
    ["unknown", "unknown"],
  );
});

test("batch parser preserves per-target success and HTTP failure", () => {
  const urls = ["https://example.com/1", "https://example.com/2"];
  const body =
    response(1, 403, { error: { message: "denied" } }) +
    response(0, 200, { urlNotificationMetadata: { latestUpdate: { type: "URL_UPDATED" } } }) +
    "--response_boundary--\r\n";
  const result = parseBatch(body, "multipart/mixed; boundary=response_boundary", urls);
  assert.deepEqual(
    result.map((item) => item.status),
    ["submitted", "failed"],
  );
  assert.equal(result[0].latest_update.type, "URL_UPDATED");
  assert.equal(result[1].http_status, 403);
});
