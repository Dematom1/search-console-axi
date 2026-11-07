# Vision

## User

Search Console users and agents who need a safe, compact CLI for inspecting site performance, sitemaps, URL indexing, and eligible Indexing API notifications.

## Scope

The tool supports Search Console performance, sitemaps, URL inspection, and Indexing API notifications for JobPosting and BroadcastEvent pages only.

It runs on Linux and macOS. Authentication modes are service-account environment variables, `_FILE` and `_COMMAND` credential sources, `GOOGLE_APPLICATION_CREDENTIALS`, a saved service-account path, and user ADC.

Indexing writes are preview-first and require `--confirm`. Each write names explicit per-URL targets. The CLI does not automatically retry writes and reports unknown outcomes so users can check `indexing status` before resubmitting.

The Indexing API accepts no retry key. URL_UPDATED and URL_DELETED notifications are last-write-wins state signals, so a duplicate has no other effect and costs one quota unit (200 requests per day by default). No local ledger or retry-key flag is planned.

## Non-goals

- GA4 analytics.
- Sitemap submission.
- General-purpose indexing notifications.
- Discover or News indexing at launch.

## Deferred

Additional Google Search Console capabilities are deferred until a concrete user need and a safe, testable contract are established.
