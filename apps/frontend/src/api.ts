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
  if (/^https?:\/\//i.test(path)) return path;
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
  opts?: { runId?: string; maxPages?: number; responseMode?: "full" | "url"; proxy?: string },
): Promise<CheckResponse> {
  const token = getSessionToken();
  const res = await fetch(apiUrl("/api/check-product"), {
    method: "POST",    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(token ? { "X-Session-Token": token } : {}),
    },
    body: JSON.stringify({
      url,
      ...(opts?.runId ? { runId: opts.runId } : {}),
      ...(opts?.maxPages ? { maxPages: opts.maxPages } : {}),
      ...(opts?.responseMode ? { responseMode: opts.responseMode } : {}),
      ...(opts?.proxy ? { proxy: opts.proxy } : {}),
    }),
  });
  return (await res.json()) as CheckResponse;
}

export async function trackListing(
  url: string,
  opts?: { runId?: string; enrich?: boolean; maxPages?: number; sourceStrategy?: string; maxProducts?: number; proxy?: string },
): Promise<ListingResponse> {
  const token = getSessionToken();
  const res = await fetch(apiUrl("/api/listings/track"), {
    method: "POST",    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(token ? { "X-Session-Token": token } : {}),
    },
    body: JSON.stringify({
      url,
      sourceStrategy: opts?.sourceStrategy ?? "auto",
      maxProducts: opts?.maxProducts ?? 100,
      ...(opts?.runId ? { runId: opts.runId } : {}),
      ...(opts?.enrich ? { enrich: true } : {}),
      ...(opts?.maxPages ? { maxPages: opts.maxPages } : {}),
      ...(opts?.proxy ? { proxy: opts.proxy } : {}),
    }),
  });
  return (await res.json()) as ListingResponse;
}

export function createProgressSource(runId: string): EventSource {
  return new EventSource(apiUrl(`/api/check-progress/${encodeURIComponent(runId)}`));
}

// --- Accounts / dashboard ---------------------------------------------------

export interface AccountUser {
  id: string;
  email: string;
  role: "user" | "admin";
  hasProxy?: boolean;
}

export interface BillingPlan {
  code: "free" | "starter" | "pro" | "scale" | "unlimited";
  name: string;
  priceEur: number;
  limit5h: number | null;
  limit7d: number | null;
  description: string;
}

export interface TopupPack {
  code: "boost_500" | "boost_2500" | "boost_10000";
  name: string;
  priceEur: number;
  units: number;
}

export interface BillingOverview {
  entitlement: {
    userId: string;
    planCode: BillingPlan["code"];
    billingStatus: string;
    polarCustomerId: string | null;
    polarSubscriptionId: string | null;
    polarProductId: string | null;
    currentPeriodEnd: string | null;
    manualPlanCode: BillingPlan["code"] | null;
    manualUnlimited: boolean;
    manualReason: string | null;
    manualExpiresAt: string | null;
  } | null;
  effectivePlan: BillingPlan;
  topupBalance: number;
  usage: {
    last5h: number;
    last7d: number;
    limit5h: number | null;
    limit7d: number | null;
    percent5h: number | null;
    percent7d: number | null;
  };
  plans: BillingPlan[];
  topups: TopupPack[];
}

export interface ApiKeySummary {
  id: string;
  keyPrefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface UsageDailyPoint {
  day: string;
  total: number;
  ok: number;
  failed: number;
}

// Session token (returned by login). Sent as X-Session-Token so the dashboard
// works even when the frontend and backend are on different domains, where the
// httpOnly session cookie would be a blocked third-party cookie.
const SESSION_STORAGE = "seoscrape_session_token";

export function getSessionToken(): string {
  try {
    return localStorage.getItem(SESSION_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function setSessionToken(value: string | null): void {
  try {
    if (value) localStorage.setItem(SESSION_STORAGE, value);
    else localStorage.removeItem(SESSION_STORAGE);
  } catch {
    /* ignore storage failures */
  }
}

/** Account calls authenticate with the X-Session-Token header (no cross-origin cookie). */
async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSessionToken();
  const res = await fetch(apiUrl(path), {    headers: {
      "content-type": "application/json",
      ...(token ? { "X-Session-Token": token } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.success === false) {
    const err = (body.error as ApiError) ?? { code: String(res.status), message: "Request failed." };
    throw err;
  }
  return body as T;
}

export async function login(email: string, password: string): Promise<{ success: true; user: AccountUser }> {
  const res = await authedJson<{ success: true; user: AccountUser; token: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setSessionToken(res.token);
  return res;
}

export async function logout(): Promise<{ success: true }> {
  try {
    return await authedJson("/api/auth/logout", { method: "POST" });
  } finally {
    setSessionToken(null);
  }
}

export function getMe(): Promise<{ success: true; user: AccountUser }> {
  return authedJson("/api/auth/me");
}

export function listApiKeys(): Promise<{ success: true; keys: ApiKeySummary[] }> {
  return authedJson("/api/account/api-keys");
}

export function createApiKey(label?: string): Promise<{ success: true; key: string; keyPrefix: string }> {
  return authedJson("/api/account/api-keys", { method: "POST", body: JSON.stringify({ label }) });
}

export function revokeApiKey(id: string): Promise<{ success: true }> {
  return authedJson(`/api/account/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function setProxy(proxy: string | null): Promise<{ success: true; hasProxy: boolean }> {
  return authedJson("/api/account/proxy", { method: "PUT", body: JSON.stringify({ proxy }) });
}

export interface ProxyTestResponse {
  success: boolean;
  working: boolean;
  rotates: boolean;
  ips: string[];
  uniqueIps: string[];
  errors: string[];
}

export function testProxy(proxy: string | null): Promise<ProxyTestResponse> {
  return authedJson("/api/account/test-proxy", {
    method: "POST",
    body: JSON.stringify({ proxy }),
  });
}

export function getUsage(days = 30): Promise<{ success: true; days: number; daily: UsageDailyPoint[] }> {
  return authedJson(`/api/account/usage?days=${days}`);
}

export interface UsageEvent {
  ts: string;
  endpoint: string;
  status: number | null;
  ok: boolean;
  durationMs: number | null;
  usedProxy: string | null;
}

export function getEvents(days = 30, limit = 50): Promise<{ success: true; days: number; events: UsageEvent[] }> {
  return authedJson(`/api/account/events?days=${days}&limit=${limit}`);
}

export function getBilling(): Promise<{ success: true; billing: BillingOverview }> {
  return authedJson("/api/account/billing");
}

export function createBillingCheckout(
  kind: "subscription" | "topup",
  code: string,
): Promise<{ success: true; url: string }> {
  return authedJson("/api/account/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ kind, code }),
  });
}

export function createBillingPortal(): Promise<{ success: true; url: string }> {
  return authedJson("/api/account/billing/portal", { method: "POST" });
}

// --- Early access (public, pre-launch) --------------------------------------

/** Start an anonymous $5 early-access checkout. Returns the Polar checkout URL. */
export async function createEarlyAccessCheckout(): Promise<{ success: true; url: string }> {
  const res = await fetch(apiUrl("/api/early-access/checkout"), {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; url?: string; error?: ApiError };
  if (!res.ok || !body.success || !body.url) {
    throw body.error ?? { code: String(res.status), message: "Could not start checkout." };
  }
  return { success: true, url: body.url };
}

/** Public count of early-access buyers (social proof). Best-effort; 0 on error. */
export async function getEarlyAccessCount(): Promise<number> {
  try {
    const res = await fetch(apiUrl("/api/early-access/count"));
    const body = (await res.json()) as { count?: number };
    return body.count ?? 0;
  } catch {
    return 0;
  }
}

// --- Admin ------------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  role: "user" | "admin";
  hasProxy: boolean;
  createdAt: string;
  planCode: string;
  billingStatus: string;
  manualPlanCode: string | null;
  manualUnlimited: boolean;
}

export function adminListUsers(): Promise<{ success: true; users: AdminUser[] }> {
  return authedJson("/api/admin/users");
}

export interface Invite {
  id: string;
  email: string | null;
  role: "user" | "admin";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  status: "pending" | "used" | "expired";
}

/** Create a one-time signup invite. Returns the token ONCE (build the link client-side). */
export function adminCreateInvite(
  email: string | null,
  role: "user" | "admin",
): Promise<{ success: true; token: string; expiresAt: string }> {
  return authedJson("/api/admin/invites", {
    method: "POST",
    body: JSON.stringify({ ...(email ? { email } : {}), role }),
  });
}

export function adminListInvites(): Promise<{ success: true; invites: Invite[] }> {
  return authedJson("/api/admin/invites");
}

export function adminRevokeInvite(id: string): Promise<{ success: true }> {
  return authedJson(`/api/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// --- Public invite signup ---------------------------------------------------

export function getInvite(token: string): Promise<{ success: true; valid: boolean; email?: string | null; role?: "user" | "admin" }> {
  return authedJson(`/api/auth/invite/${encodeURIComponent(token)}`);
}

export async function signup(
  token: string,
  password: string,
  email?: string,
): Promise<{ success: true; user: AccountUser }> {
  const res = await authedJson<{ success: true; user: AccountUser; token: string }>("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ token, password, ...(email ? { email } : {}) }),
  });
  setSessionToken(res.token);
  return res;
}

export function adminUserUsage(id: string, days = 30): Promise<{ success: true; days: number; daily: UsageDailyPoint[] }> {
  return authedJson(`/api/admin/users/${encodeURIComponent(id)}/usage?days=${days}`);
}

export function adminUserEvents(
  id: string,
  days = 30,
  limit = 100,
): Promise<{ success: true; days: number; events: UsageEvent[] }> {
  return authedJson(`/api/admin/users/${encodeURIComponent(id)}/events?days=${days}&limit=${limit}`);
}

export function adminUpdateUserBilling(
  id: string,
  body: {
    manualPlanCode?: BillingPlan["code"] | null;
    manualUnlimited?: boolean;
    manualReason?: string | null;
    manualExpiresAt?: string | null;
    addCredits?: number;
  },
): Promise<{ success: true; billing: BillingOverview }> {
  return authedJson(`/api/admin/users/${encodeURIComponent(id)}/billing`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
