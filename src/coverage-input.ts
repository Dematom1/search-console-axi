import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { AxiError } from "axi-sdk-js";
import { usage } from "./args.js";

const MAX_SITEMAP_ENTRIES = 100_000;

export function validateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return usage("coverage requires absolute HTTP(S) URLs");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || /\s/.test(value))
    usage("coverage URLs must be HTTP(S), without credentials, fragments or whitespace");
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function readUrls(source: { sitemap: string } | { file: string }): Promise<string[]> {
  if ("file" in source) {
    let text: string;
    try {
      if (source.file === "-") {
        process.stdin.setEncoding("utf8");
        text = "";
        for await (const chunk of process.stdin) text += chunk;
      } else text = await readFile(source.file, "utf8");
    } catch {
      throw new AxiError("Cannot read URL input; provide a readable file or stdin.", "INPUT_ERROR");
    }
    return [
      ...new Set(
        text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map(validateUrl),
      ),
    ];
  }
  const rootOrigin = new URL(validateUrl(source.sitemap)).origin;
  const pending = [source.sitemap];
  const visited = new Set<string>();
  const urls = new Set<string>();
  let entryCount = 0;
  const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    processEntities: true,
  });
  while (pending.length) {
    const sitemap = pending.pop()!;
    if (visited.has(sitemap)) continue;
    if (visited.size >= 1000) usage("Sitemap index exceeds 1000 documents; use a URL file instead.");
    visited.add(sitemap);
    let xml: string;
    try {
      const response = await fetch(sitemap, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error();
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 52_428_800) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        size,
      );
      xml = (
        bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 52_428_800 }) : bytes
      ).toString("utf8");
    } catch {
      throw new AxiError("Cannot fetch sitemap; check its URL and network access.", "INPUT_ERROR");
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
      usage("Invalid sitemap XML (DTDs are not supported).");
    for (const match of xml.matchAll(
      /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^\s<>/:]+:)?(?:url|sitemap)(?=[\s/>])/g,
    )) {
      if (match[0].startsWith("<") && !match[0].startsWith("<!--") && !match[0].startsWith("<![CDATA[")) {
        if (++entryCount > MAX_SITEMAP_ENTRIES) usage("Sitemap exceeds 100000 total entries.");
      }
    }
    const doc = object(parser.parse(xml));
    const index = "sitemapindex" in doc;
    if (!index && !("urlset" in doc)) usage("Sitemap must contain urlset or sitemapindex.");
    const root = object(doc[index ? "sitemapindex" : "urlset"]);
    const entries = root[index ? "sitemap" : "url"];
    const list = entries === undefined ? [] : Array.isArray(entries) ? entries : [entries];
    for (const entry of list) {
      const loc = object(entry).loc;
      if (typeof loc !== "string" || !loc.trim()) usage("Every sitemap entry requires a loc URL.");
      const url = validateUrl(loc.trim());
      if (index) {
        if (new URL(url).origin !== rootOrigin) usage("Child sitemaps must share the root sitemap origin.");
        pending.push(url);
      } else urls.add(url);
    }
  }
  return [...urls];
}
