# search-console-axi

[![CI](https://github.com/Dematom1/search-console-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/Dematom1/search-console-axi/actions/workflows/ci.yml) [![Platform: Linux and macOS](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue)](#)

Read-only Google Search Console reporting and URL inspection for agents. `search-console-axi` is an [AXI](https://github.com/kunchenguid/axi) CLI. Output uses compact [TOON](https://toonformat.dev/) format. Requires Node.js 22.12 or newer.

```sh
npm install
npm run build
node dist/bin/search-console-axi.js --help
```

## Authentication

The CLI reads credentials through `google-auth-library`. It never stores or prints OAuth tokens or service-account keys. For personal access, create your own Desktop OAuth client and configure ADC with `gcloud auth application-default login --client-id-file=client.json --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform`. Google's built-in `gcloud` OAuth client cannot grant the Search Console scope.

### Service account

1. Create or reuse a Google Cloud project and enable the Google Search Console API.
2. Create a service account; it needs no project-level IAM roles.
3. Load its JSON key from your secret manager into `SEARCH_CONSOLE_AXI_SA_KEY`. Never commit the key.
4. In Search Console, add the service-account email under **Settings > Users and permissions** with Restricted access.

For local key files, set `GOOGLE_APPLICATION_CREDENTIALS` or run `node dist/bin/search-console-axi.js setup service-account <key.json>`. Credential precedence is `SEARCH_CONSOLE_AXI_SA_KEY`, `GOOGLE_APPLICATION_CREDENTIALS` (with `google_application_credentials` as a fallback alias), the saved path configured by `setup service-account`, then user ADC. Credential files must contain `authorized_user` or `service_account` JSON; service-account registration and `SEARCH_CONSOLE_AXI_SA_KEY` require `service_account` JSON. To switch from a saved key to ADC, run `node dist/bin/search-console-axi.js setup uninstall`; this also removes the CLI's saved quota-project setting. Set the ADC quota project with `gcloud auth application-default set-quota-project <project>` or use `GOOGLE_CLOUD_QUOTA_PROJECT`.

Run `node dist/bin/search-console-axi.js setup` to check credentials and accessible sites. `node dist/bin/search-console-axi.js setup status` reports local credential configuration, not API access or token validity. It includes the credential type and available account email, never credential contents. `node dist/bin/search-console-axi.js setup uninstall` removes only the CLI's local configuration. Registration, saved quota-project updates, and removal re-read the configuration before reporting success.

Invalid setup arguments, malformed config, and malformed or unsupported credential data produce `VALIDATION_ERROR` with exit code 2. Config I/O failures produce `CONFIG_ERROR`; missing or unreadable credential-file paths produce `AUTH_CONFIG_ERROR`, both with exit code 1 and repair guidance. `setup status` instead reports invalid config or credentials as `auth.status: invalid` with exit code 0; config I/O failures remain errors. Missing credentials produce setup guidance with `auth.status: not configured` for `setup`, `setup check`, and `setup status`. The default command also reports credential status when credentials cannot be loaded.

## Read Search Console

Run `node dist/bin/search-console-axi.js` for the default site's last seven complete days of clicks, impressions, CTR, position, top queries and pages, and low-CTR opportunities. Use `node dist/bin/search-console-axi.js inspect <url> --site <site-url>` to inspect indexing for a URL. Reporting and inspection do not modify Search Console data; setup may write or remove local configuration.
