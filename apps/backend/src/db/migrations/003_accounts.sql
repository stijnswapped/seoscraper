-- Accounts, API keys, sessions, and usage tracking.
-- IDs are generated app-side with crypto.randomUUID() (matching 001/002), so no
-- pgcrypto/uuid-ossp extension is required.

create table if not exists users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  role text not null default 'user',          -- 'user' | 'admin'
  -- The customer's own proxy, encrypted at rest (AES-256-GCM). NULL = use the
  -- server's env proxy. A per-request `proxy` field still overrides this.
  proxy_url_encrypted text,
  created_at timestamptz not null default now()
);

-- One row per issued API key. The plaintext key is shown to the user once and
-- never stored; we keep only its SHA-256 hash plus the embedded {UID} (used for
-- O(1) lookup) and a display prefix.
create table if not exists api_keys (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  uid text not null unique,                    -- the {UID} segment embedded in the key
  key_hash text not null,                      -- sha256(full key), hex
  key_prefix text not null,                    -- "SEO-Stijn-Scrape-v2-{UID}" for display
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists api_keys_uid_idx on api_keys (uid);

-- Dashboard login sessions (httpOnly cookie). We store only the token hash.
create table if not exists sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,                    -- sha256(session token), hex
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists sessions_token_hash_idx on sessions (token_hash);
create index if not exists sessions_user_idx on sessions (user_id);

-- One row per billable scrape call, for the per-account usage graphs.
create table if not exists usage_events (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  api_key_id uuid references api_keys(id) on delete set null,
  ts timestamptz not null default now(),
  endpoint text not null,                      -- e.g. '/api/listings/track'
  status integer,
  ok boolean,
  duration_ms integer,
  used_proxy text,                             -- 'request' | 'user' | 'env' | 'none'
  detail jsonb not null default '{}'::jsonb
);
create index if not exists usage_events_user_ts_idx on usage_events (user_id, ts);
