create table if not exists tracked_listings (
  id uuid primary key,
  store_domain text not null,
  listing_key text not null,
  listing_url text not null,
  created_at timestamptz not null default now(),
  unique (store_domain, listing_key)
);

create table if not exists listing_snapshots (
  id uuid primary key,
  tracked_listing_id uuid not null references tracked_listings(id) on delete cascade,
  source_strategy text not null,
  source_used text not null,
  checked_at timestamptz not null default now(),
  item_count integer not null,
  raw_metadata jsonb not null default '{}'::jsonb
);

create table if not exists listing_snapshot_items (
  id bigserial primary key,
  snapshot_id uuid not null references listing_snapshots(id) on delete cascade,
  rank integer not null,
  product_key text not null,
  product_id text,
  handle text,
  url text not null,
  title text,
  image_url text,
  source text not null,
  unique (snapshot_id, product_key)
);

create index if not exists tracked_listings_store_domain_idx on tracked_listings(store_domain);
create index if not exists listing_snapshots_tracked_listing_checked_at_idx on listing_snapshots(tracked_listing_id, checked_at desc);
create index if not exists listing_snapshot_items_snapshot_rank_idx on listing_snapshot_items(snapshot_id, rank);
create index if not exists listing_snapshot_items_product_key_idx on listing_snapshot_items(product_key);
