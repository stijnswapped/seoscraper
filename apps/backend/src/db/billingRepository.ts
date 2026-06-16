import { randomUUID } from "node:crypto";
import { query } from "./postgres.js";

export type PlanCode = "free" | "starter" | "pro" | "scale" | "unlimited";
export type BillingStatus = "free" | "active" | "trialing" | "past_due" | "canceled" | "manual";

export interface BillingEntitlementRecord {
  userId: string;
  planCode: PlanCode;
  billingStatus: BillingStatus;
  polarCustomerId: string | null;
  polarSubscriptionId: string | null;
  polarProductId: string | null;
  currentPeriodEnd: string | null;
  manualPlanCode: PlanCode | null;
  manualUnlimited: boolean;
  manualReason: string | null;
  manualExpiresAt: string | null;
}

interface BillingEntitlementRow {
  user_id: string;
  plan_code: PlanCode;
  billing_status: BillingStatus;
  polar_customer_id: string | null;
  polar_subscription_id: string | null;
  polar_product_id: string | null;
  current_period_end: Date | null;
  manual_plan_code: PlanCode | null;
  manual_unlimited: boolean;
  manual_reason: string | null;
  manual_expires_at: Date | null;
}

function rowToEntitlement(row: BillingEntitlementRow): BillingEntitlementRecord {
  return {
    userId: row.user_id,
    planCode: row.plan_code,
    billingStatus: row.billing_status,
    polarCustomerId: row.polar_customer_id,
    polarSubscriptionId: row.polar_subscription_id,
    polarProductId: row.polar_product_id,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    manualPlanCode: row.manual_plan_code,
    manualUnlimited: row.manual_unlimited,
    manualReason: row.manual_reason,
    manualExpiresAt: row.manual_expires_at?.toISOString() ?? null,
  };
}

export async function getBillingEntitlement(userId: string): Promise<BillingEntitlementRecord | null> {
  const res = await query<BillingEntitlementRow>(`select * from billing_entitlements where user_id = $1`, [userId]);
  return res.rows[0] ? rowToEntitlement(res.rows[0]) : null;
}

export async function upsertBillingEntitlement(input: {
  userId: string;
  planCode?: PlanCode;
  billingStatus?: BillingStatus;
  polarCustomerId?: string | null;
  polarSubscriptionId?: string | null;
  polarProductId?: string | null;
  currentPeriodEnd?: string | null;
}): Promise<void> {
  await query(
    `insert into billing_entitlements (
       user_id, plan_code, billing_status, polar_customer_id, polar_subscription_id, polar_product_id, current_period_end
     ) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (user_id) do update set
       plan_code = excluded.plan_code,
       billing_status = excluded.billing_status,
       polar_customer_id = coalesce(excluded.polar_customer_id, billing_entitlements.polar_customer_id),
       polar_subscription_id = excluded.polar_subscription_id,
       polar_product_id = excluded.polar_product_id,
       current_period_end = excluded.current_period_end,
       updated_at = now()`,
    [
      input.userId,
      input.planCode ?? "free",
      input.billingStatus ?? "free",
      input.polarCustomerId ?? null,
      input.polarSubscriptionId ?? null,
      input.polarProductId ?? null,
      input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
    ],
  );
}

export async function setManualBillingOverride(input: {
  userId: string;
  manualPlanCode: PlanCode | null;
  manualUnlimited: boolean;
  manualReason?: string | null;
  manualExpiresAt?: string | null;
}): Promise<void> {
  await query(
    `insert into billing_entitlements (
       user_id, manual_plan_code, manual_unlimited, manual_reason, manual_expires_at, billing_status
     ) values ($1, $2, $3, $4, $5, 'manual')
     on conflict (user_id) do update set
       manual_plan_code = excluded.manual_plan_code,
       manual_unlimited = excluded.manual_unlimited,
       manual_reason = excluded.manual_reason,
       manual_expires_at = excluded.manual_expires_at,
       updated_at = now()`,
    [
      input.userId,
      input.manualPlanCode,
      input.manualUnlimited,
      input.manualReason ?? null,
      input.manualExpiresAt ? new Date(input.manualExpiresAt) : null,
    ],
  );
}

export async function getBillableUsageUnits(userId: string, hours: number): Promise<number> {
  const res = await query<{ total: string }>(
    `select coalesce(sum(units), 0)::text as total
       from usage_events
      where user_id = $1
        and billable = true
        and ts > now() - ($2 || ' hours')::interval`,
    [userId, String(hours)],
  );
  return Number(res.rows[0]?.total ?? 0);
}

export async function getTopupBalance(userId: string): Promise<number> {
  const res = await query<{ total: string }>(
    `select coalesce(sum(units_delta), 0)::text as total
       from billing_credit_ledger
      where user_id = $1`,
    [userId],
  );
  return Number(res.rows[0]?.total ?? 0);
}

export async function addCreditLedgerEntry(input: {
  userId: string;
  unitsDelta: number;
  source: "topup" | "admin_adjustment" | "refund" | "correction" | "usage_debit";
  providerOrderId?: string | null;
  note?: string | null;
}): Promise<void> {
  await query(
    `insert into billing_credit_ledger (user_id, units_delta, source, provider_order_id, note)
       values ($1, $2, $3, $4, $5)
     on conflict (provider_order_id) where provider_order_id is not null do nothing`,
    [input.userId, input.unitsDelta, input.source, input.providerOrderId ?? null, input.note ?? null],
  );
}

export async function debitTopupCredits(input: {
  userId: string;
  units: number;
  note: string;
}): Promise<void> {
  if (input.units <= 0) return;
  await addCreditLedgerEntry({
    userId: input.userId,
    unitsDelta: -input.units,
    source: "usage_debit",
    note: input.note,
  });
}

// --- Early access (pre-launch) ----------------------------------------------

export interface EarlyAccessSignup {
  id: string;
  email: string | null;
  createdAt: string;
}

/** Record a paid early-access buyer. Idempotent on the Polar order id. */
export async function recordEarlyAccessSignup(input: {
  email: string | null;
  providerOrderId: string | null;
}): Promise<void> {
  await query(
    `insert into early_access_signups (id, email, provider_order_id)
       values ($1, $2, $3)
     on conflict (provider_order_id) where provider_order_id is not null do nothing`,
    [randomUUID(), input.email, input.providerOrderId],
  );
}

export async function listEarlyAccessSignups(limit = 500): Promise<EarlyAccessSignup[]> {
  const res = await query<{ id: string; email: string | null; created_at: Date }>(
    `select id, email, created_at from early_access_signups order by created_at desc limit $1`,
    [limit],
  );
  return res.rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.created_at.toISOString() }));
}

export async function countEarlyAccessSignups(): Promise<number> {
  const res = await query<{ total: string }>(`select count(*)::text as total from early_access_signups`);
  return Number(res.rows[0]?.total ?? 0);
}
