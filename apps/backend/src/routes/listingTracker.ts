import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { trackListing, normalizeSourceStrategy } from "../services/listingTracker.js";
import { createProgressReporter, finishProgress } from "../services/progressHub.js";
import { requireApiKeyAuth } from "../services/apiAuth.js";
import { scrapeRateLimit } from "../services/rateLimit.js";
import { runWithProxy, validateProxyOverride } from "../services/antiBlock.js";
import { logUsage, proxySource } from "../services/usageLogger.js";
import { CheckError } from "../types/productCheck.js";
import type { ErrorCode } from "../types/productCheck.js";
import { checkQuota, debitQuotaTopup, denyOverLimit, estimateListingUnits } from "../services/billing.js";
import {
  getLatestSnapshot,
  getSnapshotItems,
  getSnapshotsForListing,
  getTrackedListing,
} from "../db/listingRepository.js";

const trackListingBodySchema = z.object({
  url: z.string().min(1, "url is required"),
  sourceStrategy: z.enum(["auto", "html", "shopify_json", "both"]).optional(),
  maxProducts: z.number().int().positive().max(250).optional(),
  maxPages: z.number().int().positive().optional(),
  runId: z.string().min(1).optional(),
  // Opt-in: fetch each best-seller's product page to capture the REAL page SEO
  // title (populates item.seo). One extra proxy request per product, so it's off
  // by default to keep rank tracking lean. This is a lightweight HTML fetch (no
  // browser, no disk writes) — distinct from the heavy /api/check-product scrape.
  enrich: z.boolean().optional(),
  // Optional per-request proxy (e.g. the customer's own residential proxy) that
  // overrides the server's env proxy for this scrape only. Validated for shape
  // and against loopback/private hosts; creds are never logged.
  proxy: z
    .string()
    .trim()
    .min(1)
    .refine((v) => validateProxyOverride(v) === null, (v) => ({ message: validateProxyOverride(v) ?? "invalid proxy" }))
    .optional(),
});

const listingParamsSchema = z.object({
  listingId: z.string().uuid(),
});

export function registerListingTrackerRoutes(app: FastifyInstance): void {
  app.post("/api/listings/track", { preHandler: requireApiKeyAuth, config: { rateLimit: scrapeRateLimit } }, async (request, reply) => {
    const parsed = trackListingBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: {
          code: "INVALID_URL" satisfies ErrorCode,
          message: parsed.error.issues[0]?.message ?? "Invalid request body.",
        },
      });
    }

    const billableUnits = estimateListingUnits({
      maxProducts: parsed.data.maxProducts ?? 150,
      enrich: parsed.data.enrich ?? false,
    });
    const quota = await checkQuota(request.auth?.userId, billableUnits);
    if (!quota.allowed) return denyOverLimit(reply, quota.overview, billableUnits);

    const progress = createProgressReporter(parsed.data.runId);
    // Proxy precedence: explicit request `proxy` > the account's stored proxy >
    // the server's env proxy. So a customer's own proxy is used automatically.
    const userProxy = request.auth?.proxyUrl ?? null;
    const proxyOverride = parsed.data.proxy ?? userProxy ?? null;
    const usedProxy = proxySource(parsed.data.proxy, userProxy);
    const startedAt = Date.now();
    try {
      progress({ phase: "queued", message: "Listing track accepted.", url: parsed.data.url });
      // Run the whole scrape under the resolved proxy. AsyncLocalStorage carries
      // it into every nested fetch, the browser launch, pagination and enrichment.
      const result = await runWithProxy(proxyOverride, () =>
        trackListing({
          url: parsed.data.url,
          // Scope the listing + its snapshot history to the authenticated user.
          userId: request.auth?.userId ?? null,
          // Default to "both": best-selling order from HTML + reliable title/image
          // from products.json. (auto also enriches, so any value gets titles.)
          sourceStrategy: normalizeSourceStrategy(parsed.data.sourceStrategy ?? "both"),
          maxProducts: parsed.data.maxProducts ?? 150,
          maxPages: parsed.data.maxPages,
          progress,
          enrichSeo: parsed.data.enrich ?? false,
        }),
      );

      // Rank tracking is lean and DB-only: return the ranking + day-over-day
      // changes immediately. With `enrich`, each item also carries the real page
      // SEO title in `result.items[].seo` (already fetched inline above).
      finishProgress(parsed.data.runId);
      await logUsage(request, {
        endpoint: "/api/listings/track",
        status: 200,
        ok: true,
        durationMs: Date.now() - startedAt,
        usedProxy,
        units: billableUnits,
        billable: true,
      });
      await debitQuotaTopup(request.auth?.userId, quota.topupUnitsToDebit, "/api/listings/track");

      return reply.send({ success: true, result, enriching: false });
    } catch (err) {
      finishProgress(parsed.data.runId);
      if (err instanceof CheckError) {
        const status = err.code === "DOMAIN_NOT_ALLOWED" || err.code === "INVALID_URL" ? 400 : 502;
        await logUsage(request, {
          endpoint: "/api/listings/track",
          status,
          ok: false,
          durationMs: Date.now() - startedAt,
          usedProxy,
          units: billableUnits,
          billable: false,
        });
        return reply.status(status).send({ success: false, error: { code: err.code, message: err.message } });
      }
      await logUsage(request, {
        endpoint: "/api/listings/track",
        status: 500,
        ok: false,
        durationMs: Date.now() - startedAt,
        usedProxy,
        units: billableUnits,
        billable: false,
      });
      return reply.status(500).send({
        success: false,
        error: {
          code: "UNKNOWN_ERROR" satisfies ErrorCode,
          message: (err as Error).message || "An unexpected error occurred.",
        },
      });
    }
  });

  app.get("/api/listings/:listingId/history", { preHandler: requireApiKeyAuth }, async (request, reply) => {
    const params = listingParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ success: false, error: { code: "INVALID_URL", message: "Invalid listingId." } });

    const listing = await getTrackedListing(params.data.listingId, request.auth?.userId ?? null);
    if (!listing) return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Listing was not found." } });

    const snapshots = await getSnapshotsForListing(params.data.listingId, 50);
    return reply.send({ success: true, result: { listing, snapshots } });
  });

  app.get("/api/listings/:listingId/latest", { preHandler: requireApiKeyAuth }, async (request, reply) => {
    const params = listingParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ success: false, error: { code: "INVALID_URL", message: "Invalid listingId." } });

    const listing = await getTrackedListing(params.data.listingId, request.auth?.userId ?? null);
    if (!listing) return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Listing was not found." } });

    const latest = await getLatestSnapshot(params.data.listingId);
    if (!latest) return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "No snapshots were found." } });

    return reply.send({
      success: true,
      result: {
        listing,
        snapshot: {
          id: latest.id,
          checkedAt: latest.checkedAt,
          items: await getSnapshotItems(latest.id),
        },
      },
    });
  });
}
