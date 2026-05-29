// Mirror of the backend response shapes (kept minimal for the test UI).

export interface ExtractedField<T> {
  value: T;
  source: string;
  confidence: number;
  warnings: string[];
}

export interface DiscoveredImage {
  url: string;
  normalizedUrl: string;
  source: string;
  alt?: string;
}

export interface DownloadedImage {
  originalUrl: string;
  filePath: string;
  filename: string;
  bytes: number;
  width?: number;
  height?: number;
  groupId?: string;
  reason: string;
}

export interface SkippedImage {
  originalUrl: string;
  reason: string;
  similarTo?: string;
}

export interface SeoSnapshot {
  inputUrl: string;
  finalUrl: string;
  domain: string;
  checkedAt: string;
  title: ExtractedField<string | null>;
  description: ExtractedField<string | null>;
  canonicalUrl: ExtractedField<string | null>;
  productTitle: ExtractedField<string | null>;
  productDescription: ExtractedField<string | null>;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  structuredData: unknown[];
  downloadedImages: Array<{
    originalUrl: string;
    filePath: string;
    width?: number;
    height?: number;
    reason: string;
  }>;
  warnings: string[];
  errors: string[];
}

export interface ProgressEvent {
  runId: string;
  phase: string;
  message: string;
  url?: string;
  current?: number;
  total?: number;
  timestamp: string;
}

export interface ProductCheckResult {
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
    strategy: {
      mode: "selective" | "download_all_fallback" | "worker_url_only";
      reason: string;
      groups: Array<{
        groupId: string;
        representativeImage: string;
        imageCount: number;
        reason: string;
      }>;
    };
  };
  files: {
    outputDir: string | null;
    dataJsonPath: string | null;
    seoJsonPath: string | null;
    rawHtmlPath: string | null;
    rawMetadataPath: string | null;
  };
  warnings: string[];
  errors: string[];
}

export interface CollectionProductSuccess {
  url: string;
  success: true;
  result: ProductCheckResult;
  fileBaseUrl: string | null;
}

export interface CollectionProductFailure {
  url: string;
  success: false;
  error: ApiError;
}

export type CollectionProductResult =
  | CollectionProductSuccess
  | CollectionProductFailure;

export interface CollectionCheckResult {
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

export type CheckResult = ProductCheckResult | CollectionCheckResult;

export interface ApiError {
  code: string;
  message: string;
}

export type CheckResponse =
  | { success: true; result: CheckResult; fileBaseUrl?: string | null; dataUrl?: string | null }
  | { success: false; error: ApiError };

/**
 * Base URL of the backend API.
 *
 * - Empty in local dev: requests use relative paths that Vite's dev proxy
 *   forwards to the backend (see vite.config.ts).
 * - On Railway (and any deployed build) set the build-time env var
 *   `VITE_API_BASE_URL` to the backend's PUBLIC domain, e.g.
 *   `https://seoscrapebackend-production.up.railway.app`. The browser then
 *   calls the backend directly. (The private *.railway.internal address does
 *   NOT work from a browser.)
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

/** Build an absolute URL to a backend path (handles the empty-base dev case). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

// --- API key (persisted in this browser, sent as a Bearer token) ------------

const API_KEY_STORAGE = "seoscrape_api_key";

export function getApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setApiKey(value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) localStorage.setItem(API_KEY_STORAGE, trimmed);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* ignore storage failures (private mode etc.) */
  }
}

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// --- Listing rank tracker types ---------------------------------------------

export type ListingRankDirection = "up" | "down" | "same" | "new" | "missing";

export interface ListingRankItem {
  rank: number;
  productKey: string;
  url: string;
  handle?: string;
  title?: string;
  imageUrl?: string;
  productId?: string;
  source: string;
}

export interface ListingRankChange {
  productKey: string;
  url: string;
  title?: string;
  previousRank: number | null;
  currentRank: number | null;
  delta: number | null;
  direction: ListingRankDirection;
}

export interface ListingRankSnapshot {
  kind: "listing_rank_snapshot";
  snapshotId: string;
  trackedListingId: string;
  storeDomain: string;
  listingUrl: string;
  sourceUsed: string;
  checkedAt: string;
  items: ListingRankItem[];
  changes: ListingRankChange[];
  summary: {
    tracked: number;
    new: number;
    movedUp: number;
    movedDown: number;
    unchanged: number;
    missing: number;
  };
  warnings: string[];
}

export type ListingResponse =
  | { success: true; result: ListingRankSnapshot }
  | { success: false; error: ApiError };

// --- Calls ------------------------------------------------------------------

export async function checkProduct(
  url: string,
  opts?: { runId?: string; maxPages?: number; responseMode?: "full" | "url" },
): Promise<CheckResponse> {
  const res = await fetch(apiUrl("/api/check-product"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      url,
      ...(opts?.runId ? { runId: opts.runId } : {}),
      ...(opts?.maxPages ? { maxPages: opts.maxPages } : {}),
      ...(opts?.responseMode ? { responseMode: opts.responseMode } : {}),
    }),
  });
  return (await res.json()) as CheckResponse;
}

export async function trackListing(
  url: string,
  opts?: { runId?: string; enrich?: boolean; maxPages?: number; sourceStrategy?: string; maxProducts?: number },
): Promise<ListingResponse> {
  const res = await fetch(apiUrl("/api/listings/track"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      url,
      sourceStrategy: opts?.sourceStrategy ?? "auto",
      maxProducts: opts?.maxProducts ?? 100,
      ...(opts?.runId ? { runId: opts.runId } : {}),
      ...(opts?.enrich ? { enrich: true } : {}),
      ...(opts?.maxPages ? { maxPages: opts.maxPages } : {}),
    }),
  });
  return (await res.json()) as ListingResponse;
}

export function createProgressSource(runId: string): EventSource {
  return new EventSource(apiUrl(`/api/check-progress/${encodeURIComponent(runId)}`));
}
