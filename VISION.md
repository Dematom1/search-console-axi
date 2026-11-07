# Vision

## User

Search Console users and agents who need a safe, compact CLI for inspecting site performance, sitemaps, URL indexing, and eligible Indexing API notifications.

## Scope

The target scope includes Search Console performance, sitemaps, URL inspection, and Indexing API notifications for JobPosting pages and BroadcastEvent markup embedded in VideoObject only. Sitemap inspection is not implemented yet.

It runs on Linux and macOS. Implemented authentication sources are `SEARCH_CONSOLE_AXI_SA_KEY`, `GOOGLE_APPLICATION_CREDENTIALS` (including its lowercase alias), a saved service-account path, and user ADC. `_FILE` and `_COMMAND` credential sources are planned for SC-3.

Indexing writes are preview-first and require `--confirm`. Each write names explicit per-URL targets. The CLI does not automatically retry writes and reports unknown outcomes so users can check `indexing status` before resubmitting.

The Indexing API accepts no retry key. URL_UPDATED and URL_DELETED notifications are last-write-wins state signals. A duplicate changes only the requested URL's notification state and the last-notification times that `indexing status` reports, and it costs one quota unit (200 requests per day by default). Those times do not show whether an earlier submission succeeded. No local ledger or retry-key flag is planned.

## Non-goals

- GA4 analytics.
- Sitemap submission.
- General-purpose indexing notifications.
- Discover or News indexing at launch.

## Deferred

Additional Google Search Console capabilities are deferred until a concrete user need and a safe, testable contract are established.
