import { appendFileSync, readFileSync } from "node:fs";
const scenario = JSON.parse(readFileSync(process.env.FAKE_GSC_SCENARIO, "utf8"));
const log = process.env.FAKE_LOG;
let active = 0;
let maximum = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? init.body : "";
  const target = new URL(url);
  if (
    !new Set([
      "oauth2.googleapis.com",
      "searchconsole.googleapis.com",
      "indexing.googleapis.com",
      "serviceusage.googleapis.com",
      "monitoring.googleapis.com",
    ]).has(target.hostname)
  )
    throw new Error(`Fake Google rejected unknown host: ${target.hostname}`);
  appendFileSync(log, `${JSON.stringify({ method, url, body })}\n`);
  active++;
  maximum = Math.max(maximum, active);
  try {
    const entry = scenario.responses?.find((item) => item.method === method && url.includes(item.path));
    if (target.hostname === "oauth2.googleapis.com")
      return Response.json(scenario.token ?? { access_token: "fake-token", expires_in: 3600, token_type: "Bearer" });
    if (!entry) throw new Error(`No fake response for ${method} ${url}`);
    return Response.json(entry.body ?? {}, { status: entry.status ?? 200 });
  } finally {
    active--;
  }
};
process.on("exit", () => appendFileSync(log, `${JSON.stringify({ max_concurrency: maximum })}\n`));
