import { describe, expect, it } from "vitest";
import {
  BILLING_PLANS,
  estimateCheckProductUnits,
  estimateListingUnits,
  resolveEffectivePlan,
} from "../src/services/billing.js";
import type { BillingEntitlementRecord } from "../src/db/billingRepository.js";

function entitlement(input: Partial<BillingEntitlementRecord>): BillingEntitlementRecord {
  return {
    userId: "user-1",
    planCode: "free",
    billingStatus: "free",
    polarCustomerId: null,
    polarSubscriptionId: null,
    polarProductId: null,
    currentPeriodEnd: null,
    manualPlanCode: null,
    manualUnlimited: false,
    manualReason: null,
    manualExpiresAt: null,
    ...input,
  };
}

describe("billing plan resolution", () => {
  it("defaults to free without an entitlement", () => {
    expect(resolveEffectivePlan(null)).toBe(BILLING_PLANS.free);
  });

  it("uses an active subscription plan", () => {
    expect(resolveEffectivePlan(entitlement({ planCode: "pro", billingStatus: "active" })).code).toBe("pro");
  });

  it("falls back to free for canceled subscriptions", () => {
    expect(resolveEffectivePlan(entitlement({ planCode: "pro", billingStatus: "canceled" })).code).toBe("free");
  });

  it("lets manual overrides win over subscriptions", () => {
    expect(
      resolveEffectivePlan(entitlement({ planCode: "starter", billingStatus: "active", manualPlanCode: "scale" })).code,
    ).toBe("scale");
  });

  it("supports manual unlimited access", () => {
    expect(resolveEffectivePlan(entitlement({ manualUnlimited: true })).code).toBe("unlimited");
  });

  it("ignores expired manual overrides", () => {
    expect(
      resolveEffectivePlan(
        entitlement({
          planCode: "starter",
          billingStatus: "active",
          manualPlanCode: "scale",
          manualExpiresAt: "2000-01-01T00:00:00.000Z",
        }),
      ).code,
    ).toBe("starter");
  });
});

describe("billing unit estimation", () => {
  it("charges one unit for a product check", () => {
    expect(estimateCheckProductUnits()).toBe(1);
  });

  it("charges lean listing tracking by product batches", () => {
    expect(estimateListingUnits({ maxProducts: 10 })).toBe(1);
    expect(estimateListingUnits({ maxProducts: 150 })).toBe(3);
  });

  it("charges enriched listing tracking more heavily", () => {
    expect(estimateListingUnits({ maxProducts: 10, enrich: true })).toBe(2);
    expect(estimateListingUnits({ maxProducts: 150, enrich: true })).toBe(8);
  });
});
