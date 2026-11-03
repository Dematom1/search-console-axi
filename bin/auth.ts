import { GoogleAuth, JWT, UserRefreshClient, type AuthClient, type GoogleAuthOptions } from "google-auth-library";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { inspectUrl, runSetupCheck, setupGuide } from "./setup-check.js";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];
const NO_ADC_MESSAGE = "Could not load the default credentials";
const NO_CREDENTIALS_GUIDANCE =
  "No service-account key or user ADC is configured. Load the key JSON into SEARCH_CONSOLE_AXI_SA_KEY or configure your own Desktop OAuth client.";
const QUOTA_PROJECT_APIS = "Enable the Google Search Console API in the quota project.";
const configDir = () =>
  process.env["XDG_CONFIG_HOME"]
    ? join(process.env["XDG_CONFIG_HOME"], "search-console-axi")
    : join(homedir(), ".config", "search-console-axi");
const configFile = () => join(configDir(), "config.json");
const fail = (message: string): never => {
  throw new AxiError(message, "VALIDATION_ERROR", [
    "Run `search-console-axi setup --help` to see valid actions and options",
  ]);
};

const configError = (error: unknown, action: string): AxiError => {
  const detail = error instanceof Error ? error.message : String(error);
  return new AxiError(`Could not ${action} Search Console config at ${configFile()}: ${detail}`, "CONFIG_ERROR", [
    `Check that ${configDir()} is writable and the config file is readable, then retry`,
  ]);
};

type Config = { serviceAccountPath?: string; quotaProjectId?: string };
type JsonFailure = "read" | "parse" | "shape";
type JsonFailureHandler = (failure: JsonFailure, error: unknown) => Error;
type AuthConfigErrorKind =
  "missing-credentials" | "invalid-service-account" | "invalid-credential-file" | "invalid-credentials-path";
class AuthConfigError extends AxiError {
  constructor(
    readonly kind: AuthConfigErrorKind,
    message: string,
  ) {
    super(
      message,
      kind === "invalid-service-account" || kind === "invalid-credential-file"
        ? "VALIDATION_ERROR"
        : "AUTH_CONFIG_ERROR",
      [
        kind === "missing-credentials"
          ? NO_CREDENTIALS_GUIDANCE
          : kind === "invalid-credentials-path"
            ? "Check that the credential file exists and is readable"
            : "Provide valid authorized_user or service_account JSON credentials",
      ],
    );
  }
}
type CredentialMetadata = {
  private_key_id?: string;
  project_id?: string;
  quota_project_id?: string;
  universe_domain?: string;
};
type ServiceAccount = CredentialMetadata & {
  type: "service_account";
  client_email: string;
  private_key: string;
};
type CredentialFile =
  | ServiceAccount
  | (CredentialMetadata & {
      type: "authorized_user";
      client_id: string;
      client_secret: string;
      refresh_token: string;
    });
type CredentialKind = "authorized_user" | "service_account";
type AuthFactory = (options: GoogleAuthOptions) => Pick<GoogleAuth, "getApplicationDefault">;
type ProviderOptions = { quotaProject?: string; authFactory?: AuthFactory; scopes?: string[] };
export type AuthProvider = {
  client: AuthClient;
  type: CredentialKind;
  source: "SEARCH_CONSOLE_AXI_SA_KEY" | "GOOGLE_APPLICATION_CREDENTIALS" | "service-account-path" | "ADC";
  email?: string;
  quotaProjectId?: string;
  projectId?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJsonFile<T>(
  path: string,
  isValid: (value: unknown) => value is T,
  onFailure: JsonFailureHandler,
  optional = false,
): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (optional && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw onFailure("read", error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw onFailure("parse", error);
  }
  if (!isValid(value)) throw onFailure("shape", new Error("JSON does not match the expected format"));
  return value;
}

function isConfig(value: unknown): value is Config {
  return (
    isObject(value) &&
    (!("serviceAccountPath" in value) || typeof value.serviceAccountPath === "string") &&
    (!("quotaProjectId" in value) || typeof value.quotaProjectId === "string")
  );
}

function readConfig(): Config {
  const config = readJsonFile(
    configFile(),
    isConfig,
    (failure, error) => {
      if (failure === "read") return configError(error, "read");
      return new AxiError(
        `Config file ${configFile()} contains invalid ${failure === "parse" ? "JSON" : "format"}`,
        "VALIDATION_ERROR",
        ["Repair or remove the invalid config file"],
      );
    },
    true,
  );
  return config ?? {};
}

function saveConfig(config: Config): void {
  const path = configFile();
  const temporaryFile = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporaryFile, path);
  } catch (error) {
    try {
      unlinkSync(temporaryFile);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT"))
        throw configError(cleanupError, "clean up temporary");
    }
    throw configError(error, "write");
  }
}

function isCredentialFile(value: unknown): value is CredentialFile {
  if (!isObject(value)) return false;
  const required =
    value.type === "service_account"
      ? ["client_email", "private_key"]
      : value.type === "authorized_user"
        ? ["client_id", "client_secret", "refresh_token"]
        : undefined;
  if (!required) return false;
  return (
    required.every((field) => typeof value[field] === "string" && value[field].trim().length > 0) &&
    ["private_key_id", "project_id", "quota_project_id", "universe_domain"].every(
      (field) => !(field in value) || (typeof value[field] === "string" && value[field].trim().length > 0),
    )
  );
}

function isServiceAccountFile(value: unknown): value is ServiceAccount {
  return isCredentialFile(value) && value.type === "service_account";
}

function readServiceAccount(path: string, source: string): ServiceAccount {
  const data = readJsonFile(path, isServiceAccountFile, (failure) =>
    failure === "read"
      ? new AuthConfigError(
          "invalid-credentials-path",
          `${source} at ${path} is unreadable; check that the file exists and is readable`,
        )
      : new AuthConfigError(
          "invalid-service-account",
          `${source} at ${path} is not a valid Google service-account key`,
        ),
  );
  if (!data) throw new AuthConfigError("invalid-service-account", `${source} at ${path} is invalid`);
  return data;
}

export async function getAuthClient(options: ProviderOptions = {}): Promise<AuthProvider> {
  const config = readConfig();
  const serviceAccountJson = process.env["SEARCH_CONSOLE_AXI_SA_KEY"];
  const credentialsPath =
    process.env["GOOGLE_APPLICATION_CREDENTIALS"] ?? process.env["google_application_credentials"];
  const configuredPath = config.serviceAccountPath;
  let fileCredentials: CredentialFile | undefined;
  if (serviceAccountJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serviceAccountJson);
    } catch {
      throw new AuthConfigError(
        "invalid-service-account",
        "SEARCH_CONSOLE_AXI_SA_KEY must contain valid service-account JSON",
      );
    }
    if (!isServiceAccountFile(parsed))
      throw new AuthConfigError(
        "invalid-service-account",
        "SEARCH_CONSOLE_AXI_SA_KEY does not contain a valid Google service-account key",
      );
    fileCredentials = parsed;
  } else if (credentialsPath === undefined && configuredPath) {
    fileCredentials = readServiceAccount(configuredPath, "Configured service-account key file");
  } else {
    if (credentialsPath === "")
      throw new AuthConfigError("invalid-credentials-path", "GOOGLE_APPLICATION_CREDENTIALS must not be empty");
    const adcDir =
      process.env["CLOUDSDK_CONFIG"] ||
      (process.platform === "win32"
        ? process.env["APPDATA"] && join(process.env["APPDATA"], "gcloud")
        : process.env["HOME"] && join(process.env["HOME"], ".config", "gcloud"));
    const path = credentialsPath ?? (adcDir ? join(adcDir, "application_default_credentials.json") : undefined);
    if (path) {
      const source =
        credentialsPath === undefined ? "Application Default Credentials" : "GOOGLE_APPLICATION_CREDENTIALS";
      fileCredentials = readJsonFile(
        path,
        isCredentialFile,
        (failure) =>
          failure === "read"
            ? new AuthConfigError(
                "invalid-credentials-path",
                `Could not read ${source} at ${path}; check that the file exists and is readable`,
              )
            : new AuthConfigError(
                "invalid-credential-file",
                `${source} at ${path} contains invalid JSON or credential data; use authorized_user or service_account credentials`,
              ),
        credentialsPath === undefined,
      );
    }
  }
  const source =
    serviceAccountJson !== undefined
      ? "SEARCH_CONSOLE_AXI_SA_KEY"
      : credentialsPath
        ? "GOOGLE_APPLICATION_CREDENTIALS"
        : configuredPath
          ? "service-account-path"
          : "ADC";
  const quotaOverride = options.quotaProject ?? process.env["GOOGLE_CLOUD_QUOTA_PROJECT"] ?? config.quotaProjectId;
  if (fileCredentials) {
    const credential =
      fileCredentials.type === "service_account"
        ? new JWT({
            email: fileCredentials.client_email,
            key: fileCredentials.private_key,
            keyId: fileCredentials.private_key_id,
            projectId: fileCredentials.project_id,
            universeDomain: fileCredentials.universe_domain,
            scopes: options.scopes ?? SCOPES,
          })
        : new UserRefreshClient({
            clientId: fileCredentials.client_id,
            clientSecret: fileCredentials.client_secret,
            refreshToken: fileCredentials.refresh_token,
            universeDomain: fileCredentials.universe_domain,
          });
    credential.quotaProjectId = quotaOverride ?? fileCredentials.quota_project_id;
    return {
      client: credential,
      type: fileCredentials.type,
      source,
      ...(fileCredentials.type === "service_account" ? { email: fileCredentials.client_email } : {}),
      ...(credential.quotaProjectId ? { quotaProjectId: credential.quotaProjectId } : {}),
      ...(fileCredentials.project_id ? { projectId: fileCredentials.project_id } : {}),
    };
  }
  const auth = (options.authFactory ?? ((opts) => new GoogleAuth(opts)))({
    scopes: options.scopes ?? SCOPES,
    ...(quotaOverride ? { clientOptions: { quotaProjectId: quotaOverride } } : {}),
  });
  let credential: AuthClient;
  let projectId: string | null;
  try {
    ({ credential, projectId } = await auth.getApplicationDefault());
  } catch (error) {
    if (error instanceof Error && error.message.includes(NO_ADC_MESSAGE))
      throw new AuthConfigError("missing-credentials", "Google Application Default Credentials are not configured");
    throw error;
  }
  if (quotaOverride) credential.quotaProjectId = quotaOverride;
  if (credential instanceof UserRefreshClient)
    return {
      client: credential,
      type: "authorized_user",
      source,
      ...((quotaOverride ?? credential.quotaProjectId)
        ? { quotaProjectId: quotaOverride ?? credential.quotaProjectId }
        : {}),
      ...(projectId ? { projectId } : {}),
    };
  if (credential instanceof JWT)
    return {
      client: credential,
      type: "service_account",
      source,
      ...(credential.email ? { email: credential.email } : {}),
      ...((quotaOverride ?? credential.quotaProjectId)
        ? { quotaProjectId: quotaOverride ?? credential.quotaProjectId }
        : {}),
      ...(projectId ? { projectId } : {}),
    };
  throw new AuthConfigError(
    "invalid-credential-file",
    "Unsupported Google credentials type; use authorized_user or service_account credentials",
  );
}

function setupGuideOutput(missing: string[]): string {
  return result({ auth: { status: "not configured" }, setup: { status: "incomplete", missing, guide: setupGuide } });
}

function invalidAuthOutput(message: string, type?: string): string {
  return result({
    auth: { status: "invalid", ...(type ? { type } : {}), error: message },
    setup: { status: "incomplete", missing: [message], guide: setupGuide },
  });
}

async function setupWithChecks(options: ProviderOptions): Promise<string> {
  try {
    const auth = await getAuthClient(options);
    return runSetupCheck(auth);
  } catch (error) {
    if (error instanceof AuthConfigError && error.kind === "missing-credentials")
      return setupGuideOutput([NO_CREDENTIALS_GUIDANCE]);
    throw error;
  }
}

function result(data: object): string {
  return encode(data);
}

async function authStatus(quotaProject?: string, providerOptions: ProviderOptions = {}): Promise<string> {
  try {
    const auth = await getAuthClient({ ...providerOptions, quotaProject });
    const help =
      auth.type === "authorized_user" && !auth.quotaProjectId
        ? [
            "Set a quota project with `gcloud auth application-default set-quota-project <project>`.",
            QUOTA_PROJECT_APIS,
          ]
        : [];
    return result({
      auth: {
        status: "configured",
        type: auth.type,
        source: auth.source,
        ...(auth.email ? { account_email: auth.email } : {}),
        quota_project: auth.quotaProjectId ?? "none",
      },
      help,
    });
  } catch (error) {
    if (error instanceof AuthConfigError && error.kind === "missing-credentials")
      return setupGuideOutput([NO_CREDENTIALS_GUIDANCE]);
    if (error instanceof AuthConfigError)
      return invalidAuthOutput(error.message, error.kind === "invalid-service-account" ? "service_account" : undefined);
    if (error instanceof AxiError && error.code === "VALIDATION_ERROR") return invalidAuthOutput(error.message);
    throw error;
  }
}

export async function setupCommand(args: string[], providerOptions: ProviderOptions = {}): Promise<string> {
  const [first, ...rest] = args;
  if (first === "--help" || first === "-h")
    return "usage: search-console-axi setup [--quota-project <project>] | check | status | service-account <key.json> | uninstall\n";
  const implicitSetup = !first || first.startsWith("-");
  const action = implicitSetup ? "setup" : first;
  const operands = implicitSetup ? args : rest;
  let quotaProject: string | undefined;
  let siteUrl: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < operands.length; index++) {
    const value = operands[index];
    if (value === "--quota-project") {
      const next = operands[++index];
      if (!next || next.startsWith("-")) fail("--quota-project requires a project ID");
      quotaProject = next;
    } else if (value === "--site") {
      const next = operands[++index];
      if (!next || next.startsWith("-")) fail("--site requires a Search Console site URL");
      siteUrl = next;
    } else if (value?.startsWith("-")) {
      fail(`unknown setup option '${value}'`);
    } else if (value) positionals.push(value);
  }

  if (action === "status") {
    if (positionals.length || siteUrl) fail("usage: search-console-axi setup status [--quota-project <project>]");
    return authStatus(quotaProject, providerOptions);
  }
  if (action === "uninstall") {
    if (positionals.length || quotaProject || siteUrl) fail("usage: search-console-axi setup uninstall");
    try {
      unlinkSync(configFile());
      const verified = readConfig();
      if (verified.serviceAccountPath || verified.quotaProjectId)
        throw configError(new Error("saved registration remains after removal"), "verify removal of");
      return result({ auth: { status: "removed", config: "removed" } });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return result({ auth: { status: "not configured", config: "already absent" } });
      throw error instanceof AxiError ? error : configError(error, "remove");
    }
  }
  if (action === "service-account") {
    if (siteUrl) fail("--site is only valid with inspect");
    const [path] = positionals;
    if (positionals.length !== 1 || !path)
      return fail("usage: search-console-axi setup service-account <key.json> [--quota-project <project>]");
    const key = readServiceAccount(path, "Service-account key file");
    const saved = {
      ...readConfig(),
      serviceAccountPath: resolve(path),
      ...(quotaProject ? { quotaProjectId: quotaProject } : {}),
    };
    saveConfig(saved);
    const verified = readConfig();
    if (verified.serviceAccountPath !== saved.serviceAccountPath || verified.quotaProjectId !== saved.quotaProjectId)
      throw configError(new Error("saved registration does not match requested values"), "verify saved");
    return result({ auth: { status: "configured", type: "service_account", account_email: key.client_email } });
  }
  if (action === "check") {
    if (positionals.length || siteUrl) fail("usage: search-console-axi setup check");
    return setupWithChecks({ ...providerOptions, ...(quotaProject ? { quotaProject } : {}) });
  }
  if (action === "inspect") {
    if (positionals.length !== 1 || !positionals[0] || !siteUrl)
      fail("usage: search-console-axi setup inspect <url> --site <site>");
    const auth = await getAuthClient({ ...providerOptions, ...(quotaProject ? { quotaProject } : {}) });
    return inspectUrl(auth, positionals[0]!, siteUrl!);
  }
  if (action !== "setup")
    fail(
      `unknown setup action '${action}'; valid actions are setup, check, status, service-account, inspect, uninstall`,
    );
  if (positionals.length || siteUrl) fail("usage: search-console-axi setup [--quota-project <project>]");
  if (quotaProject) {
    saveConfig({ ...readConfig(), quotaProjectId: quotaProject });
    if (readConfig().quotaProjectId !== quotaProject)
      throw configError(new Error("saved quota project does not match requested value"), "verify saved");
  }
  return setupWithChecks({ ...providerOptions, ...(quotaProject ? { quotaProject } : {}) });
}
