/**
 * Multi-site listing diagnostic — the fastest way to answer "why does store X
 * keep failing?".
 *
 *   cd apps/backend && npx tsx scripts/debugSites.ts [--enrich] [url ...]
 *
 * Per URL it prints the raw proxy/direct HTTP status (with `cf-mitigated`, so a
 * bot challenge is distinguishable from a store-side 5xx), what the plain-fetch
 * tier sees, and the full extractListingItems result at PRODUCTION parameters
 * (150 products, 10 pages) including every warning. With --enrich it also reads
 * the real per-product SEO titles and reports how many are distinct — a store
 * whose theme hardcodes one <title> shows up as "1 distinct of N".
 */
import "../src/env.js";
import { load } from "cheerio";
import {
  buildRealisticHeaders,
  fetchDirect,
  getProxyConfig,
  isBlockedResponse,
  isProxyConfigured,
  isProxyRotating,
  proxyFetch,
} from "../src/services/antiBlock.js";
import { extractListingItems, fetchCollectionPageHtml } from "../src/services/listingTracker.js";
import { enrichListingItemsWithSeo } from "../src/services/listingSeoEnrichment.js";

const args = process.argv.slice(2);
const enrich = args.includes("--enrich");
const targets = args.filter((a) => !a.startsWith("--"));
if (targets.length === 0) {
  console.error("usage: npx tsx scripts/debugSites.ts [--enrich] <listing-url> [more urls...]");
  process.exit(1);
}

console.log(
  "proxyConfigured:", isProxyConfigured(),
  "| rotating:", isProxyRotating(),
  "| server:", getProxyConfig()?.server ?? "(none)",
);

for (const target of targets) {
  const url = new URL(target);
  console.log(`\n================ ${target}`);

  for (const [label, fetcher] of [["proxy", proxyFetch], ["direct", fetchDirect]] as const) {
    try {
      const res = await fetcher(target, { headers: buildRealisticHeaders(url.origin), redirect: "manual" });
      const body = await res.text().catch(() => "");
      console.log(
        `${label}: HTTP ${res.status}`,
        "| cf-mitigated:", res.headers.get("cf-mitigated") ?? "-",
        "| server:", res.headers.get("server") ?? "-",
        "| location:", res.headers.get("location") ?? "-",
        "| bytes:", body.length,
        "| blocked:", isBlockedResponse(res.status, body, res.headers.get("server"), res.headers.get("cf-mitigated")),
        "| title:", (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
      );
    } catch (err) {
      console.log(`${label}: ERROR ${(err as Error).message}`);
    }
  }

  const fetched = await fetchCollectionPageHtml(target, url.origin);
  if (!fetched.ok) console.log("fetchCollectionPageHtml NOT OK:", fetched.warning);
  else {
    const $ = load(fetched.html);
    console.log(
      "fetchCollectionPageHtml ok | viaDirect:", fetched.viaDirect,
      "| bytes:", fetched.html.length,
      "| productLinks:", $('a[href*="/products/"]').length,
    );
  }

  try {
    const out = await extractListingItems(url, "both", 150, 10);
    console.log("sourceUsed:", out.sourceUsed, "| items:", out.items.length, "| meta:", JSON.stringify(out.rawMetadata));
    for (const warning of out.warnings) console.log("  warning:", warning);
    console.log("top5:", out.items.slice(0, 5).map((i) => `${i.rank}. ${i.handle}`).join(" | "));

    if (enrich) {
      const sample = out.items.slice(0, 12);
      const seo = await enrichListingItemsWithSeo(sample);
      const distinct = new Set(sample.map((i) => i.titleSeo));
      console.log(`SEO titles: enriched ${seo.enriched}, failed ${seo.failed}, ${distinct.size} distinct of ${sample.length}`);
      for (const warning of seo.warnings) console.log("  seo warning:", warning);
      for (const i of sample.slice(0, 5)) console.log(`  ${i.rank}. title="${i.title}" seo="${i.titleSeo}"`);
    }
  } catch (err) {
    console.log("extractListingItems THREW:", (err as Error).message);
  }
}
process.exit(0);
