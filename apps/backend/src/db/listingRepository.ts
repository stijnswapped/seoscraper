import { randomUUID } from "node:crypto";
import { query } from "./postgres.js";
import type {
  ListingRankItem,
  ListingSourceStrategy,
  ListingSourceUsed,
} from "../types/productCheck.js";

type TrackedListingRow = {
  id: string;
  store_domain?: string;
  listing_key?: string;
  listing_url?: string;
};

type SnapshotRow = {
  id: string;
  checked_at: Date;
};

type SnapshotItemRow = {
  snapshot_id: string;
  rank: number;
  product_key: string;
  product_id: string | null;
  handle: string | null;
  url: string;
  title: string | null;
  title_seo: string | null;
  image_url: string | null;
  source: ListingSourceUsed;
};

export interface PreviousSnapshot {
  id: string;
  checkedAt: string;
  items: ListingRankItem[];
}

export interface TrackedListingRecord {
  id: string;
  storeDomain: string;
  listingKey: string;
  listingUrl: string;
}

export interface ListingSnapshotSummary {
  id: string;
  checkedAt: string;
  itemCount: number;
  sourceUsed: ListingSourceUsed;
}

export async function upsertTrackedListing(input: {
  userId: string | null;
  storeDomain: string;
  listingKey: string;
  listingUrl: string;
}): Promise<string> {
  const id = randomUUID();
  // Conflict target mirrors the per-owner unique index in migration 006
  // (COALESCE so ownerless rows still dedupe). One row per (owner, listing).
  const result = await query<TrackedListingRow>(
    `insert into tracked_listings (id, user_id, store_domain, listing_key, listing_url)
     values ($1, $2, $3, $4, $5)
     on conflict (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), store_domain, listing_key)
     do update set listing_url = excluded.listing_url
     returning id`,
    [id, input.userId, input.storeDomain, input.listingKey, input.listingUrl],
  );
  const trackedListingId = result.rows[0]?.id;
  if (!trackedListingId) throw new Error("Could not upsert tracked listing.");
  return trackedListingId;
}

export async function getLatestSnapshot(
  trackedListingId: string,
): Promise<PreviousSnapshot | null> {
  const snapshot = await query<SnapshotRow>(
    `select id, checked_at
     from listing_snapshots
     where tracked_listing_id = $1
     order by checked_at desc
     limit 1`,
    [trackedListingId],
  );
  const row = snapshot.rows[0];
  if (!row) return null;

  const items = await query<SnapshotItemRow>(
    `select snapshot_id, rank, product_key, product_id, handle, url, title, title_seo, image_url, source
     from listing_snapshot_items
     where snapshot_id = $1
     order by rank asc`,
    [row.id],
  );

  return {
    id: row.id,
    checkedAt: row.checked_at.toISOString(),
    items: items.rows.map(rowToItem),
  };
}

/**
 * Fetch a tracked listing by id. Pass `ownerId` (the authenticated user) to
 * enforce ownership: a real user only sees their own listings, while a null
 * `ownerId` (operator / env-key) is unrestricted. This closes the cross-tenant
 * read on the /history and /latest endpoints.
 */
export async function getTrackedListing(
  trackedListingId: string,
  ownerId: string | null = null,
): Promise<TrackedListingRecord | null> {
  const result = await query<{
    id: string;
    store_domain: string;
    listing_key: string;
    listing_url: string;
  }>(
    `select id, store_domain, listing_key, listing_url
     from tracked_listings
     where id = $1 and ($2::uuid is null or user_id = $2)`,
    [trackedListingId, ownerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    storeDomain: row.store_domain,
    listingKey: row.listing_key,
    listingUrl: row.listing_url,
  };
}

export async function getLatestSnapshots(
  trackedListingId: string,
  limit: number,
): Promise<ListingSnapshotSummary[]> {
  const result = await query<{
    id: string;
    checked_at: Date;
    item_count: number;
    source_used: ListingSourceUsed;
  }>(
    `select id, checked_at, item_count, source_used
     from listing_snapshots
     where tracked_listing_id = $1
     order by checked_at desc
     limit $2`,
    [trackedListingId, limit],
  );

  return result.rows.map((row: {
    id: string;
    checked_at: Date;
    item_count: number;
    source_used: ListingSourceUsed;
  }) => ({
    id: row.id,
    checkedAt: row.checked_at.toISOString(),
    itemCount: row.item_count,
    sourceUsed: row.source_used,
  }));
}

export async function getSnapshotItems(snapshotId: string): Promise<ListingRankItem[]> {
  const items = await query<SnapshotItemRow>(
    `select snapshot_id, rank, product_key, product_id, handle, url, title, title_seo, image_url, source
     from listing_snapshot_items
     where snapshot_id = $1
     order by rank asc`,
    [snapshotId],
  );
  return items.rows.map(rowToItem);
}

export async function createSnapshot(input: {
  trackedListingId: string;
  sourceStrategy: ListingSourceStrategy;
  sourceUsed: ListingSourceUsed;
  items: ListingRankItem[];
  rawMetadata: Record<string, unknown>;
}): Promise<{ id: string; checkedAt: string }> {
  const id = randomUUID();
  const snapshot = await query<SnapshotRow>(
    `insert into listing_snapshots (
       id,
       tracked_listing_id,
       source_strategy,
       source_used,
       item_count,
       raw_metadata
     ) values ($1, $2, $3, $4, $5, $6::jsonb)
     returning id, checked_at`,
    [
      id,
      input.trackedListingId,
      input.sourceStrategy,
      input.sourceUsed,
      input.items.length,
      JSON.stringify(input.rawMetadata),
    ],
  );

  for (const item of input.items) {
    await query(
      `insert into listing_snapshot_items (
         snapshot_id,
         rank,
         product_key,
         product_id,
         handle,
         url,
         title,
         title_seo,
         image_url,
         source
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        item.rank,
        item.productKey,
        item.productId ?? null,
        item.handle ?? null,
        item.url,
        item.title ?? null,
        item.titleSeo ?? null,
        item.imageUrl ?? null,
        item.source,
      ],
    );
  }

  const row = snapshot.rows[0];
  if (!row) throw new Error("Could not create listing snapshot.");
  return { id: row.id, checkedAt: row.checked_at.toISOString() };
}

export async function getSnapshotsForListing(
  trackedListingId: string,
  limit: number,
): Promise<ListingSnapshotSummary[]> {
  return getLatestSnapshots(trackedListingId, limit);
}

/**
 * Keep storage flat: retain only the baseline (oldest) and latest (newest)
 * snapshot for a listing and delete the rest. Items cascade-delete via the
 * `on delete cascade` FK. Returns the number of snapshots deleted.
 */
export async function pruneSnapshots(trackedListingId: string): Promise<number> {
  const result = await query(
    `delete from listing_snapshots s
     where s.tracked_listing_id = $1
       and s.id <> (select id from listing_snapshots where tracked_listing_id = $1 order by checked_at asc,  id asc  limit 1)
       and s.id <> (select id from listing_snapshots where tracked_listing_id = $1 order by checked_at desc, id desc limit 1)`,
    [trackedListingId],
  );
  return result.rowCount ?? 0;
}

function rowToItem(row: SnapshotItemRow): ListingRankItem {
  return {
    rank: row.rank,
    productKey: row.product_key,
    url: row.url,
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.title_seo ? { titleSeo: row.title_seo } : {}),
    ...(row.image_url ? { imageUrl: row.image_url } : {}),
    ...(row.product_id ? { productId: row.product_id } : {}),
    source: row.source,
  };
}
