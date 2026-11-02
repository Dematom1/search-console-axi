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
class AuthConfigError extends Error {
  constructor(
    readonly kind: AuthConfigErrorKind,
    message: string,
  ) {
    super(message);
  }
}
type ServiceAccount = {
  type: "service_account";
  client_email: string;
  private_key: string;
  project_id?: string;
  quota_project_id?: string;
};
type CredentialKind = "authorized_user" | "service_account";
type AuthFactory = (options: GoogleAuthOptions) => Pick<GoogleAuth, "getApplicationDefault" | "getClient">;
type ProviderOptions = { quotaProject?: string; authFactory?: AuthFactory };
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

function parseServiceAccount(data: unknown): ServiceAccount | undefined {
  if (
    !data ||
    typeof data !== "object" ||
    !("type" in data) ||
    data.type !== "service_account" ||
    !("client_email" in data) ||
    typeof data.client_email !== "string" ||
    !data.client_email.trim() ||
    !("private_key" in data) ||
    typeof data.private_key !== "string" ||
    !data.private_key.trim()
  )
    return undefined;
  return {
    type: "service_account",
    client_email: data.client_email,
    private_key: data.private_key,
    ...("project_id" in data && typeof data.project_id === "string" ? { project_id: data.project_id } : {}),
    ...("quota_project_id" in data && typeof data.quota_project_id === "string"
      ? { quota_project_id: data.quota_project_id }
      : {}),
  };
}

function isServiceAccountFile(value: unknown): value is Record<string, unknown> {
  return parseServiceAccount(value) !== undefined;
}

function isCredentialFile(value: unknown): value is Record<string, unknown> {
  return isObject(value) && typeof value["type"] === "string" && value["type"].length > 0;
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
  const key = data && parseServiceAccount(data);
  if (!key) throw new AuthConfigError("invalid-service-account", `${source} at ${path} is invalid`);
  return key;
}

export async function getAuthClient(options: ProviderOptions = {}): Promise<AuthProvider> {
  const config = readConfig();
  const serviceAccountJson = process.env["SEARCH_CONSOLE_AXI_SA_KEY"];
  const credentialsPath = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
  const configuredPath = config.serviceAccountPath;
  let serviceAccount: ServiceAccount | undefined;
  if (serviceAccountJson !== undefined) {
    try {
      serviceAccount = parseServiceAccount(JSON.parse(serviceAccountJson));
    } catch {
      throw new AuthConfigError(
        "invalid-service-account",
        "SEARCH_CONSOLE_AXI_SA_KEY must contain valid service-account JSON",
      );
    }
    if (!serviceAccount)
      throw new AuthConfigError(
        "invalid-service-account",
        "SEARCH_CONSOLE_AXI_SA_KEY does not contain a valid Google service-account key",
      );
  } else if (credentialsPath !== undefined) {
    if (!credentialsPath)
      throw new AuthConfigError("invalid-credentials-path", "GOOGLE_APPLICATION_CREDENTIALS must not be empty");
    readJsonFile(credentialsPath, isCredentialFile, (failure) =>
      failure === "read"
        ? new AuthConfigError(
            "invalid-credentials-path",
            `Could not read GOOGLE_APPLICATION_CREDENTIALS at ${credentialsPath}; check that the file exists and is readable`,
          )
        : new AuthConfigError(
            "invalid-credential-file",
            `GOOGLE_APPLICATION_CREDENTIALS at ${credentialsPath} contains invalid JSON or credential data`,
          ),
    );
  } else if (configuredPath) {
    serviceAccount = readServiceAccount(configuredPath, "Configured service-account key file");
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
  if (serviceAccount) {
    const credential = new JWT({ email: serviceAccount.client_email, key: serviceAccount.private_key, scopes: SCOPES });
    credential.quotaProjectId = quotaOverride ?? serviceAccount.quota_project_id;
    return {
      client: credential,
      type: "service_account",
      source,
      email: serviceAccount.client_email,
      ...(credential.quotaProjectId ? { quotaProjectId: credential.quotaProjectId } : {}),
      ...(serviceAccount.project_id ? { projectId: serviceAccount.project_id } : {}),
    };
  }
  const auth = (options.authFactory ?? ((opts) => new GoogleAuth(opts)))({
    scopes: SCOPES,
    ...(credentialsPath ? { keyFile: credentialsPath } : {}),
    ...(quotaOverride ? { clientOptions: { quotaProjectId: quotaOverride } } : {}),
  });
  let credential: AuthClient;
  let projectId: string | null;
  try {
    ({ credential, projectId } = await auth.getApplicationDefault());
  } catch (error) {
    if (error instanceof Error && error.message.includes(NO_ADC_MESSAGE))
      throw new AuthConfigError("missing-credentials", "Google Application Default Credentials are not configured");
    if (credentialsPath)
      throw new AuthConfigError(
        "invalid-credential-file",
        `GOOGLE_APPLICATION_CREDENTIALS at ${credentialsPath} contains unsupported or invalid credential data`,
      );
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
  throw new Error("Unsupported Google credentials type; use authorized_user or service_account credentials");
}

function setupGuideOutput(missing: string[], status = "not configured"): string {
  return result({ auth: { status }, setup: { status: "incomplete", missing, guide: setupGuide } });
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
    if (error instanceof AuthConfigError && error.kind === "invalid-credentials-path")
      throw new AxiError(error.message, "AUTH_CONFIG_ERROR", ["Check that the credential file exists and is readable"]);
    if (error instanceof AuthConfigError && error.kind === "invalid-credential-file")
      throw new AxiError(error.message, "VALIDATION_ERROR", [
        "Check that the credential file contains valid Google credentials",
      ]);
    if (error instanceof AuthConfigError && error.kind === "invalid-service-account")
      throw new AxiError(error.message, "VALIDATION_ERROR", [
        "Check that the service-account key contains valid Google service-account credentials",
      ]);
    if (error instanceof AuthConfigError) return setupGuideOutput([error.message], "invalid");
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
    let key: ServiceAccount;
    try {
      key = readServiceAccount(path, "Service-account key file");
    } catch (error) {
      if (error instanceof AuthConfigError && error.kind === "invalid-service-account")
        throw new AxiError(error.message, "VALIDATION_ERROR", [
          "Check that the key file contains valid Google service-account credentials",
        ]);
      if (error instanceof AuthConfigError)
        throw new AxiError(error.message, "AUTH_CONFIG_ERROR", ["Check that the key file exists and is readable"]);
      throw error;
    }
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
