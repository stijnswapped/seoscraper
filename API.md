# SEOSCRAPE API — machine reference

Audience: an automated agent/integration (e.g. a Lovable app). Be exact. All shapes below
match the server implementation. Unknown/optional fields may be absent — never assume a
field exists; check before use.

## Connection
- **Base URL:** `https://seoscrapebackend-production.up.railway.app`
- **Auth:** send header `x-api-key: <API_KEY>` (equivalently `Authorization: Bearer <API_KEY>`)
  on every `/api/*` request EXCEPT `GET /api/check-progress/:runId` and `GET /health`.
- **Request content type:** `application/json` for every `POST` body.
- **Encoding:** UTF-8 JSON. Timestamps are ISO-8601 UTC strings (e.g. `2026-06-01T15:40:00.000Z`).

## Response envelope (every JSON endpoint)
- Success: HTTP `2xx`, body has `"success": true` plus endpoint-specific fields.
- Failure: body is exactly:
  ```ts
  { "success": false, "error": { "code": ErrorCode, "message": string } }
  ```
- `ErrorCode` ∈ `"INVALID_URL" | "DOMAIN_NOT_ALLOWED" | "PAGE_LOAD_FAILED" |
  "NO_PRODUCT_DATA_FOUND" | "IMAGE_DOWNLOAD_FAILED" | "OUTPUT_WRITE_FAILED" |
  "UNKNOWN_ERROR" | "NOT_FOUND" | "UNAUTHORIZED" | "AUTH_NOT_CONFIGURED"`.
- HTTP status mapping:
  - `400` → `INVALID_URL`, `DOMAIN_NOT_ALLOWED` (bad input; do NOT retry unchanged).
  - `401` → `UNAUTHORIZED` (bad/missing key; do NOT retry).
  - `404` → `NOT_FOUND` (unknown id).
  - `502` → `PAGE_LOAD_FAILED`, `NO_PRODUCT_DATA_FOUND`, other scrape failures (transient; retry with backoff).
  - `500` → `UNKNOWN_ERROR` (transient; retry with backoff).
- Retry policy: retry only `500`/`502`/network-timeout, max 2× with exponential backoff.
  Never retry `400`/`401`/`404`.

## Shared types
```ts
ListingSourceStrategy = "auto" | "html" | "shopify_json" | "both"
ListingSourceUsed     = "html" | "shopify_json" | "both"
ListingRankDirection  = "up" | "down" | "same" | "new" | "missing"

ListingRankItem = {
  rank: number            // 1-based position in best-selling order
  productKey: string      // STABLE identity. Always "handle:<handle>". Match on this.
                          // (productId, when known, is a separate attribute below — NOT the key.)
  url: string             // canonical product URL
  handle?: string         // Shopify product handle (slug)
  title?: string          // canonical product title (display only; may change between runs)
  titleSeo?: string       // storefront/SEO-flavored title as the grid renders it, e.g.
                          //   "H.D Balboa Shorts - Handsome Dans" (store-name suffix kept).
                          //   Toggle target vs `title`; falls back to `title` when the grid
                          //   exposes no distinct title. Display only.
  imageUrl?: string       // first/main product image URL
  productId?: string      // Shopify numeric product id (when known)
  source: ListingSourceUsed
}

ListingRankChange = {
  productKey: string
  url: string
  handle?: string
  title?: string
  previousRank: number | null   // null when direction = "new"
  currentRank: number | null    // null when direction = "missing"
  delta: number | null          // previousRank - currentRank; >0 = moved up; null for new/missing
  direction: ListingRankDirection
  previousSnapshotId: string | null
  currentSnapshotId: string
}

ExtractedField<T> = {
  value: T                // T is usually string | null
  source: string          // provenance, e.g. "title_tag", "og:title", "jsonld:Product.name", "h1"
  confidence: number      // 0..1
  warnings: string[]
}
```

---

## 1) `GET /health`
- Auth: none.
- Response `200`: `{ "ok": true }`.
- Use for liveness only.

---

## 2) `POST /api/listings/track`  — best-seller rank tracking (PRIMARY)
Scrapes a collection's best-selling order, captures rank+title+image+url per product,
stores a snapshot, and diffs it against the previous snapshot for that listing.

### Request body
| field | type | required | default | meaning / constraints |
|---|---|---|---|---|
| `url` | string | **yes** | — | Collection URL. MUST include `?sort_by=best-selling` to track best-sellers. |
| `sourceStrategy` | `ListingSourceStrategy` | no | `"both"` | Data source. Omit to get the default (best). See semantics below. |
| `maxProducts` | integer | no | `150` | Max products to capture. Range 1–250 (values outside are clamped). |
| `maxPages` | integer | no | `10` | Max collection pages to walk. Positive integer. |
| `runId` | string | no | — | Correlates with `GET /api/check-progress/:runId` SSE stream. |
| `enrich` | boolean | no | — | DEPRECATED/IGNORED. Tracking never does per-product scraping. |
| `proxy` | string | no | server default | Per-request proxy that overrides the server's `SCRAPE_PROXY_URL` for this scrape only (e.g. the customer's own residential proxy). Format `http://user:pass@host:port`. Rejected (`400`) if malformed or pointing at a loopback/private host. Credentials are never logged. |

`sourceStrategy` semantics:
- `"both"` / `"auto"` (recommended): best-selling **order** from server-rendered HTML
  (the `?sort_by=best-selling` URL is preserved, no JS) + **title/image/productId** merged
  in from `/collections/<x>/products.json` by handle. This is the only mode that returns
  reliable titles AND correct order.
- `"html"`: HTML order only; `title`/`imageUrl` may be `null` on image-only themes.
- `"shopify_json"`: products.json only. NOTE: this feed CANNOT sort — order is the store's
  default, NOT best-selling. A warning is emitted and `rawMetadata.orderReliable` is false.
  Avoid for ranking.

### Example request
```http
POST /api/listings/track
x-api-key: <API_KEY>
content-type: application/json

{ "url": "https://hausofmode.de/collections/all?sort_by=best-selling" }
```

### Response `200`
```ts
{
  "success": true,
  "enriching": false,                 // always false
  "result": {
    "kind": "listing_rank_snapshot",
    "snapshotId": string,             // id of THIS snapshot
    "trackedListingId": string,       // STABLE id per (storeDomain + path + sort_by). Persist it.
    "listingKey": string,             // e.g. "hausofmode.de|/collections/all|sort_by=best-selling"
    "storeDomain": string,
    "listingUrl": string,
    "sourceStrategy": ListingSourceStrategy,
    "sourceUsed": ListingSourceUsed,  // what actually produced the items
    "checkedAt": string,              // ISO timestamp of this run
    "items": ListingRankItem[],       // current ranking, ascending rank, length ≤ maxProducts
    "changes": ListingRankChange[],   // per-product diff vs the previous snapshot
    "summary": {
      "tracked": number,              // = items.length
      "new": number,                  // products not present last run
      "movedUp": number,
      "movedDown": number,
      "unchanged": number,
      "missing": number               // products present last run, absent now
    },
    "warnings": string[]              // non-fatal notes (e.g. order-unreliable, pagination)
  }
}
```

### Example response (abridged)
```json
{
  "success": true,
  "enriching": false,
  "result": {
    "kind": "listing_rank_snapshot",
    "snapshotId": "eb939748-ca62-4b9e-8fcc-72907963731a",
    "trackedListingId": "26bc00ce-531e-41c6-980b-d52a610741da",
    "listingKey": "hausofmode.de|/collections/all|sort_by=best-selling",
    "storeDomain": "hausofmode.de",
    "listingUrl": "https://hausofmode.de/collections/all?sort_by=best-selling",
    "sourceStrategy": "both",
    "sourceUsed": "both",
    "checkedAt": "2026-06-01T15:40:00.000Z",
    "items": [
      {
        "rank": 1,
        "productKey": "handle:du-wirst-immer-beschutzt-sein-boser-blick-halskette",
        "title": "\"Du wirst immer beschützt sein\" - Böser Blick Halskette",
        "titleSeo": "\"Du wirst immer beschützt sein\" - Böser Blick Halskette",
        "imageUrl": "https://hausofmode.de/cdn/shop/files/xxx.jpg",
        "url": "https://hausofmode.de/products/du-wirst-immer-beschutzt-sein-boser-blick-halskette",
        "handle": "du-wirst-immer-beschutzt-sein-boser-blick-halskette",
        "productId": "14852450484549",
        "source": "both"
      }
    ],
    "changes": [
      {
        "productKey": "handle:du-wirst-immer-beschutzt-sein-boser-blick-halskette",
        "title": "\"Du wirst immer beschützt sein\" - Böser Blick Halskette",
        "url": "https://hausofmode.de/products/du-wirst-immer-beschutzt-sein-boser-blick-halskette",
        "handle": "du-wirst-immer-beschutzt-sein-boser-blick-halskette",
        "previousRank": 3,
        "currentRank": 1,
        "delta": 2,
        "direction": "up",
        "previousSnapshotId": "8d7b040a-fef6-442c-bcae-51f10cd3e6b7",
        "currentSnapshotId": "eb939748-ca62-4b9e-8fcc-72907963731a"
      }
    ],
    "summary": { "tracked": 85, "new": 0, "movedUp": 1, "movedDown": 0, "unchanged": 84, "missing": 0 },
    "warnings": []
  }
}
```

### Semantics the integration MUST honor
- **First run for a listing:** there is no previous snapshot, so every entry in `changes`
  has `direction:"new"` and `previousRank:null`. From the 2nd run on, real diffs appear.
- **Identity:** join/compare products on `productKey` (stable). Do NOT key on `title`.
- **Server retention is minimal:** the backend keeps only the baseline (first) and the
  latest snapshot per `trackedListingId`. To build long-term history/graphs, the caller
  MUST persist `items` + `changes` + `checkedAt` for each run in its own store.
- **Errors:** `502 NO_PRODUCT_DATA_FOUND` (nothing extractable), `502 PAGE_LOAD_FAILED`
  (blocked/unreachable), `400 INVALID_URL`/`DOMAIN_NOT_ALLOWED`.

---

## 3) `GET /api/listings/:listingId/history`
- `:listingId` = `trackedListingId` (UUID).
- Auth: required.
- Response `200`:
  ```ts
  { "success": true, "result": {
      "listing": { "id": string, "storeDomain": string, "listingKey": string, "listingUrl": string },
      "snapshots": Array<{ "id": string, "checkedAt": string, "itemCount": number, "sourceUsed": ListingSourceUsed }>
  } }
  ```
- Returns **at most 2** snapshots (baseline + latest). Not a long-term history source.
- `404 NOT_FOUND` if the listing id is unknown.

## 4) `GET /api/listings/:listingId/latest`
- Auth: required.
- Response `200`:
  ```ts
  { "success": true, "result": {
      "listing": { "id": string, "storeDomain": string, "listingKey": string, "listingUrl": string },
      "snapshot": { "id": string, "checkedAt": string, "items": ListingRankItem[] }
  } }
  ```
- `404 NOT_FOUND` if no snapshot exists.

---

## 5) `POST /api/check-product`  — full single-product/collection research (HEAVY, on-demand)
Renders a page (headless browser, with a direct-fetch fallback), extracts full SEO +
product metadata, downloads + dedupes images to disk, returns file URLs.

### Request body
| field | type | required | default | meaning |
|---|---|---|---|---|
| `url` | string | **yes** | — | A product URL (kind `"product"`) or a collection URL (kind `"collection"`, scrapes each product — heavy). |
| `responseMode` | `"full" \| "url"` | no | `"full"` | `"full"` returns the whole result object; `"url"` returns only file links. |
| `maxPages` | integer | no | `10` | Pages to crawl for a collection URL. |
| `proxy` | string | no | server default | Per-request proxy overriding `SCRAPE_PROXY_URL` for this scrape only. Same format/validation/redaction as the tracker's `proxy` field above. |
| `runId` | string | no | — | Correlates with the SSE progress stream. |

### Response `200` — `responseMode:"full"`
```ts
{
  "success": true,
  "fileBaseUrl": string,   // absolute, e.g. "https://<host>/files/runs/<runId>"
  "dataUrl": string,       // absolute, "<fileBaseUrl>/data.json"
  "result": CheckResult
}
```
### Response `200` — `responseMode:"url"`
```ts
{ "success": true, "kind": "product" | "collection", "fileBaseUrl": string, "dataUrl": string,
  "summary"?: { "discovered": number, "succeeded": number, "failed": number } }  // summary only for collections
```

### `CheckResult` (discriminated by `kind`)
```ts
ProductCheckResult = {
  kind: "product"
  inputUrl: string
  finalUrl: string
  domain: string
  checkedAt: string
  seo: {
    title: ExtractedField<string|null>          // the page <title> when source="title_tag"
    description: ExtractedField<string|null>
    canonicalUrl: ExtractedField<string|null>
    openGraph: Record<string,string>            // e.g. {"og:title":..,"og:image":..}
    twitter: Record<string,string>
  }
  seoSnapshot: { /* flattened SEO record: title, description, canonicalUrl, productTitle,
                    productDescription, openGraph, twitter, structuredData, downloadedImages[] */ }
  product: {
    title: ExtractedField<string|null>          // product NAME (jsonld Product.name > og:title > h1)
    description: ExtractedField<string|null>
    structuredData: unknown[]                   // JSON-LD Product/Offer/etc nodes
  }
  images: {
    discovered: Array<{ url, normalizedUrl, source, alt?, width?, height?, contentType? }>
    downloaded: Array<{ originalUrl, filePath, filename, bytes, width?, height?, sha256, perceptualHash?, groupId?, reason }>
    skipped: Array<{ originalUrl, reason, similarTo?, confidence? }>
    strategy: { mode: "selective"|"download_all_fallback"|"worker_url_only", reason, groups[] }
  }
  files: { outputDir, dataJsonPath, seoJsonPath, rawHtmlPath, rawMetadataPath }  // server paths; nullable
  warnings: string[]
  errors: string[]
}

CollectionCheckResult = {
  kind: "collection"
  inputUrl, finalUrl, domain, checkedAt
  discoveredProductUrls: string[]
  products: Array<
      { url, success: true, result: ProductCheckResult, fileBaseUrl: string|null }
    | { url, success: false, error: { code: ErrorCode, message: string } }
  >
  summary: { discovered: number, succeeded: number, failed: number }
  warnings: string[]; errors: string[]
}
```
### How to use the result
- Page title: `result.seo.title.value`. Product name: `result.product.title.value`.
- Main image (hosted copy): `` `${fileBaseUrl}/${result.images.downloaded[0].filePath}` `` → e.g. `.../files/runs/<id>/images/001-main.jpg`.
- Or source URL on the store: `result.images.downloaded[0].originalUrl`.
- **Files are TEMPORARY:** run folders under `fileBaseUrl` are deleted after `RUN_RETENTION_DAYS`
  (default 7 days) and capped at the newest `RUN_MAX_COUNT` (default 300). Download/persist
  anything you need to keep promptly.

---

## 6) `GET /api/check-progress/:runId`  — live progress (Server-Sent Events)
- Auth: none. Content-Type `text/event-stream`.
- Pass the same `runId` you sent in a `POST /api/check-product` or `/api/listings/track`
  body, then open an `EventSource` here.
- Each event line: `data: ` + JSON of:
  ```ts
  { "phase": string, "message": string, "url"?: string, "current"?: number, "total"?: number }
  ```
- A terminal event with `phase:"complete"` is sent when the run finishes. Optional; not
  required for correctness.

---

## 7) `POST /api/admin/cleanup-runs`  — free disk (research files)
- Auth: required.
- Body: `{ "olderThanDays"?: number }`. Omit or `0` → delete ALL run folders; `>0` → delete
  runs older than N days.
- Response `200`: `{ "success": true, "removed": number, "scope": string }`.
- Safe: run folders are regenerable; rank tracking stores nothing on disk.

## 8) `GET /api/admin/storage`  — read-only disk usage
- Auth: required.
- Response `200`: `{ "success": true, "runs": number, "freeBytes": number|null, "totalBytes": number|null, "usedPct": number|null }`.

## 9) `GET /files/runs/<runId>/...`  — static run artifacts
- Auth: none (unguessable run id). Serves `data.json`, `seo.json`, `images/*`, `raw/page.html`.
- Subject to the same retention as §5.

---

## Operating rules (for the calling system)
1. **Scheduling:** the backend has no scheduler. The caller triggers runs. For daily rank
   tracking, run a once-per-day job per tracked `url`.
2. **Concurrency / backpressure:** the backend has no internal queue. Do NOT fire all
   listings at once. Use ≤ 3 concurrent `track` calls, a per-call timeout of ~120s, and
   the retry policy above. Heavy `check-product` calls: ≤ 1–2 concurrent.
3. **Persistence:** treat the backend as stateless beyond baseline+latest. Persist every
   run's `items`/`changes`/`checkedAt` in the caller's database for history.
4. **Identity:** always key products on `productKey`.
5. **URL:** always include `?sort_by=best-selling` for ranking.
6. **Defaults:** omit `sourceStrategy` and `maxProducts` to get `both` + `150`.
