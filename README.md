# SEOScrape AI Integration Guide

SEOScrape is a TypeScript/Fastify/Playwright service for checking webshop product SEO, product content, product images, and rendered collection pages. This README is written for humans **and AI builders such as Lovable, Cursor, Windsurf, Replit Agent, v0, Bolt, and other coding agents** that need to install or connect SEOScrape inside an existing project.

## Quick Summary For AI Agents

If you are integrating this into an existing repo, do **not** rewrite the scraper. Treat SEOScrape as a backend service with:

- **REST check endpoint:** `POST /api/check-product`
- **Live progress endpoint:** `GET /api/check-progress/:runId`
- **Static output files:** `/files/runs/<run-id>/...`
- **Primary result file:** `data.json`
- **SEO-focused result file:** `seo.json`

The safest integration path is:

1. Run SEOScrape backend on port `3001`.
2. Call `POST /api/check-product` from your app. Use `apps/backend` for full Node/Playwright mode or `apps/worker` for Cloudflare fetch-first mode.
3. Optionally open `EventSource('/api/check-progress/:runId')` for live status.
4. Render the returned `ProductCheckResult` or `CollectionCheckResult`.
5. Use `fileBaseUrl + image.filePath` for image previews in Node mode; Worker mode has no local files and returns image URLs in `images.discovered`.
6. Use `result.files.seoJsonPath` or `result.seoSnapshot` for clean SEO data.

## What This Project Does

SEOScrape accepts either a product URL or a collection/list URL.

### Product URL Behavior

For a URL like:

```text
https://example.com/products/linen-shirt
```

It will:

- Render the page with Playwright.
- Wait for the page to settle.
- Extract SEO title, meta description, canonical URL, OpenGraph, Twitter tags.
- Extract product title, product description, and product JSON-LD/schema.
- Discover product image candidates.
- Download and deduplicate selected product images.
- Save full output to `data.json`.
- Save clean SEO-focused output to `seo.json`.
- Return a `kind: "product"` response.

### Collection URL Behavior

For a URL like:

```text
https://example.com/collections/all?sort_by=best-selling
```

It will:

- Render the collection page.
- Scroll to reveal visible products.
- Extract visible same-domain `/products/...` links.
- Scrape each discovered product sequentially.
- Continue if one product fails.
- Return a `kind: "collection"` response with per-product success/failure entries.

Collection behavior is intentionally conservative:

- It scrapes visible rendered products only.
- It does not automatically follow pagination.
- It does not crawl the whole site.
- Product pages are processed sequentially to reduce site load and keep outputs predictable.

## Tech Stack

- **Node.js:** `>=20`
- **Node backend:** Fastify, TypeScript, Playwright, Cheerio, Sharp, Zod
- **Worker backend:** Cloudflare Workers, TypeScript, fetch-first HTML extraction
- **Frontend:** Vite, React, TypeScript
- **Testing:** Vitest
- **Package manager:** npm workspaces

## Repository Structure

```text
SEOSCRAPE/
  package.json
  README.md
  config/
    sites.config.ts
  apps/
    backend/
      package.json
      src/
        index.ts
        server.ts
        routes/checkProduct.ts
        services/pageLoader.ts
        services/collectionDiscovery.ts
        services/metadataExtractor.ts
        services/productExtractor.ts
        services/imageDiscovery.ts
        services/imageDownloader.ts
        services/outputWriter.ts
        services/progressHub.ts
        types/productCheck.ts
        utils/
      tests/
    frontend/
      package.json
      vite.config.ts
      src/
        api.ts
        App.tsx
        components/
    worker/
      package.json
      wrangler.toml
      src/
        index.ts
```

## Installation From Scratch

Run these commands from the repository root:

```bash
npm install
npx playwright install chromium
npm test
npm run typecheck
npm run build
```

Start local development:

```bash
npm run dev
```

This starts:

- Backend: `http://127.0.0.1:3001`
- Frontend: `http://127.0.0.1:5173`

Run only backend:

```bash
npm run dev:backend
```

Run only frontend:

```bash
npm run dev:frontend
```


## Cloudflare Workers Free Fetch-First Mode

This repo also includes a Workers-compatible backend at:

```text
apps/worker/
```

Use this when the app is hosted on Cloudflare Workers, Lovable, or another serverless edge runtime where Playwright/Chromium cannot run.

### Worker Install

```bash
npm install
npm run typecheck --workspace apps/worker
```

### Worker Local Dev

```bash
npm run dev:worker
```

This starts Wrangler for:

```text
apps/worker/src/index.ts
```

### Worker Deploy

```bash
npm run deploy:worker
```

### Worker API

The Worker exposes the same core check route:

```text
POST /api/check-product
GET /api/check-progress/:runId
GET /health
```

Request:

```json
{
  "url": "https://example.com/products/linen-shirt"
}
```

Response still uses:

```ts
result.kind === "product" | "collection"
```

### Worker Shopify and Sitemap Fallbacks

Worker mode is fetch-first, but it now tries extra static ecommerce sources before giving up.

For Shopify product URLs like:

```text
https://store.com/products/product-handle
```

the Worker may also try:

```text
/products/product-handle.js
/products/product-handle.json
```

These endpoints can improve:

- product title
- product description
- discovered image URLs
- structured product data

For Shopify collection URLs like:

```text
https://store.com/collections/collection-handle
```

the Worker may also try:

```text
/collections/collection-handle/products.json?limit=<MAX_COLLECTION_PRODUCTS>
```

For generic stores, collection discovery can also fall back to same-origin sitemaps:

```text
/sitemap_products_1.xml
/sitemap.xml
```

If `/sitemap.xml` points to same-origin product sitemaps, the Worker follows a small capped number of those sitemap URLs and extracts `/products/...` links.

Important rules:

- These fallbacks are **Worker-only**.
- They are same-origin only.
- They are non-fatal; if a JSON or sitemap endpoint is missing, the check continues.
- They are capped by `MAX_COLLECTION_PRODUCTS`.
- They do not require Chromium, Playwright, Sharp, cookies, API keys, or filesystem writes.
- They improve static/Shopify coverage, but they still do not execute JavaScript.

### Worker Limitations

The Worker mode is free and Cloudflare-compatible, but intentionally degraded:

- No Playwright.
- No Chromium.
- No Sharp image deduplication.
- No local output folders.
- No `/files/...` image serving.
- No detailed Playwright-style progress stream. The Worker includes `/api/check-progress/:runId` only as a compatibility endpoint that emits one `worker-fetch-mode` event.
- No `data.json` or `seo.json` written to disk.
- Image results are URL-only in `images.discovered`.
- `images.downloaded` is empty.
- `files.*` paths are `null`.
- Pages that require JavaScript rendering may return incomplete data.

Worker responses include warnings beginning with:

```text
WORKER_FETCH_MODE
```

### Worker Configuration

Configure `apps/worker/wrangler.toml`:

```toml
[vars]
ALLOW_ALL_DOMAINS = "true"
ALLOWED_DOMAINS = ""
MAX_COLLECTION_PRODUCTS = "20"
```

For production, lock domains down:

```toml
[vars]
ALLOW_ALL_DOMAINS = "false"
ALLOWED_DOMAINS = "example.com,www.example.com"
MAX_COLLECTION_PRODUCTS = "10"
```

### Worker Storage Optional Later

If persistence is needed, add Cloudflare R2/KV later:

- R2 for `runs/<runId>/data.json` and `runs/<runId>/seo.json`.
- KV for compact SEO snapshots.
- D1 for searchable scan metadata.

The initial free Worker mode returns JSON directly and does not require paid storage.

## Installing Into An Existing Repo

There are two recommended ways to integrate SEOScrape.

## Option A: Run SEOScrape As A Separate Service

This is the safest and recommended approach.

### Steps

1. Keep this repo as its own service.
2. Start the backend with:

```bash
npm run dev:backend
```

3. From your existing frontend/backend, call:

```text
POST http://127.0.0.1:3001/api/check-product
```

4. Proxy `/api`, `/files`, and optionally `/health` in your existing frontend dev server.

### Example Vite Proxy

```ts
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: true },
      "/files": { target: "http://127.0.0.1:3001", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:3001", changeOrigin: true },
    },
  },
});
```

### Example Next.js Rewrite

```ts
// next.config.ts
const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/check-product", destination: "http://127.0.0.1:3001/api/check-product" },
      { source: "/api/check-progress/:runId", destination: "http://127.0.0.1:3001/api/check-progress/:runId" },
      { source: "/files/:path*", destination: "http://127.0.0.1:3001/files/:path*" },
    ];
  },
};

export default nextConfig;
```

## Option B: Copy Backend Into Existing Monorepo

Use this only if you need SEOScrape inside one repo/deployment.

### Copy These Folders

```text
apps/backend/
config/
tsconfig.base.json
```

Also copy or merge root scripts/dependencies from `package.json`.

### Required Backend Dependencies

```bash
npm install @fastify/cors @fastify/static cheerio fastify playwright sharp zod
npm install -D @types/node tsx typescript vitest
npx playwright install chromium
```

### Required Scripts

Add equivalent scripts to your existing repo:

```json
{
  "scripts": {
    "dev:seoscrape": "tsx apps/backend/src/index.ts",
    "build:seoscrape": "tsc -p apps/backend/tsconfig.json",
    "typecheck:seoscrape": "tsc -p apps/backend/tsconfig.json --noEmit",
    "test:seoscrape": "vitest run apps/backend/tests"
  }
}
```

Adjust paths if you place the backend somewhere else.

## Environment And Ports

Backend defaults:

```text
HOST=127.0.0.1
PORT=3001
```

Override when starting:

```bash
PORT=4001 HOST=0.0.0.0 npm run dev:backend
```

Frontend default:

```text
http://127.0.0.1:5173
```


## Can This Run Without Chromium?

For the current reliable scraper: **no, Chromium/Playwright is required**.

Important nuance:

- It does **not** need a visible browser window.
- It runs headless through Playwright.
- It does **not** require the user to manually open Chrome.
- It does require Playwright's Chromium browser binary to be installed with `npx playwright install chromium`.

Why Chromium is currently needed:

- Many Shopify/webshop pages render product cards with JavaScript.
- Collection pages often lazy-load products/images after scroll.
- Redirect-heavy pages need real browser navigation handling.
- Some SEO/product metadata appears only after scripts run.
- Image candidates often come from rendered DOM, `srcset`, lazy attributes, or client-side hydration.

A fetch-only scraper is possible for simple static pages, but it would be less accurate and would fail on many modern stores. If an AI agent adds a fetch-only mode later, it should be an explicit fallback mode, not a replacement for `pageLoader.ts`.

Recommended deployment rule:

```bash
npx playwright install chromium
```

Keep using Playwright for production-quality checks.

## Configuration File

Main config:

```text
config/sites.config.ts
```

### Domain Policy

Testing mode:

```ts
allowAllDomains: true
```

Production mode:

```ts
allowAllDomains: false,
allowedDomains: ["example.com", "www.example.com"]
```

Do not disable private-host protection. Localhost, private networks, and loopback hosts are blocked to reduce SSRF risk.

### Browser Config

```ts
browser: {
  timeoutMs: 30000,
  waitUntil: "domcontentloaded",
  scrollTimeoutMs: 8000,
  userAgent: "Mozilla/5.0 ... Chrome/124.0.0.0 Safari/537.36",
  extraHTTPHeaders: {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1"
  },
  viewport: { width: 1366, height: 1000 }
}
```

### Collection Config

```ts
collections: {
  maxProducts: 100
}
```

If an integration must avoid long collection runs, reduce `maxProducts`.

## API To Call

## Hosted Node API Mode

For a Railway-style hosted backend that can run Playwright, download images, write files, and serve `/files/...`, use:

```bash
npm run dev:host
```

This starts the Node backend on `HOST=0.0.0.0` and reads Railway's `PORT` automatically.

Recommended hosted environment variables:

```text
HOST=0.0.0.0
PORT=<provided by host>
API_KEY=<strong random secret>
REQUIRE_API_KEY=true
DATABASE_URL=<Postgres connection string>
OUTPUT_DIR=/data/output
```

When `API_KEY` is set, protected API routes accept either:

```text
Authorization: Bearer <API_KEY>
x-api-key: <API_KEY>
```

Run the Postgres migration before using listing tracking:

```bash
npm run db:migrate
```

## `POST /api/check-product`

Runs one product check or one collection check.

### Request Body

```ts
interface CheckRequest {
  url: string;
  runId?: string;
}
```

Example:

```bash
curl -X POST http://127.0.0.1:3001/api/check-product \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"url":"https://example.com/products/linen-shirt"}'
```

With progress:

```json
{
  "url": "https://example.com/collections/all?sort_by=best-selling",
  "runId": "client-generated-id"
}
```

## `GET /api/check-progress/:runId`

Streams Server-Sent Events for a running check.

Open this **before or at the same time as** submitting the check request.

```ts
const runId = crypto.randomUUID();
const source = new EventSource(`/api/check-progress/${runId}`);

source.onmessage = (event) => {
  const progress = JSON.parse(event.data);
  console.log(progress.phase, progress.message);
};

await fetch("/api/check-product", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url, runId }),
});

source.close();
```

## `POST /api/listings/track`

Tracks a Shopify/listing rank snapshot over time, useful for best-seller movement such as rank `80` becoming rank `2`.

### Request Body

```ts
interface TrackListingRequest {
  url: string;
  sourceStrategy?: "auto" | "html" | "shopify_json" | "both";
  maxProducts?: number;
}
```

Recommended Shopify best-seller URL:

```text
https://store.com/collections/all?sort_by=best-selling
```

Example:

```bash
curl -X POST http://127.0.0.1:3001/api/listings/track \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "url": "https://example.com/collections/all?sort_by=best-selling",
    "sourceStrategy": "auto",
    "maxProducts": 100
  }'
```

Source strategies:

- `auto`: prefer rendered HTML order, enrich/fallback with Shopify JSON.
- `html`: use Playwright-rendered listing links only.
- `shopify_json`: use `/collections/<handle>/products.json`.
- `both`: merge rendered HTML rank order with Shopify JSON enrichment.

The endpoint stores a snapshot in Postgres and compares it with the previous snapshot for the same listing key. Changes include `previousRank`, `currentRank`, `delta`, and `direction`.

Related listing endpoints:

```text
GET /api/listings/:listingId/history
GET /api/listings/:listingId/latest
```

### Progress Event Shape

```ts
interface ProgressEvent {
  runId: string;
  phase: string;
  message: string;
  url?: string;
  current?: number;
  total?: number;
  timestamp: string;
}
```

Common phases:

```text
queued
loading
loaded
collection-discovered
product-start
loading-product
loaded-product
saving
extracting-seo
discovering-images
downloading-images
writing-files
product-complete
product-failed
failed
complete
```

## What To Expect Back

The response is a union.

```ts
type CheckResponse =
  | { success: true; result: ProductCheckResult; fileBaseUrl?: string }
  | { success: true; result: CollectionCheckResult; fileBaseUrl?: string }
  | { success: false; error: ApiError };
```

Always branch on:

```ts
if (!response.success) {
  // show response.error.code and response.error.message
} else if (response.result.kind === "product") {
  // render product result
} else if (response.result.kind === "collection") {
  // render collection result
}
```

## Product Result Shape

Important fields:

```ts
interface ProductCheckResult {
  kind: "product";
  inputUrl: string;
  finalUrl: string;
  domain: string;
  checkedAt: string;
  seo: {
    title: ExtractedField<string | null>;
    description: ExtractedField<string | null>;
    canonicalUrl: ExtractedField<string | null>;
    openGraph: Record<string, string>;
    twitter: Record<string, string>;
  };
  seoSnapshot: SeoSnapshot;
  product: {
    title: ExtractedField<string | null>;
    description: ExtractedField<string | null>;
    structuredData: unknown[];
  };
  images: {
    discovered: DiscoveredImage[];
    downloaded: DownloadedImage[];
    skipped: SkippedImage[];
    strategy: ImageSelectionStrategyReport;
  };
  files: {
    outputDir: string;
    dataJsonPath: string;
    seoJsonPath: string;
    rawHtmlPath: string;
    rawMetadataPath: string;
  };
  warnings: string[];
  errors: string[];
}
```

### `ExtractedField<T>`

Every extracted SEO/content field includes provenance:

```ts
interface ExtractedField<T> {
  value: T;
  source: string;
  confidence: number;
  warnings: string[];
}
```

Display `value`, but keep `source`, `confidence`, and `warnings` available for debugging and trust scoring.

## Collection Result Shape

```ts
interface CollectionCheckResult {
  kind: "collection";
  inputUrl: string;
  finalUrl: string;
  domain: string;
  checkedAt: string;
  discoveredProductUrls: string[];
  products: CollectionProductResult[];
  summary: {
    discovered: number;
    succeeded: number;
    failed: number;
  };
  warnings: string[];
  errors: string[];
}
```

Each product entry is either:

```ts
type CollectionProductResult =
  | {
      url: string;
      success: true;
      result: ProductCheckResult;
      fileBaseUrl: string;
    }
  | {
      url: string;
      success: false;
      error: { code: string; message: string };
    };
```

Do not assume every product in a collection succeeds.

## Error Response Shape

```ts
interface ApiError {
  code: string;
  message: string;
}
```

Known codes:

```text
INVALID_URL
DOMAIN_NOT_ALLOWED
PAGE_LOAD_FAILED
NO_PRODUCT_DATA_FOUND
IMAGE_DOWNLOAD_FAILED
OUTPUT_WRITE_FAILED
UNKNOWN_ERROR
```

Recommended frontend behavior:

- Show `error.code` as a short label.
- Show `error.message` as the readable explanation.
- Do not retry automatically unless the user clicks retry.
- For collection product failures, show them inline and continue rendering successful products.

## Output Files

Each product creates a globally unique run folder:

```text
output/runs/<run-id>/
  data.json
  seo.json
  raw/
    page.html
    metadata.json
  images/
    001-main.jpg
    002-side-view.jpg
```

Run ids look like:

```text
20260529t141530z-example.com-a1b2c3d4
```

This means a check run five weeks later creates a completely new folder instead of reusing a domain counter.

The backend serves this output at:

```text
/files/runs/<run-id>/...
```

### Full Result: `data.json`

Use this for debugging or complete exports.

Contains:

- SEO fields
- product fields
- full structured data
- discovered image candidates
- downloaded image records
- skipped image records
- file paths
- warnings/errors

### SEO-Focused Result: `seo.json`

Use this for AI/content/SEO workflows.

Contains:

- input/final URL
- checked timestamp
- SEO title
- SEO description
- canonical URL
- product title
- product description
- OpenGraph and Twitter maps
- structured product data
- downloaded image references only
- warnings/errors

Prefer `seo.json` when connecting to content editors, SEO dashboards, CMS workflows, or AI copy review tools.

## Image Preview URLs

For a product response:

```ts
const imageUrl = `${fileBaseUrl}/${image.filePath}`;
```

For a collection response:

```ts
for (const item of result.products) {
  if (item.success) {
    const imageUrl = `${item.fileBaseUrl}/${item.result.images.downloaded[0].filePath}`;
  }
}
```

Never use local filesystem paths in browser `<img>` tags. Use `/files/...` URLs.

## Existing Frontend Integration Pattern

### Minimal React Hook Example

```ts
import { useState } from "react";

type State =
  | { status: "idle" }
  | { status: "loading"; progress: ProgressEvent[] }
  | { status: "error"; error: ApiError }
  | { status: "success"; result: CheckResult; fileBaseUrl?: string };

export function useSeoScrape() {
  const [state, setState] = useState<State>({ status: "idle" });

  async function check(url: string) {
    const runId = crypto.randomUUID();
    const source = new EventSource(`/api/check-progress/${runId}`);

    setState({ status: "loading", progress: [] });

    source.onmessage = (event) => {
      const progress = JSON.parse(event.data) as ProgressEvent;
      setState((current) =>
        current.status === "loading"
          ? { status: "loading", progress: [...current.progress, progress] }
          : current
      );
    };

    try {
      const response = await fetch("/api/check-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, runId }),
      }).then((res) => res.json());

      if (response.success) {
        setState({ status: "success", result: response.result, fileBaseUrl: response.fileBaseUrl });
      } else {
        setState({ status: "error", error: response.error });
      }
    } finally {
      source.close();
    }
  }

  return { state, check };
}
```

### Rendering Logic

```tsx
if (state.status === "loading") {
  return <ProgressView events={state.progress} />;
}

if (state.status === "error") {
  return <ErrorView error={state.error} />;
}

if (state.status === "success" && state.result.kind === "product") {
  return <ProductSeoView result={state.result} fileBaseUrl={state.fileBaseUrl} />;
}

if (state.status === "success" && state.result.kind === "collection") {
  return <CollectionSeoView result={state.result} />;
}
```

## AI Agent Instructions: What To Change

When an AI agent integrates SEOScrape, it may safely change:

- Frontend styling and layout.
- Domain allowlist in `config/sites.config.ts`.
- `collections.maxProducts`.
- Output base directory if deployment requires it.
- UI display components.
- API base URL/proxy config.
- Deployment scripts.

## AI Agent Instructions: What Not To Change

Do **not** change these unless explicitly requested:

- Do not remove SSRF/private-host protection.
- Do not replace the Playwright render pipeline with plain `fetch`; many stores require JS rendering.
- Do not remove `kind: "product"` / `kind: "collection"`; frontend code depends on this union.
- Do not remove `seoSnapshot` or `seo.json`; these are the clean SEO outputs.
- Do not assume collection products all succeed.
- Do not make collection scraping parallel by default; it may overload sites and produce rate limits.
- Do not hardcode API keys or cookies in source code.
- Do not use filesystem image paths in browser UI; use `/files/...` URLs.
- Do not delete `raw/page.html` and `raw/metadata.json`; they are needed for debugging extraction issues.
- Do not append obvious bot identifiers to the user agent.

## AI Agent Instructions: How To Respond To Users

When building a UI around this API, tell users:

- A product URL returns one product result.
- A collection URL returns multiple product results.
- Collection checks can take longer because each visible product is processed.
- Progress updates show the current product and phase.
- `seo.json` is the clean file for SEO/content review.
- `data.json` is the full technical/debug export.
- Some products may fail inside a collection, while others still succeed.

Recommended user-facing states:

```text
Idle: enter product or collection URL
Loading: show progress stream and current URL
Product success: show SEO fields, product fields, images, output files
Collection success: show discovered/succeeded/failed counts, then product cards
Error: show error code and message
```

## AI Agent Instructions: Handling Collection Results

For `kind: "collection"`:

1. Render `summary.discovered`, `summary.succeeded`, and `summary.failed`.
2. Render `discoveredProductUrls` as a collapsible/debug list.
3. Iterate `products`.
4. If `product.success === true`, render `product.result` exactly like a product result.
5. If `product.success === false`, render `product.error.code` and `product.error.message`.
6. Do not treat partial product failures as full collection failure.

## AI Agent Instructions: Handling SEO Data

Prefer these fields for SEO UI:

```ts
result.seoSnapshot.title.value
result.seoSnapshot.description.value
result.seoSnapshot.canonicalUrl.value
result.seoSnapshot.productTitle.value
result.seoSnapshot.productDescription.value
result.seoSnapshot.openGraph
result.seoSnapshot.twitter
result.seoSnapshot.downloadedImages
```

If `seoSnapshot` is not available in older stored output, fall back to:

```ts
result.seo.title
result.seo.description
result.seo.canonicalUrl
result.product.title
result.product.description
result.images.downloaded
```

## AI Agent Instructions: Deployment Notes

For production deployment:

- Use Node `>=20`.
- Install Playwright Chromium during build or release.
- Ensure `output/` is writable by the backend process.
- Expose `/files/` if the frontend needs image previews.
- Set `allowAllDomains: false` and fill `allowedDomains`.
- Put the backend behind authentication if exposed publicly.
- Consider job queues for very large collection runs.
- Do not run untrusted arbitrary URLs in public production mode.

## Programmatic Backend Calls

### Full Check

```ts
import { runCheck } from "./apps/backend/src/routes/checkProduct.js";

const { result, fileBaseUrl } = await runCheck("https://example.com/products/linen-shirt");
```

### With Progress Reporter

```ts
const { result } = await runCheck("https://example.com/products/linen-shirt", (event) => {
  console.log(event.phase, event.message, event.url);
});
```

### Page Rendering Only

```ts
import { loadRenderedPage } from "./apps/backend/src/services/pageLoader.js";

const page = await loadRenderedPage("https://example.com/products/linen-shirt");
```

### Metadata Extraction

```ts
import { extractMetadata } from "./apps/backend/src/services/metadataExtractor.js";

const meta = extractMetadata(page.html, page.finalUrl);
```

### Product Extraction

```ts
import { extractProduct } from "./apps/backend/src/services/productExtractor.js";

const product = extractProduct(meta);
```

### Collection Discovery

```ts
import { discoverCollectionProducts } from "./apps/backend/src/services/collectionDiscovery.js";

const collection = discoverCollectionProducts(meta, page.finalUrl, 100);
```

### Image Discovery And Selection

```ts
import { discoverImages } from "./apps/backend/src/services/imageDiscovery.js";
import { downloadAndSelect } from "./apps/backend/src/services/imageDownloader.js";

const discovered = discoverImages(meta, page.finalUrl);
const images = await downloadAndSelect(discovered, imagesDir, tempDir);
```

## Testing Commands

Run all backend tests:

```bash
npm test
```

Run typechecks:

```bash
npm run typecheck
```

Run production build:

```bash
npm run build
```

Expected successful test output includes all backend test files passing.

## Troubleshooting

### `PAGE_LOAD_FAILED`

Possible causes:

- Target site blocks headless browsers.
- Page times out.
- HTTP status is `>=400`.
- Browser dependencies are missing.

Try:

```bash
npx playwright install chromium
```

Also verify `browser.userAgent`, `extraHTTPHeaders`, and `timeoutMs` in `config/sites.config.ts`.

### No images appear in frontend

Check:

- Backend is serving `/files/`.
- Frontend proxy includes `/files`.
- Use `fileBaseUrl + '/' + image.filePath`.
- Do not use absolute local filesystem paths in `<img src>`.

### Collection takes too long

Reduce:

```ts
collections: {
  maxProducts: 20
}
```

Or submit a more specific collection URL.

### `DOMAIN_NOT_ALLOWED`

If in production mode, add the domain:

```ts
allowedDomains: ["example.com", "www.example.com"]
```

### Playwright browser missing

Run:

```bash
npx playwright install chromium
```

## Security Rules

- Only scrape domains you own or are allowed to test.
- Use `allowAllDomains: false` in production.
- Keep private-host blocking enabled.
- Do not expose this API publicly without authentication.
- Do not store secrets, cookies, or API keys in source code.
- Keep generated output folders out of public repos if they contain customer/product data.

## Final Integration Checklist

For AI agents and human developers:

- [ ] Node `>=20` installed.
- [ ] `npm install` completed.
- [ ] `npx playwright install chromium` completed.
- [ ] Backend starts successfully.
- [ ] `/health` returns `{ "ok": true }`.
- [ ] Frontend or host app proxies `/api` and `/files`.
- [ ] Product URL returns `kind: "product"`.
- [ ] Collection URL returns `kind: "collection"`.
- [ ] Progress stream displays events when `runId` is supplied.
- [ ] Product images render using `/files/...` URLs.
- [ ] `seo.json` is written and shown in UI.
- [ ] Production domains are locked down in `sites.config.ts`.
