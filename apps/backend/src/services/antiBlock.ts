/**
 * Anti-bot / anti-Cloudflare helpers.
 *
 * Cloudflare blocks scrapers on two signals: (1) the request *fingerprint*
 * (missing client-hint headers, an automation-controlled browser, a
 * datacenter IP) and (2) a JS challenge page ("Just a moment…"). This module
 * centralizes our countermeasures so the browser path and the plain-`fetch`
 * path present an identical, realistic identity:
 *
 *   - realistic Chrome client-hint + sec-fetch headers
 *   - a stealth init script that hides the headless/automation tells
 *   - optional residential/rotating proxy (the only reliable fix for IP blocks)
 *   - detection of Cloudflare challenge pages so we degrade instead of storing
 *     garbage ranks
 *
 * Everything is env-driven and degrades gracefully: with no proxy configured the
 * stealth + header work still meaningfully lowers the block rate.
 */
import { sitesConfig } from "../../../../config/sites.config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("antiBlock");

/** Playwright's proxy option shape (kept local to avoid importing the type). */
export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Resolve a proxy from env. Supports a single URL with optional inline creds
 * (`http://user:pass@host:port`) or split `SCRAPE_PROXY_USERNAME` /
 * `SCRAPE_PROXY_PASSWORD`. Returns null when unset (no proxy).
 */
export function getProxyConfig(): ProxyConfig | null {
  const raw = (process.env.SCRAPE_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "").trim();
  if (!raw) return null;
  // Parse manually instead of new URL(): proxy passwords often contain special
  // chars (@ / # : etc.) that break URL parsing. Strip the scheme, split the
  // userinfo from host:port on the LAST '@', then user/pass on the FIRST ':'.
  const noScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const at = noScheme.lastIndexOf("@");
  const userinfo = at >= 0 ? noScheme.slice(0, at) : "";
  const hostport = (at >= 0 ? noScheme.slice(at + 1) : noScheme).trim();
  if (!hostport) {
    log.warn("invalid SCRAPE_PROXY_URL; ignoring", { raw });
    return null;
  }
  let username = process.env.SCRAPE_PROXY_USERNAME?.trim() || undefined;
  let password = process.env.SCRAPE_PROXY_PASSWORD?.trim() || undefined;
  if (userinfo) {
    const colon = userinfo.indexOf(":");
    username = (colon >= 0 ? userinfo.slice(0, colon) : userinfo) || username;
    if (colon >= 0) password = userinfo.slice(colon + 1) || password;
  }
  return { server: `http://${hostport}`, ...(username ? { username } : {}), ...(password ? { password } : {}) };
}

/** Full proxy URL (creds inline, percent-encoded) for undici/fetch, or null when unset. */
export function getProxyUrl(): string | null {
  const cfg = getProxyConfig();
  if (!cfg) return null;
  if (!cfg.username) return cfg.server;
  // Encode creds so special characters survive into the proxy URI (undici decodes them).
  const auth = `${encodeURIComponent(cfg.username)}${cfg.password ? `:${encodeURIComponent(cfg.password)}` : ""}`;
  return cfg.server.replace(/^http:\/\//, `http://${auth}@`);
}

/**
 * Realistic Chrome request headers, including client hints and sec-fetch
 * metadata, derived from the configured user-agent. A top-level navigation that
 * omits these looks like a bot to Cloudflare.
 */
export function buildRealisticHeaders(referer?: string): Record<string, string> {
  const { userAgent, extraHTTPHeaders } = sitesConfig.browser;
  const headers: Record<string, string> = {
    "user-agent": userAgent,
    accept:
      extraHTTPHeaders.Accept ??
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": extraHTTPHeaders["Accept-Language"] ?? "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": referer ? "same-origin" : "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };
  if (referer) headers.referer = referer;
  return headers;
}

/**
 * Patches applied before any page script runs, hiding the automation tells
 * Cloudflare's bot-detection probes. Injected via context.addInitScript.
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  try {
    // navigator.webdriver -> undefined (the #1 automation tell).
    Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => undefined });
  } catch {}
  try {
    // A non-empty plugins/mimeTypes list, like a real Chrome.
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  } catch {}
  try {
    // window.chrome runtime shim (absent in headless).
    window.chrome = window.chrome || { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
  } catch {}
  try {
    // Permissions.query returns 'prompt' for notifications like a real browser.
    const orig = window.navigator.permissions && window.navigator.permissions.query;
    if (orig) {
      window.navigator.permissions.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig(params);
    }
  } catch {}
  try {
    // Spoof a real GPU vendor/renderer (headless reports SwiftShader).
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, param);
    };
  } catch {}
})();
`;

/**
 * Heuristic: does this response look like a Cloudflare (or similar) block /
 * challenge rather than the real page? Used to escalate or degrade instead of
 * parsing a challenge page as if it were the product grid.
 */
export function isBlockedResponse(status: number, html: string, server?: string | null): boolean {
  if (status === 403 || status === 429 || status === 503 || (status >= 520 && status <= 530)) return true;
  const head = html.slice(0, 4000).toLowerCase();
  return (
    head.includes("just a moment") ||
    head.includes("cf-browser-verification") ||
    head.includes("cf-challenge") ||
    head.includes("/cdn-cgi/challenge-platform") ||
    head.includes("attention required") ||
    (head.includes("cloudflare") && head.includes("captcha")) ||
    (server?.toLowerCase() === "cloudflare" && head.includes("ray id"))
  );
}

// Rotating proxies (residential pools) hand out a different exit IP per request,
// so a single failure/blocked exit must NOT disable the whole pool — we just
// retry through the gateway and get a fresh IP. Set PROXY_ROTATING=true for these.
const PROXY_ROTATING = (process.env.PROXY_ROTATING ?? "").trim().toLowerCase() === "true";
const PROXY_RETRY_ATTEMPTS =
  Number(process.env.PROXY_RETRY_ATTEMPTS) > 0 ? Number(process.env.PROXY_RETRY_ATTEMPTS) : 3;

// For a single STATIC proxy, when it fails we skip it and scrape direct for a
// cooldown window, then retry it — a dead proxy degrades gracefully, but a
// transient blip doesn't disable the proxy for the whole process lifetime.
const PROXY_RETRY_COOLDOWN_MS =
  Number(process.env.PROXY_RETRY_COOLDOWN_MS) > 0 ? Number(process.env.PROXY_RETRY_COOLDOWN_MS) : 5 * 60_000;
let proxyDisabledUntil = 0;

/** Whether the proxy should be attempted (false during the post-failure cooldown). */
export function isProxyHealthy(): boolean {
  // A rotating gateway is always "healthy" — we never disable it on a bad exit.
  return PROXY_ROTATING || Date.now() >= proxyDisabledUntil;
}

/** Whether a proxy is configured at all (independent of the cooldown window). */
export function isProxyConfigured(): boolean {
  return getProxyConfig() !== null;
}

/**
 * Whether a configured proxy is a ROTATING pool (PROXY_ROTATING=true), i.e. each
 * new request/connection gets a fresh exit IP. Callers use this to decide whether
 * retrying a blocked request is worthwhile (a fresh exit may not be blocked); a
 * static proxy or no proxy would just hit the same IP again.
 */
export function isProxyRotating(): boolean {
  return PROXY_ROTATING && isProxyConfigured();
}

/** Skip the proxy (go direct) for the cooldown window, then it auto-retries. */
export function markProxyUnhealthy(context: string, detail?: string): void {
  const wasHealthy = isProxyHealthy();
  proxyDisabledUntil = Date.now() + PROXY_RETRY_COOLDOWN_MS;
  if (wasHealthy) {
    log.warn(`proxy failed; using DIRECT and retrying proxy in ${Math.round(PROXY_RETRY_COOLDOWN_MS / 1000)}s`, {
      context,
      detail,
    });
  }
}

let cachedDispatcher: unknown | null | undefined;

/** Lazily build (and cache) an undici ProxyAgent for fetch, or null if none. */
async function getProxyDispatcher(): Promise<unknown | null> {
  if (cachedDispatcher !== undefined) return cachedDispatcher as unknown | null;
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) {
    cachedDispatcher = null;
    return null;
  }
  try {
    const undici = (await import("undici")) as { ProxyAgent: new (uri: string) => unknown };
    cachedDispatcher = new undici.ProxyAgent(proxyUrl);
    log.info("fetch proxy configured");
  } catch (err) {
    log.warn("undici ProxyAgent unavailable; scraping direct", { message: (err as Error).message });
    cachedDispatcher = null;
  }
  return cachedDispatcher as unknown | null;
}

const PROXY_FETCH_TIMEOUT_MS =
  Number(process.env.PROXY_FETCH_TIMEOUT_MS) > 0 ? Number(process.env.PROXY_FETCH_TIMEOUT_MS) : 25_000;

/**
 * Plain DIRECT fetch (never routed through the proxy), time-boxed like
 * {@link proxyFetch}. Used to retry a request from the origin's own IP when the
 * proxy exit IP is blocked — shared/datacenter proxy IPs are challenged by
 * Cloudflare far more often than a store's own server IP.
 */
export async function fetchDirect(input: string, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(input, init, PROXY_FETCH_TIMEOUT_MS);
}

/** fetch() with a hard timeout so a hanging connection can't stall a request forever. */
async function fetchWithTimeout(input: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal } as RequestInit);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetch` that routes through the proxy when one is configured and healthy, and
 * transparently retries DIRECT if the proxy connection/auth fails OR times out.
 * Both attempts are time-boxed so a slow/hanging proxy can never stall the
 * request indefinitely (this is what caused tracking to hang).
 */
export async function proxyFetch(input: string, init?: RequestInit): Promise<Response> {
  const dispatcher = isProxyHealthy() ? await getProxyDispatcher() : null;
  if (!dispatcher) return fetchWithTimeout(input, init, PROXY_FETCH_TIMEOUT_MS);

  // Rotating: retry through the gateway (new exit IP each attempt) before giving
  // up, and never trip the cooldown. Static: a single failure → direct + cooldown.
  const attempts = PROXY_ROTATING ? PROXY_RETRY_ATTEMPTS : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(input, { ...init, dispatcher } as RequestInit, PROXY_FETCH_TIMEOUT_MS);
      if (res.status === 407) {
        // Auth failure won't fix itself by retrying — bail to direct.
        if (!PROXY_ROTATING) markProxyUnhealthy("proxyFetch", "HTTP 407 proxy authentication required");
        return fetchWithTimeout(input, init, PROXY_FETCH_TIMEOUT_MS);
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  // All proxy attempts failed.
  if (!PROXY_ROTATING) markProxyUnhealthy("proxyFetch", (lastErr as Error)?.message);
  else log.warn("proxy attempts exhausted; falling back to DIRECT for this request", { message: (lastErr as Error)?.message });
  return fetchWithTimeout(input, init, PROXY_FETCH_TIMEOUT_MS);
}
