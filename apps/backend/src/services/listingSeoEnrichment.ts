import { sitesConfig } from "../../../../config/sites.config.js";
import type { ListingRankItem } from "../types/productCheck.js";
import { createLogger } from "../utils/logger.js";
import { runWithConcurrency } from "../utils/concurrency.js";
import { extractMetadata } from "./metadataExtractor.js";
import { fetchPageDirect } from "./pageLoader.js";
import type { ProgressReporter } from "./progressHub.js";

const log = createLogger("listingSeoEnrichment");

export interface SeoEnrichmentResult {
  /** Number of products whose real SEO title was fetched successfully. */
  enriched: number;
  /** Number of products whose page fetch failed (keep their grid title). */
  failed: number;
  /**
   * Distinct extraction warnings seen across the products, e.g. "the <title> is
   * only the store name". These describe the STORE's SEO, which is exactly what
   * this tool exists to report, so they are surfaced instead of swallowed.
   */
  warnings: string[];
}

/**
 * Fetch each best-seller's product page and replace `titleSeo` with the REAL
 * page SEO title (the `<title>` tag). This is the only way to get the genuine
 * SEO title: the collection grid and products.json never expose it, so without
 * this `titleSeo` is just a grid-derived approximation (see ListingRankItem).
 *
 * Lean by design — a plain HTTP fetch (proxy → direct fallback) per product, no
 * headless browser and no disk writes (that heavy path is startListingEnrichment).
 * Server-rendered Shopify product pages already carry the `<title>` in their HTML,
 * which is all the metadata extractor needs. We only read the title; the response
 * shape is unchanged (just `title` + `titleSeo`).
 *
 * Best-effort and isolated: a product whose page can't be fetched keeps its
 * existing grid `titleSeo` (the ranking still stands), and failures are counted,
 * not thrown.
 */
export async function enrichListingItemsWithSeo(
  items: ListingRankItem[],
  progress?: ProgressReporter,
): Promise<SeoEnrichmentResult> {
  const concurrency = sitesConfig.enrichment.concurrency;
  let enriched = 0;
  let failed = 0;
  // Deduplicated: a store-wide title bug repeats on every product page, and one
  // warning describes it better than 150 identical copies.
  const seoWarnings = new Set<string>();

  if (items.length === 0) return { enriched, failed, warnings: [] };

  progress?.({
    phase: "seo-enrich-start",
    message: `Reading SEO titles from ${items.length} product pages, ${concurrency} at a time…`,
    total: items.length,
  });

  await runWithConcurrency(items, concurrency, async (item) => {
    try {
      const page = await fetchPageDirect(item.url);
      const seoField = extractMetadata(page.html, page.finalUrl).seo.title;
      const seoTitle = seoField.value;
      for (const warning of seoField.warnings ?? []) seoWarnings.add(warning);
      // Only overwrite when the page yielded a real title; otherwise keep the
      // grid-derived fallback already on the item.
      if (seoTitle) item.titleSeo = seoTitle;
      enriched += 1;
      progress?.({
        phase: "seo-enrich-product-done",
        message: `SEO title: ${seoTitle ?? "(none found)"}`,
        url: item.url,
        current: enriched + failed,
        total: items.length,
      });
    } catch (err) {
      failed += 1;
      progress?.({
        phase: "seo-enrich-product-failed",
        message: `Failed to read SEO for ${item.title ?? item.url}: ${(err as Error).message}`,
        url: item.url,
        current: enriched + failed,
        total: items.length,
      });
    }
  });

  log.info("seo enrichment complete", { count: items.length, enriched, failed, warnings: seoWarnings.size });
  return { enriched, failed, warnings: [...seoWarnings] };
}
