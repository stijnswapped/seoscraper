-- Pre-launch early-access buyers. Anonymous $5 Polar checkout (no account yet);
-- the webhook records the buyer's email here so they can be invited + granted a
-- Starter trial at launch. Idempotent on the Polar order id.

create table if not exists early_access_signups (
  id uuid primary key,
  email text,
  provider_order_id text unique,
  created_at timestamptz not null default now()
);

create index if not exists early_access_signups_created_idx on early_access_signups (created_at desc);
