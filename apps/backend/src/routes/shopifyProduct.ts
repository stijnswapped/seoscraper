import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fetchShopifyProduct } from "../services/shopifyProduct.js";
import { requireApiKeyAuth } from "../services/apiAuth.js";
import { scrapeRateLimit } from "../services/rateLimit.js";
import { runWithProxy, validateProxyOverride } from "../services/antiBlock.js";
import { logUsage, proxySource } from "../services/usageLogger.js";
import { trackWork } from "../services/workTracker.js";
import { CheckError } from "../types/productCheck.js";
import type { ErrorCode } from "../types/productCheck.js";
import { checkQuota, debitQuotaTopup, denyOverLimit, estimateShopifyProductUnits } from "../services/billing.js";

const shopifyProductBodySchema = z.object({
  url: z.string().min(1, "url is required"),
  // Optional per-request proxy, exactly as on /api/listings/track: overrides the
  // account's and the server's proxy for this call only; creds are never logged.
  proxy: z
    .string()
    .trim()
    .min(1)
    .refine((v) => validateProxyOverride(v) === null, (v) => ({ message: validateProxyOverride(v) ?? "invalid proxy" }))
    .optional(),
});

export function registerShopifyProductRoute(app: FastifyInstance): void {
  app.post("/api/shopify-product", { preHandler: requireApiKeyAuth, config: { rateLimit: scrapeRateLimit } }, async (request, reply) => {
    const parsed = shopifyProductBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: {
          code: "INVALID_URL" satisfies ErrorCode,
          message: parsed.error.issues[0]?.message ?? "Invalid request body.",
        },
      });
    }

    const billableUnits = estimateShopifyProductUnits();
    const quota = await checkQuota(request.auth?.userId, billableUnits);
    if (!quota.allowed) return denyOverLimit(reply, quota.overview, billableUnits);

    // Proxy precedence: request `proxy` > account proxy > server env proxy.
    const userProxy = request.auth?.proxyUrl ?? null;
    const proxyOverride = parsed.data.proxy ?? userProxy ?? null;
    const usedProxy = proxySource(parsed.data.proxy, userProxy);
    const startedAt = Date.now();
    try {
      // No browser is involved, but a self-restart would still cut the call off
      // halfway, so it counts as in-flight work like a listings-track run.
      const result = await trackWork(() => runWithProxy(proxyOverride, () => fetchShopifyProduct(parsed.data.url)));

      // The shop's answer is the result, whatever its status: a 404 or a 429 is
      // reported inside `result.status` with HTTP 200. Only a 2xx answer — the
      // caller got the product — is billed.
      const delivered = result.status >= 200 && result.status < 300;
      await logUsage(request, {
        endpoint: "/api/shopify-product",
        status: 200,
        ok: delivered,
        durationMs: Date.now() - startedAt,
        usedProxy,
        units: billableUnits,
        billable: delivered,
      });
      if (delivered) await debitQuotaTopup(request.auth?.userId, quota.topupUnitsToDebit, "/api/shopify-product");

      return reply.send({ success: true, result });
    } catch (err) {
      if (err instanceof CheckError) {
        const status = err.code === "DOMAIN_NOT_ALLOWED" || err.code === "INVALID_URL" ? 400 : 502;
        await logUsage(request, {
          endpoint: "/api/shopify-product",
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
        endpoint: "/api/shopify-product",
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
}
