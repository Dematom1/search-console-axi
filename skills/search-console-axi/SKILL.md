---
name: search-console-axi
description: Read Google Search Console performance, inspect URL indexing, or submit job-page Indexing API notifications.
---

# search-console-axi

Use `search-console-axi` for Google Search Console reporting, URL inspection, and preview-gated Indexing API notifications. Output is compact TOON. See the [README](../../README.md#authentication) for authentication setup.

Run `search-console-axi` for the default site's clicks, impressions, CTR, average position, top queries/pages, and low-CTR opportunities. Run `search-console-axi setup` to check access. Run `search-console-axi inspect <url>` to inspect index status; `--site` is optional. See the [README usage guide](../../README.md#read-search-console) for site selection.

Run `search-console-axi indexing --help` for notification commands. `indexing publish <url> --type updated|deleted` and `indexing batch <file|-> --type updated|deleted` preview every URL until `--confirm`. Only pages with JobPosting or BroadcastEvent embedded in VideoObject structured data qualify. Service accounts must own the Search Console property. `indexing status <url>` reads notification receipt metadata, not index status. `indexing quota` reports readable project limits and observed requests today, with permission guidance when unavailable.

See the [README authentication guide](../../README.md#authentication) for credential setup and security guidance.
