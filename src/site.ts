import { savedDefaultSite } from "./auth.js";
import type { AuthProvider } from "./auth.js";
import { usage } from "./args.js";
import { sites } from "./setup-check.js";
const verifiedPermissions = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);
export function isValidSite(site: string): boolean {
  if (site.startsWith("sc-domain:") && site.length > "sc-domain:".length && !/\s/.test(site)) return true;
  try {
    const url = new URL(site);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function validateSite(site: string): string {
  if (isValidSite(site)) return site;
  return usage("site must be a sc-domain: property or absolute HTTP(S) URL without credentials");
}
export function selectVerifiedSite(
  sites: string[],
  candidates: { site: string | undefined; source: string }[],
): { site: string; site_source: string } | undefined {
  for (const candidate of candidates) {
    if (candidate.site && sites.includes(candidate.site))
      return { site: candidate.site, site_source: candidate.source };
  }
  const site = [...sites].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
  return site ? { site, site_source: "first_verified" } : undefined;
}
export async function resolveSite(auth: AuthProvider, flag?: string): Promise<{ site: string; site_source: string }> {
  const environment = process.env["SEARCH_CONSOLE_AXI_SITE"];
  const saved = savedDefaultSite();
  const entries = await sites(auth);
  const verified = entries.filter((entry) => verifiedPermissions.has(entry.permissionLevel ?? ""));
  const candidates = [
    { site: flag, source: "flag" },
    { site: environment, source: "environment" },
    { site: saved, source: "saved_config" },
  ];
  const requested = candidates.find((candidate) => candidate.site);
  if (requested && !verified.some((entry) => entry.siteUrl === requested.site))
    return usage(`Selected site '${requested.site}' is not a verified property`);
  const selected = selectVerifiedSite(
    verified.map((entry) => entry.siteUrl),
    candidates,
  );
  if (!selected)
    throw new Error("No verified Search Console sites visible to this account - grant access or configure --site.");
  return selected;
}
