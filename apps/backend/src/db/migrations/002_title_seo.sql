-- Storefront/SEO-flavored grid title, kept alongside the canonical product title
-- so consumers can toggle between them. Additive + nullable: safe on existing rows.
alter table listing_snapshot_items add column if not exists title_seo text;
