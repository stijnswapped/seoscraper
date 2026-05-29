import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { trackListing, normalizeSourceStrategy } from "../services/listingTracker.js";
import { requireApiKeyAuth } from "../services/apiAuth.js";
import { CheckError } from "../types/productCheck.js";
import type { ErrorCode } from "../types/productCheck.js";
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
});

const listingParamsSchema = z.object({
  listingId: z.string().uuid(),
});

export function registerListingTrackerRoutes(app: FastifyInstance): void {
  app.post("/api/listings/track", { preHandler: requireApiKeyAuth }, async (request, reply) => {
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

    try {
      const result = await trackListing({
        url: parsed.data.url,
        sourceStrategy: normalizeSourceStrategy(parsed.data.sourceStrategy),
        maxProducts: parsed.data.maxProducts ?? 100,
      });
      return reply.send({ success: true, result });
    } catch (err) {
      if (err instanceof CheckError) {
        const status = err.code === "DOMAIN_NOT_ALLOWED" || err.code === "INVALID_URL" ? 400 : 502;
        return reply.status(status).send({ success: false, error: { code: err.code, message: err.message } });
      }
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

    const listing = await getTrackedListing(params.data.listingId);
    if (!listing) return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Listing was not found." } });

    const snapshots = await getSnapshotsForListing(params.data.listingId, 50);
    return reply.send({ success: true, result: { listing, snapshots } });
  });

  app.get("/api/listings/:listingId/latest", { preHandler: requireApiKeyAuth }, async (request, reply) => {
    const params = listingParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ success: false, error: { code: "INVALID_URL", message: "Invalid listingId." } });

    const listing = await getTrackedListing(params.data.listingId);
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
