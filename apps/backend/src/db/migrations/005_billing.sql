-- Billing entitlements, top-up credits, and billable usage units.

alter table usage_events add column if not exists units integer not null default 1;
alter table usage_events add column if not exists billable boolean not null default true;
create index if not exists usage_events_user_billable_ts_idx on usage_events (user_id, billable, ts);

create table if not exists billing_entitlements (
  user_id uuid primary key references users(id) on delete cascade,
  plan_code text not null default 'free',
  billing_status text not null default 'free',
  polar_customer_id text,
  polar_subscription_id text,
  polar_product_id text,
  current_period_end timestamptz,
  manual_plan_code text,
  manual_unlimited boolean not null default false,
  manual_reason text,
  manual_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_entitlements_polar_customer_idx on billing_entitlements (polar_customer_id);
create index if not exists billing_entitlements_polar_subscription_idx on billing_entitlements (polar_subscription_id);

create table if not exists billing_credit_ledger (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  units_delta integer not null,
  source text not null,
  provider_order_id text,
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists billing_credit_ledger_provider_order_idx
  on billing_credit_ledger (provider_order_id)
  where provider_order_id is not null;
create index if not exists billing_credit_ledger_user_idx on billing_credit_ledger (user_id, created_at desc);
