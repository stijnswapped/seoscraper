import type { FastifyReply, FastifyRequest } from "fastify";
import { getDatabaseUrl } from "../db/postgres.js";
import {
  addCreditLedgerEntry,
  debitTopupCredits,
  getBillingEntitlement,
  getBillableUsageUnits,
  getTopupBalance,
  type BillingEntitlementRecord,
  type PlanCode,
} from "../db/billingRepository.js";

export interface BillingPlan {
  code: PlanCode;
  name: string;
  priceEur: number;
  limit5h: number | null;
  limit7d: number | null;
  polarProductEnv?: string;
  description: string;
}

export interface TopupPack {
  code: "boost_500" | "boost_2500" | "boost_10000";
  name: string;
  priceEur: number;
  units: number;
  polarProductEnv: string;
}

export const BILLING_PLANS: Record<PlanCode, BillingPlan> = {
  free: {
    code: "free",
    name: "Free",
    priceEur: 0,
    limit5h: 20,
    limit7d: 100,
    description: "Trial access for light testing.",
  },
  starter: {
    code: "starter",
    name: "Starter",
    priceEur: 19,
    limit5h: 150,
    limit7d: 750,
    polarProductEnv: "POLAR_STARTER_PRODUCT_ID",
    description: "For solo store checks and occasional tracking.",
  },
  pro: {
    code: "pro",
    name: "Pro",
    priceEur: 49,
    limit5h: 500,
    limit7d: 2500,
    polarProductEnv: "POLAR_PRO_PRODUCT_ID",
    description: "For frequent scraping and SEO workflows.",
  },
  scale: {
    code: "scale",
    name: "Scale",
    priceEur: 149,
    limit5h: 2000,
    limit7d: 10000,
    polarProductEnv: "POLAR_SCALE_PRODUCT_ID",
    description: "For agencies and high-volume tracking.",
  },
  unlimited: {
    code: "unlimited",
    name: "Unlimited",
    priceEur: 0,
    limit5h: null,
    limit7d: null,
    description: "Admin-granted unlimited access.",
  },
};

export const TOPUP_PACKS: Record<TopupPack["code"], TopupPack> = {
  boost_500: {
    code: "boost_500",
    name: "Boost 500",
    priceEur: 9,
    units: 500,
    polarProductEnv: "POLAR_TOPUP_500_PRODUCT_ID",
  },
  boost_2500: {
    code: "boost_2500",
    name: "Boost 2,500",
    priceEur: 29,
    units: 2500,
    polarProductEnv: "POLAR_TOPUP_2500_PRODUCT_ID",
  },
  boost_10000: {
    code: "boost_10000",
    name: "Boost 10,000",
    priceEur: 99,
    units: 10000,
    polarProductEnv: "POLAR_TOPUP_10000_PRODUCT_ID",
  },
};

export interface BillingOverview {
  entitlement: BillingEntitlementRecord | null;
  effectivePlan: BillingPlan;
  topupBalance: number;
  usage: {
    last5h: number;
    last7d: number;
    limit5h: number | null;
    limit7d: number | null;
    percent5h: number | null;
    percent7d: number | null;
  };
  plans: BillingPlan[];
  topups: TopupPack[];
}

function manualOverrideActive(entitlement: BillingEntitlementRecord | null): boolean {
  if (!entitlement) return false;
  if (!entitlement.manualUnlimited && !entitlement.manualPlanCode) return false;
  if (!entitlement.manualExpiresAt) return true;
  return new Date(entitlement.manualExpiresAt).getTime() > Date.now();
}

function subscriptionActive(entitlement: BillingEntitlementRecord | null): boolean {
  if (!entitlement) return false;
  if (entitlement.billingStatus !== "active" && entitlement.billingStatus !== "trialing") return false;
  if (!entitlement.currentPeriodEnd) return true;
  return new Date(entitlement.currentPeriodEnd).getTime() > Date.now();
}

export function resolveEffectivePlan(entitlement: BillingEntitlementRecord | null): BillingPlan {
  if (manualOverrideActive(entitlement)) {
    if (entitlement?.manualUnlimited) return BILLING_PLANS.unlimited;
    return BILLING_PLANS[entitlement?.manualPlanCode ?? "free"] ?? BILLING_PLANS.free;
  }
  if (subscriptionActive(entitlement)) return BILLING_PLANS[entitlement?.planCode ?? "free"] ?? BILLING_PLANS.free;
  return BILLING_PLANS.free;
}

function percent(used: number, limit: number | null): number | null {
  if (!limit) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

export async function getBillingOverview(userId: string): Promise<BillingOverview> {
  const [entitlement, last5h, last7d, topupBalance] = await Promise.all([
    getBillingEntitlement(userId),
    getBillableUsageUnits(userId, 5),
    getBillableUsageUnits(userId, 24 * 7),
    getTopupBalance(userId),
  ]);
  const effectivePlan = resolveEffectivePlan(entitlement);
  return {
    entitlement,
    effectivePlan,
    topupBalance,
    usage: {
      last5h,
      last7d,
      limit5h: effectivePlan.limit5h,
      limit7d: effectivePlan.limit7d,
      percent5h: percent(last5h, effectivePlan.limit5h),
      percent7d: percent(last7d, effectivePlan.limit7d),
    },
    plans: [BILLING_PLANS.free, BILLING_PLANS.starter, BILLING_PLANS.pro, BILLING_PLANS.scale],
    topups: [TOPUP_PACKS.boost_500, TOPUP_PACKS.boost_2500, TOPUP_PACKS.boost_10000],
  };
}

export function estimateListingUnits(input: { maxProducts?: number; enrich?: boolean }): number {
  const maxProducts = Math.min(Math.max(input.maxProducts ?? 150, 1), 250);
  return input.enrich ? Math.max(2, Math.ceil(maxProducts / 20)) : Math.max(1, Math.ceil(maxProducts / 50));
}

export function estimateCheckProductUnits(): number {
  return 1;
}

function includedRemaining(overview: BillingOverview): number {
  const rem5h = overview.usage.limit5h === null ? Number.POSITIVE_INFINITY : Math.max(0, overview.usage.limit5h - overview.usage.last5h);
  const rem7d = overview.usage.limit7d === null ? Number.POSITIVE_INFINITY : Math.max(0, overview.usage.limit7d - overview.usage.last7d);
  return Math.min(rem5h, rem7d);
}

export async function checkQuota(userId: string | null | undefined, units: number): Promise<{
  allowed: true;
  overview: BillingOverview | null;
  topupUnitsToDebit: number;
} | {
  allowed: false;
  overview: BillingOverview;
  neededTopupUnits: number;
}> {
  if (!getDatabaseUrl() || !userId) return { allowed: true, overview: null, topupUnitsToDebit: 0 };
  const overview = await getBillingOverview(userId);
  if (overview.effectivePlan.code === "unlimited") return { allowed: true, overview, topupUnitsToDebit: 0 };
  const neededTopupUnits = Math.max(0, units - includedRemaining(overview));
  if (neededTopupUnits <= overview.topupBalance) {
    return { allowed: true, overview, topupUnitsToDebit: neededTopupUnits };
  }
  return { allowed: false, overview, neededTopupUnits };
}

export async function debitQuotaTopup(userId: string | null | undefined, units: number, endpoint: string): Promise<void> {
  if (!userId || units <= 0) return;
  await debitTopupCredits({ userId, units, note: `Usage top-up debit for ${endpoint}` });
}

export async function denyOverLimit(reply: FastifyReply, overview: BillingOverview, units: number): Promise<void> {
  await reply.status(402).send({
    success: false,
    error: {
      code: "USAGE_LIMIT_EXCEEDED",
      message: "Usage limit reached. Upgrade your plan or buy a top-up pack to continue.",
    },
    billing: {
      requestedUnits: units,
      effectivePlan: overview.effectivePlan,
      topupBalance: overview.topupBalance,
      usage: overview.usage,
      upgradeUrl: "/billing",
    },
  });
}

export async function addAdminCredits(userId: string, units: number, note?: string | null): Promise<void> {
  await addCreditLedgerEntry({
    userId,
    unitsDelta: units,
    source: "admin_adjustment",
    note: note ?? "Admin credit adjustment",
  });
}

export function publicBillingPayload(overview: BillingOverview): BillingOverview {
  return overview;
}

export function currentUserId(request: FastifyRequest): string {
  const userId = request.auth?.userId;
  if (!userId) throw new Error("Authenticated user is required.");
  return userId;
}
