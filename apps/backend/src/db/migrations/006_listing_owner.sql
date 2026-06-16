-- Per-user ownership for tracked listings.
--
-- Previously tracked_listings was unique on (store_domain, listing_key) GLOBALLY,
-- so two customers tracking the same best-seller URL shared one row and one
-- snapshot history -- their runs interleaved and corrupted each other's
-- day-over-day diffs. Scope each listing to the user who tracks it.

alter table tracked_listings
  add column if not exists user_id uuid references users(id) on delete cascade;

-- Backfill every existing listing to the customer (the non-admin account) so the
-- current snapshot history stays attached and the next run still has a baseline
-- to diff against -- otherwise every product would read as direction:"new". With
-- one admin + one customer this picks the customer deterministically; if several
-- non-admin users existed it would pick the oldest.
update tracked_listings
   set user_id = (
     select id from users
      where role = 'user'
      order by created_at asc
      limit 1
   )
 where user_id is null;

-- Replace the global unique key with a per-owner one. COALESCE so any future
-- ownerless rows (operator / env-key runs, user_id = NULL) still dedupe into a
-- single bucket instead of multiplying, since NULLs are distinct in a plain
-- unique index.
alter table tracked_listings
  drop constraint if exists tracked_listings_store_domain_listing_key_key;

create unique index if not exists tracked_listings_owner_listing_idx
  on tracked_listings (
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    store_domain,
    listing_key
  );

create index if not exists tracked_listings_user_idx on tracked_listings (user_id);
