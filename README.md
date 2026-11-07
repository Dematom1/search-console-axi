# search-console-axi

[![CI](https://github.com/Dematom1/search-console-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/Dematom1/search-console-axi/actions/workflows/ci.yml) [![Platform: Linux and macOS](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue)](#) [![npm weekly downloads](https://img.shields.io/npm/dw/search-console-axi)](https://www.npmjs.com/package/search-console-axi)

Google Search Console reporting, URL inspection, and preview-gated Indexing API notifications for agents. `search-console-axi` is an [AXI](https://github.com/kunchenguid/axi) CLI. Output uses compact [TOON](https://toonformat.dev/) format. Requires Node.js 22.12 or newer.

```sh
npm i -g search-console-axi
search-console-axi --help
```

## Authentication

The CLI validates credential JSON locally and authenticates through `google-auth-library`. It never stores or prints OAuth tokens or service-account keys. For personal access, create your own Desktop OAuth client and configure ADC with `gcloud auth application-default login --client-id-file=client.json --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform`. Google's built-in `gcloud` OAuth client cannot grant the Search Console scope.

### Service account

1. Create or reuse a Google Cloud project and enable the Google Search Console API.
2. Create a service account; it needs no project-level IAM roles.
3. Load its JSON key from your secret manager into `SEARCH_CONSOLE_AXI_SA_KEY`. Never commit the key.
4. In Search Console, add the service-account email under **Settings > Users and permissions** with Restricted access.

For local key files, set `GOOGLE_APPLICATION_CREDENTIALS` or run `search-console-axi setup service-account <key.json>`. Credential precedence is `SEARCH_CONSOLE_AXI_SA_KEY`, `GOOGLE_APPLICATION_CREDENTIALS` (with `google_application_credentials` as a fallback alias), the saved path configured by `setup service-account`, then user ADC. Credential files must contain `authorized_user` or `service_account` JSON; service-account registration and `SEARCH_CONSOLE_AXI_SA_KEY` require `service_account` JSON. To switch from a saved key to ADC, run `search-console-axi setup uninstall`; this also removes the CLI's saved quota-project setting. Set the ADC quota project with `gcloud auth application-default set-quota-project <project>` or use `GOOGLE_CLOUD_QUOTA_PROJECT`.

Run `search-console-axi setup` to check credentials and accessible sites. `search-console-axi setup status` reports local credential configuration, not API access or token validity. It includes the credential type and available account email, never credential contents. `search-console-axi setup uninstall` removes only the CLI's local configuration. Registration, saved quota-project updates, and removal re-read the configuration before reporting success.

Invalid setup arguments, malformed config, and malformed or unsupported credential data produce `VALIDATION_ERROR` with exit code 2. Config I/O failures produce `CONFIG_ERROR`; missing or unreadable credential-file paths produce `AUTH_CONFIG_ERROR`, both with exit code 1 and repair guidance. `setup status` instead reports invalid config or credentials as `auth.status: invalid` with exit code 0; config I/O failures remain errors. Missing credentials produce setup guidance with `auth.status: not configured` for `setup`, `setup check`, and `setup status`. The default command also reports credential status when credentials cannot be loaded.

## Read Search Console

Run `search-console-axi` for the default site's last seven complete days of clicks, impressions, CTR, position, top queries and pages, and low-CTR opportunities. Use `search-console-axi inspect <url> --site <site-url>` to inspect indexing for a URL. Reporting and inspection do not modify Search Console data; setup may write or remove local configuration.

## Send Indexing API notifications

Google supports the [Indexing API](https://developers.google.com/search/apis/indexing-api/v3/using-api) only for pages with `JobPosting` or `BroadcastEvent` embedded in `VideoObject` structured data. Job-posting pages fit this scope. It is not a general-purpose indexing API. A successful submission acknowledges a notification, not a crawl or index guarantee.

Enable the Indexing API in your Google Cloud project. The service account must be an **owner** of the Search Console property, not merely a Restricted or Full user. The same credential precedence and local configuration apply. Notification commands request `https://www.googleapis.com/auth/indexing`; reporting still requests only `webmasters.readonly`. For user ADC, reauthorize your own Desktop OAuth client with the indexing scope as well as the reporting scopes above. Existing refresh tokens cannot gain scopes automatically.

```sh
search-console-axi indexing publish https://example.com/jobs/1 --type updated
search-console-axi indexing publish https://example.com/jobs/1 --type updated --confirm
search-console-axi indexing publish https://example.com/jobs/1 --type deleted
search-console-axi indexing status https://example.com/jobs/1
search-console-axi indexing batch urls.txt --type updated
search-console-axi indexing batch - --type deleted --confirm < urls.txt
search-console-axi indexing quota
```

`publish` and `batch` are local previews until `--confirm`. Previews list every explicit URL target, the notification count, and the HTTP request count without loading credentials or calling Google. Batch input contains one absolute HTTP or HTTPS URL per line; blank lines are ignored. Duplicate URLs remain separate requests. URLs with embedded credentials, fragments, or whitespace are rejected. All input is validated before any submission. Each multipart batch contains at most 100 notifications, and each notification consumes quota separately.

Before `--type deleted`, the page must return HTTP 404 or 410 or contain a `noindex` directive. `status` reads `urlNotifications.getMetadata`: the last notification times, not the page's indexing status. Use `inspect` for index status.

Confirmed batches report every URL as `submitted`, `failed`, or `unknown`, with an HTTP status where available. Any failed or unknown result sets exit code 1. Authentication, API, and transport errors omit raw server messages and credential contents. A 403 explains the owner, API enablement, and scope requirements; a 429 explains quota exhaustion. Requests are not automatically retried. An unknown outcome may already have reached Google; check notification status before retrying. Successful URLs in a partially failed batch must not be resubmitted blindly.

### Read project quota

The Indexing API has no usage endpoint. `indexing quota` reads effective limits from Service Usage and today's observed request counts from Cloud Monitoring. The selected project is the configured quota project sent with requests, or the credential's `project_id` if no override exists. The output identifies that project and the source. User ADC without either project requires `setup --quota-project <project>`.

Quota reads request `cloud-platform.read-only` and `monitoring.read` OAuth scopes. User ADC with `cloud-platform` also supports both endpoints. Limits require `serviceusage.quotas.get`; usage requires `monitoring.timeSeries.list` on the selected project. These optional IAM permissions are separate from Search Console ownership. The Service Usage and Cloud Monitoring APIs must be enabled.

Usage covers midnight Pacific Time through the query time. Counts include completed requests and failures, grouped by API method, and may lag up to 30 minutes. These are observed requests, not authoritative daily publish quota consumption. Empty time series mean unknown, not zero. Unreadable limits or usage identify the required permission rather than inventing a number. A readable half remains available if the other fails.

The [documented defaults](https://developers.google.com/search/apis/indexing-api/v3/quota-pricing) are labelled separately: 200 publish requests per day, 180 metadata requests per minute, and 380 total requests per minute. They are not reported as your project's actual limit or remaining allowance.
