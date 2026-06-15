-- One-time signup invites. An admin generates an invite (optionally pinning the
-- email and role); the person uses the link to create their own account. The
-- invite is single-use: once an account is created from it, used_at is set and
-- it can't be reused. We store only the SHA-256 hash of the invite token.

create table if not exists invites (
  id uuid primary key,
  token_hash text not null unique,
  email text,                                  -- optional: pin the account email
  role text not null default 'user',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_user_id uuid references users(id) on delete set null
);
create index if not exists invites_token_hash_idx on invites (token_hash);
