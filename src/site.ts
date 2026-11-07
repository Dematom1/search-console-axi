import { savedDefaultSite } from "./auth.js";
import type { AuthProvider } from "./auth.js";

const sitesUrl = "https://searchconsole.googleapis.com/webmasters/v3/sites";
const verifiedPermissions = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);
export async function resolveSite(auth: AuthProvider, flag?: string): Promise<{ site: string; site_source: string }> {
  const environment = process.env["SEARCH_CONSOLE_AXI_SITE"];
  const saved = savedDefaultSite();
  const response = await auth.client.request<unknown>({ url: sitesUrl });
  const data = response.data;
  if (!data || typeof data !== "object" || !("siteEntry" in data) || !Array.isArray(data.siteEntry))
    throw new Error("No verified Search Console sites visible to this account - grant access or configure --site.");
  const entries = data.siteEntry.filter((entry): entry is { siteUrl: string; permissionLevel?: string } =>
    Boolean(entry && typeof entry === "object" && "siteUrl" in entry && typeof entry.siteUrl === "string"),
  );
  const verified = entries.filter((entry) => verifiedPermissions.has(entry.permissionLevel ?? ""));
  const requested = flag ?? environment ?? saved;
  const site = requested ?? verified.map((entry) => entry.siteUrl).sort((a, b) => a.localeCompare(b))[0];
  if (!site || !verified.some((entry) => entry.siteUrl === site))
    throw new Error("No verified Search Console sites visible to this account - grant access or configure --site.");
  return { site, site_source: flag ? "flag" : environment ? "environment" : saved ? "saved_config" : "first_verified" };
}
