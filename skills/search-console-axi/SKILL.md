---
name: search-console-axi
description: See which Google Search Console queries and pages drive clicks, find low-CTR opportunities, read or safely submit sitemaps, check whether a URL is indexed, and safely notify Google about job-posting pages (preview before submit).
---

# search-console-axi

Use `search-console-axi` for Google Search Console reporting, URL inspection, and preview-gated Indexing API notifications. Output is compact TOON. See the [README](https://github.com/Dematom1/search-console-axi/blob/main/README.md#authentication) for authentication setup.

If `search-console-axi` is not installed globally (`command -v search-console-axi` finds nothing), prefix every command below with `npx -y`, for example `npx -y search-console-axi setup`.

Run `search-console-axi` for the default site's clicks, impressions, CTR, average position, top queries/pages, and low-CTR opportunities. Run `search-console-axi setup` to check access. Run `search-console-axi inspect <url>` to inspect index status; `--site` is optional. See the [README usage guide](https://github.com/Dematom1/search-console-axi/blob/main/README.md#read-search-console) for site selection.

Run `search-console-axi sitemaps list [--site <property>]` for submitted sitemaps and `sitemaps get <sitemap-url>` for one. Output includes last-read dates, pending/error-derived status, errors/warnings and per-content-type submitted counts (discovered pages); indexed counts are deprecated, and missing fields are unknown, not zero. `search-console-axi sitemaps submit <sitemap-url> --site <exact-property>` previews without credentials; add `--confirm` to submit. Submission requires the `https://www.googleapis.com/auth/webmasters` scope and property write permissions. Read-only ADC must be explicitly reauthorized, never silently widened.

Run `search-console-axi indexing --help` for notification commands. `search-console-axi indexing publish <url> --type updated|deleted` and `search-console-axi indexing batch <file|-> --type updated|deleted` preview every URL until `--confirm`. Only pages with JobPosting or BroadcastEvent embedded in VideoObject structured data qualify. Service accounts must own the Search Console property. `search-console-axi indexing status <url>` reads notification receipt metadata, not index status. `search-console-axi indexing quota` reports readable project limits and observed requests today, with permission guidance when unavailable.

See the [README authentication guide](https://github.com/Dematom1/search-console-axi/blob/main/README.md#authentication) for credential setup and security guidance.
