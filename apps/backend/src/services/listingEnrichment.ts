import { sitesConfig } from "../../../../config/sites.config.js";
import type { ListingRankSnapshot } from "../types/productCheck.js";
import { createLogger } from "../utils/logger.js";
import { runWithConcurrency } from "../utils/concurrency.js";
import { createProgressReporter, finishProgress } from "./progressHub.js";
import { runSingleProductCheck } from "../routes/checkProduct.js";
import { withBrowserSession } from "./pageLoader.js";

const log = createLogger("listingEnrichment");

/**
 * Kick off (fire-and-forget) a background per-product SEO + image scrape for a
 * tracked listing snapshot. Streams progress to `runId` and closes the stream
 * when done. Never blocks the caller; failures per product are isolated.
 */
export function startListingEnrichment(snapshot: ListingRankSnapshot, runId?: string): void {
  void runEnrichment(snapshot, runId).catch((err) => {
    log.error("enrichment crashed", { message: (err as Error).message });
    finishProgress(runId);
  });
}

async function runEnrichment(snapshot: ListingRankSnapshot, runId?: string): Promise<void> {
  const progress = createProgressReporter(runId);
  const concurrency = sitesConfig.enrichment.concurrency;
  const items = snapshot.items;
  let done = 0;
  let failed = 0;

  progress({
    phase: "enrich-start",
    message: `Enriching ${items.length} products (full SEO + images), ${concurrency} at a time…`,
    total: items.length,
  });

  try {
    await withBrowserSession(async (session) =>
      runWithConcurrency(items, concurrency, async (item) => {
        try {
          const { fileBaseUrl } = await runSingleProductCheck(item.url, progress, session);
          done += 1;
          progress({
            phase: "enrich-product-done",
            message: `Scraped ${item.title ?? item.url}`,
            url: fileBaseUrl,
            current: done + failed,
            total: items.length,
          });
        } catch (err) {
          failed += 1;
          progress({
            phase: "enrich-product-failed",
            message: `Failed ${item.title ?? item.url}: ${(err as Error).message}`,
            url: item.url,
            current: done + failed,
            total: items.length,
          });
        }
      }),
    );

    progress({
      phase: "enrich-complete",
      message: `Enrichment complete: ${done} scraped, ${failed} failed.`,
      total: items.length,
    });
    log.info("enrichment complete", { listing: snapshot.trackedListingId, done, failed });
  } finally {
    finishProgress(runId);
  }
}
