import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { getUserById } from "../db/accountRepository.js";
import {
  addCreditLedgerEntry,
  setManualBillingOverride,
  upsertBillingEntitlement,
  type PlanCode,
} from "../db/billingRepository.js";
import { requireAdminSession, requireSession } from "../services/apiAuth.js";
import {
  BILLING_PLANS,
  TOPUP_PACKS,
  addAdminCredits,
  currentUserId,
  getBillingOverview,
  publicBillingPayload,
} from "../services/billing.js";
import { decryptSecret } from "../services/crypto.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("billing");

const checkoutSchema = z.object({
  kind: z.enum(["subscription", "topup"]),
  code: z.string().min(1),
});

const adminBillingSchema = z.object({
  manualPlanCode: z.enum(["free", "starter", "pro", "scale", "unlimited"]).nullable().optional(),
  manualUnlimited: z.boolean().optional(),
  manualReason: z.string().trim().max(500).nullable().optional(),
  manualExpiresAt: z.string().datetime().nullable().optional(),
  addCredits: z.number().int().optional(),
});

function bad(reply: FastifyReply, code: string, message: string, status = 400): Promise<void> {
  return reply.status(status).send({ success: false, error: { code, message } }) as unknown as Promise<void>;
}

function frontendUrl(path: string): string {
  const base = process.env.FRONTEND_PUBLIC_URL?.replace(/\/+$/, "") || "http://localhost:5173";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function polarProductFor(kind: "subscription" | "topup", code: string): string | null {
  if (kind === "subscription") {
    const plan = BILLING_PLANS[code as PlanCode];
    if (!plan || !plan.polarProductEnv) return null;
    return process.env[plan.polarProductEnv]?.trim() || null;
  }
  const topup = TOPUP_PACKS[code as keyof typeof TOPUP_PACKS];
  if (!topup) return null;
  return process.env[topup.polarProductEnv]?.trim() || null;
}

function planCodeForProduct(productId: string | null | undefined): PlanCode {
  if (!productId) return "free";
  for (const plan of Object.values(BILLING_PLANS)) {
    if (plan.polarProductEnv && process.env[plan.polarProductEnv] === productId) return plan.code;
  }
  return "free";
}

function topupForProduct(productId: string | null | undefined): keyof typeof TOPUP_PACKS | null {
  if (!productId) return null;
  for (const topup of Object.values(TOPUP_PACKS)) {
    if (process.env[topup.polarProductEnv] === productId) return topup.code;
  }
  return null;
}

async function polarRequest<T>(path: string, body: unknown): Promise<T> {
  const token = process.env.POLAR_ACCESS_TOKEN?.trim();
  if (!token) throw new Error("POLAR_ACCESS_TOKEN is not configured.");
  const base = process.env.POLAR_API_BASE_URL?.replace(/\/+$/, "") || "https://api.polar.sh";
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(data.message || data.error || `Polar request failed with ${res.status}`);
  return data;
}

function verifyPolarSignature(body: unknown, headers: Record<string, string | string[] | undefined>): boolean {
  const secret = process.env.POLAR_WEBHOOK_SECRET?.trim();
  if (!secret) return true;

  const id = firstHeader(headers["webhook-id"]) ?? firstHeader(headers["x-webhook-id"]);
  const timestamp = firstHeader(headers["webhook-timestamp"]) ?? firstHeader(headers["x-webhook-timestamp"]);
  const signature = firstHeader(headers["webhook-signature"]) ?? firstHeader(headers["x-webhook-signature"]);
  if (!id || !timestamp || !signature) return false;

  const rawBody = JSON.stringify(body);
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : secret;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  const candidates = signature.split(" ").flatMap((part) => part.split(",")).map((part) => part.replace(/^v1,?/, "").replace(/^v1=/, "").trim());
  return candidates.some((candidate) => safeEqual(candidate, expected));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function metadataUserId(data: any): string | null {
  return data?.external_id ?? data?.customer_external_id ?? data?.metadata?.userId ?? data?.metadata?.user_id ?? data?.customer?.external_id ?? null;
}

async function handleCustomerState(data: any): Promise<void> {
  const userId = metadataUserId(data);
  if (!userId) return;
  const sub = Array.isArray(data?.active_subscriptions) ? data.active_subscriptions[0] : null;
  await upsertBillingEntitlement({
    userId,
    planCode: sub ? planCodeForProduct(sub.product_id) : "free",
    billingStatus: sub ? "active" : "canceled",
    polarCustomerId: data?.id ?? null,
    polarSubscriptionId: sub?.id ?? null,
    polarProductId: sub?.product_id ?? null,
    currentPeriodEnd: sub?.current_period_end ?? null,
  });
}

async function handleOrderPaid(data: any): Promise<void> {
  const userId = metadataUserId(data);
  const productId = data?.product_id ?? data?.product?.id ?? data?.items?.[0]?.product_id ?? data?.items?.[0]?.product?.id;
  const topupCode = topupForProduct(productId);
  if (!userId || !topupCode) return;
  const topup = TOPUP_PACKS[topupCode];
  await addCreditLedgerEntry({
    userId,
    unitsDelta: topup.units,
    source: "topup",
    providerOrderId: data?.id ?? data?.order_id ?? null,
    note: `${topup.name} purchased via Polar`,
  });
}

export function registerBillingRoutes(app: FastifyInstance): void {
  app.get("/api/account/billing", { preHandler: requireSession }, async (request, reply) => {
    return reply.send({ success: true, billing: publicBillingPayload(await getBillingOverview(currentUserId(request))) });
  });

  app.post("/api/account/billing/checkout", { preHandler: requireSession }, async (request, reply) => {
    const parsed = checkoutSchema.safeParse(request.body ?? {});
    if (!parsed.success) return bad(reply, "INVALID_BODY", "Invalid checkout request.");

    const productId = polarProductFor(parsed.data.kind, parsed.data.code);
    if (!productId) return bad(reply, "PRODUCT_NOT_CONFIGURED", "This billing product is not configured.", 503);

    const userId = currentUserId(request);
    const user = await getUserById(userId, decryptSecret);
    if (!user) return bad(reply, "NOT_FOUND", "Account not found.", 404);

    const checkout = await polarRequest<{ url?: string; checkout_url?: string }>("/v1/checkouts", {
      products: [productId],
      customer_email: user.email,
      customer_external_id: user.id,
      success_url: frontendUrl("/dashboard?billing=success"),
      metadata: { userId: user.id, kind: parsed.data.kind, code: parsed.data.code },
    });
    const url = checkout.url ?? checkout.checkout_url;
    if (!url) return bad(reply, "CHECKOUT_FAILED", "Polar did not return a checkout URL.", 502);
    return reply.send({ success: true, url });
  });

  app.post("/api/account/billing/portal", { preHandler: requireSession }, async (request, reply) => {
    const overview = await getBillingOverview(currentUserId(request));
    if (!overview.entitlement?.polarCustomerId) return bad(reply, "NO_CUSTOMER", "No billing customer exists yet.", 404);
    const session = await polarRequest<{ url?: string; portal_url?: string }>("/v1/customer-portal/sessions", {
      customer_id: overview.entitlement.polarCustomerId,
      return_url: frontendUrl("/dashboard"),
    });
    return reply.send({ success: true, url: session.url ?? session.portal_url ?? frontendUrl("/dashboard") });
  });

  app.post("/api/billing/webhook/polar", async (request, reply) => {
    if (!verifyPolarSignature(request.body, request.headers)) return bad(reply, "INVALID_SIGNATURE", "Invalid webhook signature.", 401);
    const event = request.body as any;
    const type = event?.type as string | undefined;
    const data = event?.data ?? {};
    try {
      if (type === "customer.state_changed") await handleCustomerState(data);
      else if (type?.includes("order") && (type.includes("paid") || type.includes("created"))) await handleOrderPaid(data);
      return reply.send({ success: true });
    } catch (err) {
      log.error("polar webhook failed", { type, message: (err as Error).message });
      return bad(reply, "WEBHOOK_FAILED", "Could not process webhook.", 500);
    }
  });

  app.put("/api/admin/users/:id/billing", { preHandler: requireAdminSession }, async (request, reply) => {
    const parsed = adminBillingSchema.safeParse(request.body ?? {});
    if (!parsed.success) return bad(reply, "INVALID_BODY", parsed.error.issues[0]?.message ?? "Invalid body.");
    const userId = (request.params as { id: string }).id;
    const manualPlan = parsed.data.manualPlanCode ?? null;
    await setManualBillingOverride({
      userId,
      manualPlanCode: manualPlan === "unlimited" ? null : manualPlan,
      manualUnlimited: parsed.data.manualUnlimited ?? manualPlan === "unlimited",
      manualReason: parsed.data.manualReason ?? null,
      manualExpiresAt: parsed.data.manualExpiresAt ?? null,
    });
    if (parsed.data.addCredits && parsed.data.addCredits !== 0) {
      await addAdminCredits(userId, parsed.data.addCredits, parsed.data.manualReason ?? null);
    }
    return reply.send({ success: true, billing: publicBillingPayload(await getBillingOverview(userId)) });
  });
}
