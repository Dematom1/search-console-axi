import { savedDefaultSite } from "./auth.js";
import type { AuthProvider } from "./auth.js";

const sitesUrl = "https://searchconsole.googleapis.com/webmasters/v3/sites";
export async function resolveSite(auth: AuthProvider, flag?: string): Promise<{ site: string; site_source: string }> {
  if (flag) return { site: flag, site_source: "flag" };
  const environment = process.env["SEARCH_CONSOLE_AXI_SITE"];
  if (environment) return { site: environment, site_source: "environment" };
  const saved = savedDefaultSite();
  if (saved) return { site: saved, site_source: "saved_config" };
  const response = await auth.client.request<unknown>({ url: sitesUrl });
  const data = response.data;
  if (!data || typeof data !== "object" || !("siteEntry" in data) || !Array.isArray(data.siteEntry))
    throw new Error("No verified Search Console sites visible to this account - grant access or configure --site.");
  const entries = data.siteEntry.filter((entry): entry is { siteUrl: string; permissionLevel?: string } =>
    Boolean(entry && typeof entry === "object" && "siteUrl" in entry && typeof entry.siteUrl === "string"),
  );
  const verified = entries.filter((entry) => entry.permissionLevel !== "siteUnverifiedUser");
  const site = verified.map((entry) => entry.siteUrl).sort((a, b) => a.localeCompare(b))[0];
  if (!site)
    throw new Error("No verified Search Console sites visible to this account - grant access or configure --site.");
  return { site, site_source: "first_verified" };
}
