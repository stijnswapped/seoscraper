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
  try {
    const url = new URL(raw);
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

let fetchProxyApplied = false;

/**
 * Route Node's global `fetch` through the configured proxy (via undici). Called
 * once at startup; a no-op when no proxy is set. Dynamic-imports undici so the
 * absence of the proxy feature never breaks the app.
 */
export async function applyGlobalFetchProxy(): Promise<void> {
  if (fetchProxyApplied) return;
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return;
  try {
    const undici = (await import("undici")) as {
      ProxyAgent: new (uri: string) => unknown;
      setGlobalDispatcher: (d: unknown) => void;
    };
    undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
    fetchProxyApplied = true;
    log.info("global fetch proxy enabled");
  } catch (err) {
    log.warn("could not enable fetch proxy (undici unavailable)", { message: (err as Error).message });
  }
}
