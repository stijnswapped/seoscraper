/**
 * Proxy + laurence-boutique.fr diagnostic.
 *   cd apps/backend && npx tsx scripts/debugLaurence.ts
 *
 * Prints (no secrets): whether the proxy routes (DIRECT vs PROXY egress IP),
 * whether laurence's server HTML contains real product links via the proxy, and
 * the full extractListingItems result (source tier + best-selling reliability).
 */
import "../src/env.js";
import { load } from "cheerio";
import { getProxyConfig, isProxyConfigured, proxyFetch, fetchDirect } from "../src/services/antiBlock.js";
import { fetchCollectionPageHtml, extractListingItems } from "../src/services/listingTracker.js";

const TARGET = "https://laurence-boutique.fr/collections/all?sort_by=best-selling";

function mask(s: string | undefined): string {
  if (!s) return "(none)";
  return s.length <= 2 ? "**" : `${s[0]}***${s[s.length - 1]} (len ${s.length})`;
}

async function egressIp(fetcher: typeof proxyFetch, label: string): Promise<string> {
  try {
    const r = await fetcher("https://api.ipify.org?format=json", {});
    const j = (await r.json()) as { ip?: string };
    return j.ip ?? "(unknown)";
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

const cfg = getProxyConfig();
console.log("=== proxy config (masked) ===");
console.log("isProxyConfigured:", isProxyConfigured());
console.log("server:", cfg?.server ?? "(none)", "| user:", mask(cfg?.username), "| pass:", cfg?.password ? "set" : "(none)");
console.log("PROXY_ROTATING:", process.env.PROXY_ROTATING ?? "(unset)");

console.log("\n=== egress IP (proxy must differ from direct) ===");
const direct = await egressIp(fetchDirect, "DIRECT");
const proxied = await egressIp(proxyFetch, "PROXY");
console.log("DIRECT:", direct);
console.log("PROXY :", proxied);
console.log(direct === proxied ? "!! PROXY NOT ROUTING (same IP / fell back to direct)" : "OK: proxy routes through a different IP");

console.log("\n=== laurence HTML via proxy (fetchCollectionPageHtml) ===");
const r = await fetchCollectionPageHtml(TARGET, "https://laurence-boutique.fr");
if (!r.ok) {
  console.log("NOT OK:", r.warning);
} else {
  const $ = load(r.html);
  console.log("ok finalUrl=", r.finalUrl, "viaDirect=", r.viaDirect, "bytes=", r.html.length);
  console.log("a[href*=/products/]:", $('a[href*="/products/"]').length);
  console.log("og:site_name:", $('meta[property="og:site_name"]').attr("content") ?? "(none)");
  console.log("title:", $("title").first().text().trim().slice(0, 80));
  console.log("head:", r.html.slice(0, 180).replace(/\s+/g, " "));
}

console.log("\n=== full extractListingItems (auto) ===");
const out = await extractListingItems(new URL(TARGET), "auto", 50, 2);
console.log("sourceUsed:", out.sourceUsed, "| meta:", JSON.stringify(out.rawMetadata));
console.log("warnings:", JSON.stringify(out.warnings));
console.log("first8:", out.items.slice(0, 8).map((i) => i.handle).join(" | "));
process.exit(0);
