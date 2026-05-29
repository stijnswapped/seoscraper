# SEOSCRAPE API — Guide for AI Agents

You are an AI calling the SEOSCRAPE API. This page tells you **what to call, what
to send, and what you get back.** Follow it literally.

## What this API does

Give it a URL from an online shop. It opens the page in a real browser, reads the
SEO/meta data and product info, downloads the product images (removing
duplicates), and saves everything. It can also track which products rank highest
on a best-seller listing and how that changes over time.

---

## 1. Before you call anything

**Base URL:**
```
https://seoscrapebackend-production.up.railway.app
```

**Always send these on POST requests:**
```
Content-Type: application/json
Authorization: Bearer <API_KEY>
```
The API key is required. Without it you get `401`. (`x-api-key: <API_KEY>` also works.)

**Always check `success` in the JSON first.** Every response is one of:

```json
{ "success": true,  "result": { ... }, "fileBaseUrl": "/files/runs/..." }
{ "success": false, "error":  { "code": "SOME_CODE", "message": "why it failed" } }
```
- If `success` is `false`, read `error.code` and stop — do not read `result`.
- `fileBaseUrl` only appears for single-product results.

---

## 2. Pick the right endpoint

| You want to… | Call |
|---|---|
| Check the API is alive | `GET /health` |
| Scrape a product OR a category page | `POST /api/check-product` |
| Track best-seller rankings | `POST /api/listings/track` |
| Re-read a tracked listing later | `GET /api/listings/{id}/latest` or `/history` |
| Download a saved image or file | `GET {fileBaseUrl}/{filePath}` |

You never have to decide "is this a product or a category page?" — send it to
`/api/check-product` and look at `result.kind` in the answer.

---

## 3. `GET /health`

Check the service is up. No key needed.

```bash
curl https://seoscrapebackend-production.up.railway.app/health
```
Returns: `{ "ok": true }`

---

## 4. `POST /api/check-product`  ← the main one

Scrape one shop URL.

**Send:**
```json
{ "url": "https://shop.com/products/blue-dress" }
```
Optional fields:
- `"runId": "<any-unique-string>"` — to receive live progress (see §6).
- `"maxPages": <number>` — for a **collection/category** URL, how many listing pages
  to walk (follows pagination + auto-scroll). Defaults to the server's
  `MAX_COLLECTION_PAGES` (10), capped at the server ceiling. Ignored for a single
  product page. Crawling also stops once `MAX_COLLECTION_PRODUCTS` is reached.

**Example:**
```bash
curl -X POST https://seoscrapebackend-production.up.railway.app/api/check-product \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://shop.com/products/blue-dress"}'
```

**What you get back depends on `result.kind`:**

### A) `result.kind === "product"` — a single product page

```jsonc
{
  "success": true,
  "fileBaseUrl": "/files/runs/20260529t163141z-shop-com-60be737d",
  "result": {
    "kind": "product",
    "finalUrl": "https://shop.com/products/blue-dress",  // after redirects
    "domain": "shop.com",
    "checkedAt": "2026-05-29T16:31:41.000Z",

    // SEO/meta. Each field = { value, source, confidence (0-1), warnings[] }.
    // "value" is null if not found. Higher confidence = more trustworthy source.
    "seo": {
      "title":        { "value": "Blue Dress | Shop", "source": "title_tag",       "confidence": 0.95, "warnings": [] },
      "description":  { "value": "A blue dress…",      "source": "meta_description", "confidence": 0.9,  "warnings": [] },
      "canonicalUrl": { "value": "https://shop.com/products/blue-dress", "source": "canonical_link", "confidence": 0.95, "warnings": [] },
      "openGraph": { "og:title": "Blue Dress", "og:image": "https://…" },  // raw OG tags
      "twitter":   { "twitter:card": "summary_large_image" }              // raw Twitter tags
    },

    // The product itself (prefer these over seo.* for the product name/text).
    "product": {
      "title":       { "value": "Blue Dress", "source": "jsonld:Product.name", "confidence": 0.95, "warnings": [] },
      "description": { "value": "…",          "source": "jsonld:Product.description", "confidence": 0.95, "warnings": [] },
      "structuredData": [ { "@type": "Product", "name": "…" } ]  // raw JSON-LD nodes
    },

    // Images. "downloaded" = the de-duplicated set actually saved to disk.
    "images": {
      "discovered": [ { "normalizedUrl": "https://…", "source": "jsonld", "alt": "front" } ],
      "downloaded": [
        {
          "originalUrl": "https://cdn…/front.png",
          "filePath": "images/001-main.png",  // path UNDER fileBaseUrl (see §7)
          "width": 1600, "height": 1600,
          "groupId": "g1",                     // images with same groupId = same view
          "reason": "Distinct view (different pose/detail/crop/silhouette)."
        }
      ],
      "skipped": [ { "originalUrl": "https://…", "reason": "Near-duplicate of group representative.", "similarTo": "https://…" } ],
      "strategy": {
        "mode": "selective",                   // or "download_all_fallback" (kept everything because dedup was unsure)
        "reason": "Grouped 28 usable images into 24 distinct view(s).",
        "groups": [ { "groupId": "g1", "representativeImage": "https://…", "imageCount": 2, "reason": "…" } ]
      }
    },

    "files": { "outputDir": "…", "dataJsonPath": "…", "seoJsonPath": "…", "rawHtmlPath": "…", "rawMetadataPath": "…" },
    "warnings": [],
    "errors": []   // e.g. ["NO_PRODUCT_DATA_FOUND: …"] if the page had little product data
  }
}
```

**How to use a product result:**
- Product name → `result.product.title.value`; if `null`, use `result.seo.title.value`.
- Product text → `result.product.description.value`; if `null`, use `result.seo.description.value`.
- Images to show/download → for each item in `result.images.downloaded`, the full
  URL is `BASE + fileBaseUrl + "/" + filePath`
  → e.g. `https://seoscrapebackend-production.up.railway.app/files/runs/<id>/images/001-main.png`
- Trust fields with higher `confidence`. `source` starting with `jsonld:` is best;
  `dom_*` means it was guessed — check that field's `warnings`.
- `result.errors` non-empty means extraction was weak even though the call returned `200`.

### B) `result.kind === "collection"` — a category / listing page

The page was a list of products, so each product was scraped too.

```jsonc
{
  "success": true,
  "result": {
    "kind": "collection",
    "finalUrl": "https://shop.com/collections/dresses",
    "discoveredProductUrls": ["https://shop.com/products/a", "https://shop.com/products/b"],
    "products": [
      { "url": "https://shop.com/products/a", "success": true,  "result": { /* a "product" result, see §4A */ }, "fileBaseUrl": "/files/runs/…" },
      { "url": "https://shop.com/products/b", "success": false, "error": { "code": "PAGE_LOAD_FAILED", "message": "…" } }
    ],
    "summary": { "discovered": 2, "succeeded": 1, "failed": 1 },
    "warnings": [],
    "errors": []
  }
}
```
Loop over `result.products`. Each item has its **own** `success` flag and its own
`fileBaseUrl` (when it succeeded).

---

## 5. Errors you may get from `/api/check-product`

Returned as `{ "success": false, "error": { "code", "message" } }`.

| `code` | Meaning | Should you retry? |
|---|---|---|
| `INVALID_URL` | The URL or body was malformed | No — fix the input |
| `DOMAIN_NOT_ALLOWED` | Host not allowed, or a private/localhost address | No |
| `PAGE_LOAD_FAILED` | The page didn't load (timeout / blocked / 4xx-5xx) | Yes, after a short wait |
| `NO_PRODUCT_DATA_FOUND` | Nothing product-like found | No (wrong page?) |
| `IMAGE_DOWNLOAD_FAILED` | Image fetching failed | Maybe — inspect `result` if present |
| `OUTPUT_WRITE_FAILED` | Server couldn't save the run | Yes, later |
| `UNAUTHORIZED` | Missing/wrong API key | No — add the key |
| `UNKNOWN_ERROR` | Unexpected | Retry once |

A single product check can take **a few seconds up to ~1 minute** (real browser +
image downloads). Use a client timeout of **120 seconds**.

---

## 6. `GET /api/check-progress/{runId}` — optional live progress

If you want a progress feed while a scrape runs:
1. Make up a unique `runId` (any string / UUID).
2. Open this URL as a **Server-Sent Events** stream (no key needed).
3. Call `POST /api/check-product` with that same `runId` in the body.

Each event's `data` is JSON like:
```json
{ "phase": "downloading-images", "message": "Downloading 8 image candidates.", "current": 3, "total": 12 }
```
This is just status text. **The real answer is the JSON returned by the POST** — use
that as the source of truth. You can ignore this endpoint entirely if you don't
need progress.

---

## 7. `GET /files/runs/{runId}/...` — saved files

Static files from a run. No key needed. Build URLs by joining the base, the
`fileBaseUrl` from the response, and a `filePath`:

```
https://seoscrapebackend-production.up.railway.app/files/runs/<id>/images/001-main.png
https://seoscrapebackend-production.up.railway.app/files/runs/<id>/data.json      (the full result)
https://seoscrapebackend-production.up.railway.app/files/runs/<id>/raw/page.html  (raw rendered HTML)
```

---

## 8. Best-seller rank tracking

Tracks the order of products on a sorted "best-selling" listing and tells you how
ranks moved since the last time you checked the same listing.

### `POST /api/listings/track`

**Send:**
```json
{ "url": "https://shop.com/collections/all?sort_by=best-selling", "sourceStrategy": "auto", "maxProducts": 100, "maxPages": 10, "runId": "abc", "enrich": false }
```
- `url` (required).
- `sourceStrategy` (optional): `"auto"` (default), `"html"`, `"shopify_json"`, or `"both"`.
- `maxProducts` (optional): 1–250, default 100.
- `maxPages` (optional): how many listing pages to walk (pagination). Default
  `MAX_COLLECTION_PAGES` (10), capped at the server ceiling.
- `runId` (optional): receive live progress on `/api/check-progress/{runId}` (§6).
- `enrich` (optional, default false): if true, after the ranking is returned the
  server runs a **background** full SEO + image scrape of every product
  (concurrency-limited). It never blocks this response — watch its progress on
  the same `runId` (phases: `enrich-start`, `enrich-product-done`,
  `enrich-product-failed`, `enrich-complete`). Each finished product's
  `fileBaseUrl` arrives in the progress event's `url` field.

The `track` response also includes `"enriching": true|false` so you know whether
background enrichment was started.

**Get back:**
```jsonc
{
  "success": true,
  "result": {
    "kind": "listing_rank_snapshot",
    "trackedListingId": "uuid",     // SAVE THIS to read history later
    "storeDomain": "shop.com",
    "sourceUsed": "shopify_json",
    "checkedAt": "2026-05-29T…Z",
    "items": [                      // current ranking, in order
      { "rank": 1, "productKey": "…", "url": "…", "title": "…", "imageUrl": "…", "source": "shopify_json" }
    ],
    "changes": [                    // vs the previous snapshot
      { "productKey": "…", "title": "…", "previousRank": 3, "currentRank": 1, "delta": 2, "direction": "up" }
    ],
    "summary": { "tracked": 100, "new": 4, "movedUp": 21, "movedDown": 18, "unchanged": 55, "missing": 2 },
    "warnings": []
  }
}
```
- `direction` is one of `up`, `down`, `same`, `new`, `missing`. `delta` positive = moved up.
- The **first** time you track a listing, everything is `"new"`.

### `GET /api/listings/{trackedListingId}/latest`
Most recent snapshot + its ranked `items`. Needs the key.

### `GET /api/listings/{trackedListingId}/history`
Up to 50 recent snapshots (metadata). Needs the key.

If a listing/snapshot id is unknown → `404 { error.code: "NOT_FOUND" }`.

---

## 9. Minimal worked example (pseudocode)

```python
BASE = "https://seoscrapebackend-production.up.railway.app"
H = {"Authorization": "Bearer <API_KEY>", "Content-Type": "application/json"}

r = POST(f"{BASE}/api/check-product", headers=H, json={"url": product_url}, timeout=120).json()
if not r["success"]:
    handle_error(r["error"]["code"]); return

res = r["result"]
if res["kind"] == "collection":
    for p in res["products"]:
        if p["success"]:
            use(p["result"], image_base=BASE + p["fileBaseUrl"])
else:
    title = res["product"]["title"]["value"] or res["seo"]["title"]["value"]
    desc  = res["product"]["description"]["value"] or res["seo"]["description"]["value"]
    images = [f'{BASE}{r["fileBaseUrl"]}/{img["filePath"]}' for img in res["images"]["downloaded"]]
    use(title, desc, images)
```

---

## 10. Remember

- Send the **API key** on every protected call. Check **`success`** first.
- Branch product vs collection on **`result.kind`**.
- Build image URLs as **`BASE + fileBaseUrl + "/" + filePath`**.
- Allow up to **120s** per scrape; retry only the transient error codes.
- Image de-duplication is deterministic (hashing + visual comparison) — no AI is
  used server-side, so results are consistent for the same input.
