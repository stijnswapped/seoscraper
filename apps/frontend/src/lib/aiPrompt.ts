// A ready-to-paste prompt that teaches an AI coding assistant everything it needs
// to integrate the SEOSCRAPE API. Mirrors API.md (the backend's source of truth).

export function buildIntegrationPrompt(baseUrl: string): string {
  return `You are integrating the SEOSCRAPE API into my app. It tracks Shopify best-seller rankings over time and can deep-scrape product SEO + images. Read everything below, then build the integration I describe at the end.

# Connection
- Base URL: ${baseUrl}
- Auth: send header \`x-api-key: <MY_API_KEY>\` on EVERY /api/* request, except \`GET /api/check-progress/:runId\` and \`GET /health\`. (\`Authorization: Bearer <MY_API_KEY>\` also works.)
- All POST bodies are JSON. Timestamps are ISO-8601 UTC strings.

# Response envelope (every endpoint)
- Success: HTTP 2xx, body { "success": true, ...endpoint fields }
- Failure: { "success": false, "error": { "code": ErrorCode, "message": string } }
- Retry policy: retry ONLY on 500 / 502 / network timeout, max 2x with exponential backoff. NEVER retry 400 / 401 / 404.

# Primary endpoint — best-seller rank tracking
POST /api/listings/track
Body:
{
  "url": "<collection URL — MUST include ?sort_by=best-selling>",
  "maxProducts": 150,            // optional, 1–250
  "sourceStrategy": "both",      // optional: "both" | "auto" | "html" | "shopify_json" (default "both" = correct order + reliable titles)
  "maxPages": 10,                // optional
  "runId": "<uuid>"              // optional, correlates with the live-progress stream
}
Returns result:
{
  "trackedListingId": string,    // STABLE id for this listing — persist it
  "checkedAt": string,
  "items": [ { "rank": number, "productKey": "handle:<handle>", "url", "handle", "title", "imageUrl", "productId" } ],  // ascending by rank
  "changes": [ { "productKey", "previousRank": number|null, "currentRank": number|null, "delta": number|null, "direction": "up"|"down"|"same"|"new"|"missing" } ],
  "summary": { "tracked", "new", "movedUp", "movedDown", "unchanged", "missing" }
}

# Critical rules
1. Identify products by \`productKey\` (stable, formatted "handle:<handle>"). NEVER match on title — titles change.
2. The collection URL MUST include ?sort_by=best-selling, or the order is not best-selling.
3. First run for a listing has no baseline, so every change is direction:"new". Real diffs start from run 2.
4. The backend stores ONLY the baseline + latest snapshot per listing. To build history/graphs you MUST persist each run's items + changes + checkedAt in your own database.
5. No server-side scheduler or queue: you trigger runs (e.g. a daily job per URL). Keep <= 3 concurrent track calls, ~120s timeout each.

# Secondary endpoint — full product research (heavy)
POST /api/check-product
Body: { "url": "<product OR collection URL>", "responseMode": "full" }   // "url" returns only file links
Returns SEO (title, description, canonicalUrl, openGraph, twitter), product (title, description, structuredData), and images (downloaded[].filePath, served under the returned fileBaseUrl). Hosted files are TEMPORARY (~7 days) — download anything you want to keep.

# Live progress (optional)
Open an EventSource on GET /api/check-progress/:runId using the same runId you POSTed. Events: { "phase", "message", "current"?, "total"? }. A terminal { "phase": "complete" } marks the end.

# Read back stored data
GET /api/listings/:listingId/latest  and  GET /api/listings/:listingId/history  (baseline + latest only), using the trackedListingId.

# Error codes
INVALID_URL, DOMAIN_NOT_ALLOWED, PAGE_LOAD_FAILED, NO_PRODUCT_DATA_FOUND, IMAGE_DOWNLOAD_FAILED, OUTPUT_WRITE_FAILED, UNAUTHORIZED, NOT_FOUND, UNKNOWN_ERROR.

# What to build
<Describe what you want here — e.g. "A daily job that tracks these 10 collection URLs, stores rank history in Postgres, and a dashboard showing the biggest movers since yesterday.">`;
}
