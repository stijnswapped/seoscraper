# SEOSCRAPE API — Agent Integration Guide

This document is written for an AI agent (or any programmatic client) that needs
to call the SEOSCRAPE API. It specifies exactly how to authenticate, which
endpoint to choose, the precise request/response schemas, and how to act on the
results.

If you are an LLM/agent, read the **Decision guide** first, then use the
**per-endpoint contracts**. Every request and response shape below is exact.

---

## 1. Connection basics

- **Base URL**: provided by the operator.
  - Local: `http://127.0.0.1:3001`
  - Railway: `https://<service>.up.railway.app`
- **Protocol**: HTTP/1.1, JSON request and response bodies (except the SSE
  stream and static files).
- **Content type**: send `Content-Type: application/json` on every `POST`.
- **Max request body**: 1 MB.
- **Encoding**: UTF-8.

### Authentication

Some endpoints require an API key **if and only if** the server was started with
one configured (`API_KEY` env var set, or `REQUIRE_API_KEY=true`). If you receive
`401 UNAUTHORIZED`, you must supply the key; if you receive success without a key,
auth is disabled on that server.

Provide the key using **either** header (Bearer is preferred):

```
Authorization: Bearer <API_KEY>
```
```
x-api-key: <API_KEY>
```

| Endpoint | Method | Auth required when key configured |
|---|---|---|
| `/health` | GET | No |
| `/` , `/dashboard` | GET | No (HTML UI) |
| `/api/check-product` | POST | **Yes** |
| `/api/check-progress/:runId` | GET (SSE) | No |
| `/api/listings/track` | POST | **Yes** |
| `/api/listings/:listingId/latest` | GET | **Yes** |
| `/api/listings/:listingId/history` | GET | **Yes** |
| `/files/runs/:runId/*` | GET | No (static files) |

---

## 2. Decision guide (which endpoint to call)

```
Need server liveness?                      -> GET /health
Have a product OR collection page URL?      -> POST /api/check-product
  (the server auto-detects which; inspect result.kind in the response)
Want live progress while a check runs?      -> open GET /api/check-progress/:runId
                                               with a runId you generate, then
                                               POST /api/check-product with that runId
Track best-seller rank order over time?     -> POST /api/listings/track   (needs DB)
Read a previously tracked listing?          -> GET /api/listings/:id/latest | /history
Fetch a downloaded image / saved file?      -> GET <fileBaseUrl>/<filePath>
```

Notes:
- You do **not** decide between "product" vs "collection" yourself — send the URL
  to `/api/check-product` and branch on `result.kind` (`"product"` or
  `"collection"`).
- The listing tracker endpoints return errors unless the server has a database
  (`DATABASE_URL`) configured.

---

## 3. Universal response envelope

Every JSON endpoint returns one of these two shapes.

**Success**
```json
{ "success": true, "result": { /* endpoint-specific */ }, "fileBaseUrl": "/files/runs/<runId>" }
```
- `fileBaseUrl` is present only for single-product results.

**Error**
```json
{ "success": false, "error": { "code": "<ERROR_CODE>", "message": "<human text>" } }
```

Always check `success` (boolean) first. Do not parse `result` when `success` is
`false`.

### Error codes (stable enum)

| `error.code` | HTTP | Meaning | Agent action |
|---|---|---|---|
| `INVALID_URL` | 400 | URL missing/malformed, or invalid body | Fix the URL/body; do not retry verbatim. |
| `DOMAIN_NOT_ALLOWED` | 400 | Host not allowlisted, or a private/loopback IP | Use an allowed public host. Not retryable. |
| `PAGE_LOAD_FAILED` | 502 | Render failed or upstream returned ≥400 | Retry later (transient) up to a small limit. |
| `NO_PRODUCT_DATA_FOUND` | 502 | No product/listing data extracted | Likely wrong page type. Not retryable as-is. |
| `IMAGE_DOWNLOAD_FAILED` | 502 | Image fetch/processing failed | Often partial; inspect `result` if present. |
| `OUTPUT_WRITE_FAILED` | 502 | Could not persist run to disk | Server/infra issue; retry later. |
| `UNAUTHORIZED` | 401 | Missing/invalid API key | Add the `Authorization` header. |
| `AUTH_NOT_CONFIGURED` | 500 | Auth required but server misconfigured | Operator must set `API_KEY`. |
| `NOT_FOUND` | 404 | Listing/snapshot id unknown | Use a valid id from a prior `track` call. |
| `UNKNOWN_ERROR` | 500 | Unexpected failure | Retry once; then report. |

---

## 4. Shared type definitions

These types are referenced by the endpoint contracts below.

```ts
// A value plus where it came from and how confident the extractor is.
ExtractedField<T> = {
  value: T;            // T is string | null for SEO/product fields
  source: string;      // e.g. "title_tag", "og:title", "jsonld:Product.name", "meta_description"
  confidence: number;  // 0..1 (higher = more authoritative source)
  warnings: string[];
}

DiscoveredImage = {
  url: string;            // raw URL as found
  normalizedUrl: string;  // absolute, tracking-stripped URL
  source: string;         // "jsonld" | "og:image" | "twitter:image" | "img" | "srcset" | "data-src" | "preload" | "css-bg" | ...
  alt?: string;
  width?: number; height?: number; contentType?: string;
}

DownloadedImage = {
  originalUrl: string;
  filePath: string;       // RELATIVE path under the run, e.g. "images/001-main.jpg"
  filename: string;       // e.g. "001-main.jpg"
  bytes: number;
  width?: number; height?: number;
  sha256: string;
  perceptualHash?: string;
  groupId?: string;       // images sharing a groupId are the same visual view
  reason: string;         // why it was kept
}

SkippedImage = {
  originalUrl: string;
  reason: string;
  similarTo?: string;     // the representative it duplicated
  confidence?: number;
}

ImageSelectionStrategyReport = {
  mode: "selective" | "download_all_fallback";
  reason: string;
  groups: Array<{ groupId: string; representativeImage: string; imageCount: number; reason: string }>;
}
```

---

## 5. Endpoint contracts

### 5.1 `GET /health`

Liveness probe. No auth.

Response `200`:
```json
{ "ok": true }
```

---

### 5.2 `POST /api/check-product`

Render a URL and extract SEO + product data + images. Auto-detects product vs
collection. **Auth required when configured.**

**Request body schema**
```ts
{
  url: string;     // required, non-empty, http(s)
  runId?: string;  // optional; supply to receive SSE progress on /api/check-progress/:runId
}
```

**Call**
```bash
curl -s -X POST "$BASE/api/check-product" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://store.com/products/black-linen-dress"}'
```

**Response — single product** (`result.kind === "product"`)
```ts
{
  success: true,
  fileBaseUrl: string,   // e.g. "/files/runs/20260529t101500z-store-com-1a2b3c4d"
  result: {
    kind: "product",
    inputUrl: string,
    finalUrl: string,        // after redirects
    domain: string,
    checkedAt: string,       // ISO 8601
    seo: {
      title:        ExtractedField<string|null>,
      description:  ExtractedField<string|null>,
      canonicalUrl: ExtractedField<string|null>,
      openGraph:    Record<string,string>,   // e.g. {"og:title": "...","og:image":"..."}
      twitter:      Record<string,string>
    },
    seoSnapshot: { /* flattened SEO+image summary, same data condensed */ },
    product: {
      title:       ExtractedField<string|null>,
      description: ExtractedField<string|null>,
      structuredData: unknown[]   // JSON-LD Product/Offer/ImageObject/BreadcrumbList nodes
    },
    images: {
      discovered: DiscoveredImage[],
      downloaded: DownloadedImage[],
      skipped:    SkippedImage[],
      strategy:   ImageSelectionStrategyReport
    },
    files: {
      outputDir: string,        // absolute server path
      dataJsonPath: string,
      seoJsonPath: string,
      rawHtmlPath: string,
      rawMetadataPath: string
    },
    warnings: string[],
    errors: string[]
  }
}
```

**How to read the result (agent rules):**
- Prefer `product.title.value` / `product.description.value`; fall back to
  `seo.title.value` / `seo.description.value` if product fields are `null`.
- Trust higher `confidence`. A `source` starting with `jsonld:` is the most
  authoritative; `dom_*` sources are heuristic guesses — surface their
  `warnings`.
- To display/download an image, build its URL as
  **`<BASE><fileBaseUrl>/<DownloadedImage.filePath>`**
  e.g. `https://host/files/runs/<runId>/images/001-main.jpg`.
- `images.strategy.mode === "download_all_fallback"` means dedup was
  inconclusive and all valid images were kept (read `strategy.reason`).
- A non-empty `result.errors` array (e.g. contains `NO_PRODUCT_DATA_FOUND`) means
  extraction was weak even though the HTTP call succeeded.

**Response — collection** (`result.kind === "collection"`)
```ts
{
  success: true,
  result: {
    kind: "collection",
    inputUrl: string, finalUrl: string, domain: string, checkedAt: string,
    discoveredProductUrls: string[],
    products: Array<
      | { url: string; success: true;  result: <product result>; fileBaseUrl: string }
      | { url: string; success: false; error: { code: string; message: string } }
    >,
    summary: { discovered: number; succeeded: number; failed: number },
    warnings: string[],
    errors: string[]
  }
}
```
- Iterate `products`; each item has its own `success` flag. Per-product files use
  that item's `fileBaseUrl`.
- Product count is capped by the server's `MAX_COLLECTION_PRODUCTS`.

---

### 5.3 `GET /api/check-progress/:runId` (Server-Sent Events)

Optional real-time progress for an in-flight `check-product` call. No auth.
`Content-Type: text/event-stream`.

**Usage pattern (order matters):**
1. Generate a unique `runId` (e.g. a UUID).
2. Open the SSE connection to `/api/check-progress/<runId>`.
3. `POST /api/check-product` with the same `runId` in the body.
4. Read events until the POST resolves, then close the stream.

Each SSE `message` event's `data` is a JSON object:
```ts
{
  phase: string,     // see list below
  message: string,
  url?: string,
  current?: number,  // for collection progress
  total?: number
}
```
Phases: `queued`, `loading`, `loaded`, `collection-discovered`,
`product-start`, `loading-product`, `loaded-product`, `extracting-seo`,
`discovering-images`, `downloading-images`, `saving`, `writing-files`,
`product-complete`, `product-failed`, `failed`.

The authoritative result is always the JSON returned by the `POST`, not the
stream. Treat SSE as advisory UI/telemetry only.

---

### 5.4 `POST /api/listings/track` (requires server `DATABASE_URL`)

Capture the current ranked order of products on a sorted/best-seller listing and
diff it against the previous snapshot. **Auth required when configured.**

**Request body schema**
```ts
{
  url: string;                                              // required
  sourceStrategy?: "auto" | "html" | "shopify_json" | "both"; // default "auto"
  maxProducts?: number;                                     // 1..250, default 100
}
```

**Call**
```bash
curl -s -X POST "$BASE/api/listings/track" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://store.com/collections/all?sort_by=best-selling","sourceStrategy":"auto"}'
```

**Response** (`result.kind === "listing_rank_snapshot"`)
```ts
{
  success: true,
  result: {
    kind: "listing_rank_snapshot",
    snapshotId: string,         // this capture
    trackedListingId: string,   // STABLE id — store it to query history later
    listingKey: string,
    storeDomain: string,
    listingUrl: string,
    sourceStrategy: "auto"|"html"|"shopify_json"|"both",
    sourceUsed: "html"|"shopify_json"|"both",
    checkedAt: string,          // ISO 8601
    items: Array<{
      rank: number, productKey: string, url: string,
      handle?: string, title?: string, imageUrl?: string, productId?: string,
      source: "html"|"shopify_json"|"both"
    }>,
    changes: Array<{
      productKey: string, url: string, handle?: string, title?: string,
      previousRank: number|null, currentRank: number|null,
      delta: number|null,                       // positive = moved up
      direction: "up"|"down"|"same"|"new"|"missing",
      previousSnapshotId: string|null, currentSnapshotId: string
    }>,
    summary: { tracked: number, new: number, movedUp: number, movedDown: number, unchanged: number, missing: number },
    warnings: string[]
  }
}
```
- **Persist `trackedListingId`** — it is required for the read endpoints below.
- The first ever call for a listing has all `changes[].direction === "new"`.

---

### 5.5 `GET /api/listings/:listingId/latest` (requires DB)

Return the listing and its most recent snapshot with ranked items. Auth required
when configured. `:listingId` must be the `trackedListingId` UUID.

```bash
curl -s "$BASE/api/listings/<uuid>/latest" -H "Authorization: Bearer $API_KEY"
```
```ts
{ success: true, result: {
  listing: { /* tracked listing row */ },
  snapshot: { id: string, checkedAt: string, items: ListingRankItem[] }
}}
```
`404 NOT_FOUND` if the id is unknown or has no snapshots.

---

### 5.6 `GET /api/listings/:listingId/history` (requires DB)

Return the listing and up to 50 recent snapshot metadata records. Auth required
when configured.

```bash
curl -s "$BASE/api/listings/<uuid>/history" -H "Authorization: Bearer $API_KEY"
```
```ts
{ success: true, result: { listing: {...}, snapshots: Array<{ id: string, checkedAt: string, ... }> } }
```

---

### 5.7 `GET /files/runs/:runId/*`

Static file server over the output directory. No auth. Use it to fetch any saved
artifact of a run:

```
<BASE>/files/runs/<runId>/data.json
<BASE>/files/runs/<runId>/seo.json
<BASE>/files/runs/<runId>/raw/page.html
<BASE>/files/runs/<runId>/raw/metadata.json
<BASE>/files/runs/<runId>/images/001-main.jpg
```
Construct image URLs as `<BASE><fileBaseUrl>/<DownloadedImage.filePath>`.

---

## 6. End-to-end agent example (pseudocode)

```python
import requests, json

BASE = "https://host"
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

def check(url):
    r = requests.post(f"{BASE}/api/check-product",
                      headers=HEADERS, data=json.dumps({"url": url}), timeout=120)
    body = r.json()
    if not body["success"]:
        raise RuntimeError(f'{body["error"]["code"]}: {body["error"]["message"]}')
    res = body["result"]

    if res["kind"] == "collection":
        for p in res["products"]:
            if p["success"]:
                handle_product(p["result"], BASE + p["fileBaseUrl"])
        return

    handle_product(res, BASE + body["fileBaseUrl"])

def handle_product(res, file_base):
    title = res["product"]["title"]["value"] or res["seo"]["title"]["value"]
    desc  = res["product"]["description"]["value"] or res["seo"]["description"]["value"]
    image_urls = [f'{file_base}/{img["filePath"]}' for img in res["images"]["downloaded"]]
    # ... use title, desc, image_urls ...
```

## 7. Operational expectations

- A `check-product` call may take **several seconds to a minute** (full browser
  render + image downloads). Use a client timeout of ≥120s.
- Retry only on transient codes (`PAGE_LOAD_FAILED`, `OUTPUT_WRITE_FAILED`,
  `UNKNOWN_ERROR`) with backoff; never retry `INVALID_URL` or
  `DOMAIN_NOT_ALLOWED` unchanged.
- Image selection is deterministic (SHA-256 + perceptual hash + SSIM + edge-map);
  no AI/ML or external analysis APIs are involved.
- See `RAILWAY_SETUP.md` for deployment and environment configuration.
```
