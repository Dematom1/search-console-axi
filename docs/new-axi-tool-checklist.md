# New AXI tool checklist

Use this checklist to assess a new AXI tool. Leave items unchecked until evidence is available.

## Product and documentation

- [ ] `VISION.md` states the user, supported scope, non-goals, platforms, authentication modes, write policy, and deferred capabilities.
- [ ] README documents installation, authentication, supported commands, safety boundaries, and troubleshooting.
- [ ] `CONTRIBUTING.md` documents safe tests, contribution workflow, and release ownership.

## CLI and output

- [ ] Help is available for every command and subcommand, in the required machine-readable format.
- [ ] Invalid arguments fail before credentials or network access.
- [ ] Output uses compact, stable schemas and distinguishes unavailable data from empty results.
- [ ] Errors are actionable, structured, and use the documented exit codes.

## Authentication and data

- [ ] Credentials are resolved safely and never exposed in output or errors.
- [ ] Tests use a hermetic fake for every external API and prove requests cannot reach real services.
- [ ] Read-only operations are clearly distinguished from writes.

## P6 / Writes

- [ ] Every write is explicit, previewed, and requires deliberate confirmation.
- [ ] Every repeated/retried write is deduplicated using a stable retry key, or a documented API limitation exception is recorded below.
- [ ] Partial and unknown outcomes are reported without unsafe automatic retries.

**Documented retry-identity exception:** The Google Indexing API accepts no retry key. `indexing publish|batch --confirm` therefore has no retry key or local ledger. URL_UPDATED and URL_DELETED notifications are last-write-wins state signals. A duplicate changes only the requested URL's notification state and the last-notification times that `indexing status` reports, and it costs one quota unit (200/day default). Those times do not show whether an earlier submission succeeded. The tool refuses automatic retries, reports unknown outcomes, and directs users to `indexing status` before resubmitting.

## Delivery

- [ ] CI covers supported operating systems and Node versions.
- [ ] Packaged install and smoke behavior are tested in CI.
- [ ] Generated files are checked and protected from hand edits.
- [ ] Required checks and release automation are configured and verified.
