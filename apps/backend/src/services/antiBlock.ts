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
  // Tolerate a scheme-less value like "user:pass@host:port" — without an explicit
  // "scheme://", new URL() misreads the username as the protocol and drops the host.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    const username = url.username || process.env.SCRAPE_PROXY_USERNAME?.trim() || undefined;
    const password = url.password || process.env.SCRAPE_PROXY_PASSWORD?.trim() || undefined;
    // Playwright wants the bare scheme://host:port in `server`, creds separately.
    const server = `${url.protocol}//${url.host}`;
    return { server, ...(username ? { username } : {}), ...(password ? { password } : {}) };
  } catch {
    log.warn("invalid SCRAPE_PROXY_URL; ignoring", { raw });
    return null;
  }
}

/** Full proxy URL (creds inline) for undici/fetch, or null when unset. */
export function getProxyUrl(): string | null {
  const cfg = getProxyConfig();
  if (!cfg) return null;
  if (!cfg.username) return cfg.server;
  const u = new URL(cfg.server);
  u.username = cfg.username;
  if (cfg.password) u.password = cfg.password;
  return u.toString();
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

// When the proxy fails we skip it and scrape direct for a cooldown window, then
// retry it — so a dead/misconfigured proxy degrades gracefully, but a transient
// blip (or a fix on the proxy side) doesn't disable the proxy for the whole
// process lifetime.
const PROXY_RETRY_COOLDOWN_MS =
  Number(process.env.PROXY_RETRY_COOLDOWN_MS) > 0 ? Number(process.env.PROXY_RETRY_COOLDOWN_MS) : 5 * 60_000;
let proxyDisabledUntil = 0;

/** Whether the proxy should be attempted (false during the post-failure cooldown). */
export function isProxyHealthy(): boolean {
  return Date.now() >= proxyDisabledUntil;
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

/**
 * `fetch` that routes through the proxy when one is configured and healthy, and
 * transparently retries DIRECT if the proxy connection/auth fails. This is the
 * fetch counterpart to the browser proxy in pageLoader.
 */
export async function proxyFetch(input: string, init?: RequestInit): Promise<Response> {
  const dispatcher = isProxyHealthy() ? await getProxyDispatcher() : null;
  if (!dispatcher) return fetch(input, init);
  try {
    const res = await fetch(input, { ...init, dispatcher } as RequestInit);
    if (res.status === 407) {
      markProxyUnhealthy("proxyFetch", "HTTP 407 proxy authentication required");
      return fetch(input, init);
    }
    return res;
  } catch (err) {
    markProxyUnhealthy("proxyFetch", (err as Error).message);
    return fetch(input, init);
  }
}
