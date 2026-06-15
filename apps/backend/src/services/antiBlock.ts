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
import { AsyncLocalStorage } from "node:async_hooks";
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
 * The proxy in effect for the current request. Resolved once at the request
 * boundary ({@link runWithProxy}) and read anywhere downstream via
 * {@link currentProxy} — so per-customer proxies flow through the existing
 * helpers without threading a parameter through every function.
 */
export interface ProxyContext {
  config: ProxyConfig | null;
  /** Full URL with inline creds for undici, or null = direct. */
  url: string | null;
  /** Whether this proxy rotates exit IPs (retry-worthy; never cooldown-disabled). */
  rotating: boolean;
  /** Stable identity (the server origin) for health + dispatcher caching; "" = none. */
  key: string;
  source: "request" | "env" | "none";
}

const NO_PROXY: ProxyContext = { config: null, url: null, rotating: false, key: "", source: "none" };

/**
 * Parse a proxy spec into a {@link ProxyConfig}. Supports a single URL with
 * optional inline creds (`http://user:pass@host:port`); when `raw` omits creds,
 * the split `SCRAPE_PROXY_USERNAME` / `SCRAPE_PROXY_PASSWORD` env vars are used
 * as a fallback (env proxy only). Returns null when empty/invalid.
 */
function parseProxyConfig(raw: string, allowEnvCreds: boolean): ProxyConfig | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Parse manually instead of new URL(): proxy passwords often contain special
  // chars (@ / # : etc.) that break URL parsing. Strip the scheme, split the
  // userinfo from host:port on the LAST '@', then user/pass on the FIRST ':'.
  const noScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const at = noScheme.lastIndexOf("@");
  const userinfo = at >= 0 ? noScheme.slice(0, at) : "";
  const hostport = (at >= 0 ? noScheme.slice(at + 1) : noScheme).trim();
  if (!hostport) return null;
  let username = allowEnvCreds ? process.env.SCRAPE_PROXY_USERNAME?.trim() || undefined : undefined;
  let password = allowEnvCreds ? process.env.SCRAPE_PROXY_PASSWORD?.trim() || undefined : undefined;
  if (userinfo) {
    const colon = userinfo.indexOf(":");
    username = (colon >= 0 ? userinfo.slice(0, colon) : userinfo) || username;
    if (colon >= 0) password = userinfo.slice(colon + 1) || password;
  }
  return { server: `http://${hostport}`, ...(username ? { username } : {}), ...(password ? { password } : {}) };
}

/** Full proxy URL (creds inline, percent-encoded) for undici/fetch, or null. */
function configToUrl(cfg: ProxyConfig | null): string | null {
  if (!cfg) return null;
  if (!cfg.username) return cfg.server;
  // Encode creds so special characters survive into the proxy URI (undici decodes them).
  const auth = `${encodeURIComponent(cfg.username)}${cfg.password ? `:${encodeURIComponent(cfg.password)}` : ""}`;
  return cfg.server.replace(/^http:\/\//, `http://${auth}@`);
}

/**
 * Build a {@link ProxyContext}. With a non-empty `override` (a per-request /
 * per-customer proxy) that wins; otherwise we fall back to the env proxy. A
 * customer-supplied proxy is treated as STATIC (we can't know it rotates, so it
 * uses the conservative cooldown path); only the env proxy honours PROXY_ROTATING.
 */
export function resolveProxyContext(override?: string | null): ProxyContext {
  const fromRequest = !!override && override.trim() !== "";
  const raw = fromRequest
    ? normalizeProxyInput(override as string)
    : (process.env.SCRAPE_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "");
  const config = parseProxyConfig(raw, !fromRequest);
  if (!config) {
    if (fromRequest) log.warn("invalid request proxy; ignoring", { proxy: redactProxy(raw) });
    return NO_PROXY;
  }
  return {
    config,
    url: configToUrl(config),
    rotating: !fromRequest && PROXY_ROTATING,
    key: config.server,
    source: fromRequest ? "request" : "env",
  };
}

/** Whether an env-level proxy is configured (for usage labelling). */
export function hasEnvProxy(): boolean {
  return resolveProxyContext(null).config !== null;
}

const proxyStore = new AsyncLocalStorage<ProxyContext>();

/** The proxy for the current async scope, falling back to the env proxy. */
function currentProxy(): ProxyContext {
  return proxyStore.getStore() ?? resolveProxyContext(null);
}

/**
 * Run `fn` with `override` (a per-request proxy URL, or null/empty to use the
 * env proxy) as the active proxy for everything it awaits. AsyncLocalStorage
 * propagates across awaits and Promise.all, so nested fetches, the browser
 * launch, pagination and enrichment all inherit it without parameter threading.
 */
export function runWithProxy<T>(override: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  return proxyStore.run(resolveProxyContext(override), fn);
}

/** Mask credentials in a proxy spec for safe logging. Never log a raw proxy URL. */
export function redactProxy(raw: string | null | undefined): string {
  if (!raw) return "(none)";
  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^@/]*@/i, "$1***@");
}

/** Hosts a customer proxy must not point at (SSRF guard for the CONNECT target). */
const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fc|\[?fd)/i;

/**
 * Accept either a bare proxy URL or a full `curl -x user:pass@host:port …`
 * command (what Smartproxy's "generate proxy" outputs) and return a normalized,
 * scheme-prefixed proxy URL. Best-effort: returns the trimmed input (with a
 * scheme added) if nothing curl-like is found.
 */
export function normalizeProxyInput(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return s;
  // Pull the value after -x / --proxy out of a curl command.
  const flag = s.match(/(?:-x|--proxy)\s+(['"]?)([^'"\s]+)\1/i);
  if (flag) {
    s = flag[2]!;
  } else if (/\s/.test(s)) {
    // Space-separated blob: take the first token shaped like [user:pass@]host:port.
    const tok = s.split(/\s+/).find((t) => /[^\s]+:\d+$/.test(t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")));
    if (tok) s = tok;
  }
  s = s.replace(/^['"]|['"]$/g, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

/**
 * Validate a request-supplied proxy (URL or curl command). Returns an error
 * message when it's unusable (so the route can 400) or null when accepted.
 * Rejects bad shapes and loopback/private CONNECT targets so the API can't be
 * used to reach internal services.
 */
export function validateProxyOverride(raw: string): string | null {
  const cfg = parseProxyConfig(normalizeProxyInput(raw), false);
  if (!cfg) return "proxy must be a URL like http://user:pass@host:port";
  const hostport = cfg.server.replace(/^http:\/\//, "");
  const host = hostport.replace(/:\d+$/, "");
  if (!/:\d+$/.test(hostport)) return "proxy must include a port";
  if (PRIVATE_HOST_RE.test(host)) return "proxy host must not be a loopback or private address";
  return null;
}

/**
 * Resolve a proxy from env (back-compat). Now reads the request-scoped proxy
 * when one is active, so callers get the per-customer proxy automatically.
 */
export function getProxyConfig(): ProxyConfig | null {
  return currentProxy().config;
}

/** Full proxy URL (creds inline, percent-encoded) for the active proxy, or null. */
export function getProxyUrl(): string | null {
  return currentProxy().url;
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
// Keyed by proxy identity so one customer's dead proxy doesn't disable everyone's.
const proxyDisabledUntil = new Map<string, number>();

/** Whether the active proxy should be attempted (false during its cooldown). */
export function isProxyHealthy(): boolean {
  const ctx = currentProxy();
  if (!ctx.config) return false;
  // A rotating gateway is always "healthy" — we never disable it on a bad exit.
  if (ctx.rotating) return true;
  return Date.now() >= (proxyDisabledUntil.get(ctx.key) ?? 0);
}

/** Whether a proxy is configured at all (independent of the cooldown window). */
export function isProxyConfigured(): boolean {
  return currentProxy().config !== null;
}

/**
 * Whether the active proxy is a ROTATING pool, i.e. each new request/connection
 * gets a fresh exit IP. Callers use this to decide whether retrying a blocked
 * request is worthwhile (a fresh exit may not be blocked); a static proxy or no
 * proxy would just hit the same IP again.
 */
export function isProxyRotating(): boolean {
  return currentProxy().rotating;
}

/** Skip the active proxy (go direct) for the cooldown window, then auto-retry it. */
export function markProxyUnhealthy(context: string, detail?: string): void {
  const ctx = currentProxy();
  if (!ctx.config) return;
  const wasHealthy = isProxyHealthy();
  proxyDisabledUntil.set(ctx.key, Date.now() + PROXY_RETRY_COOLDOWN_MS);
  if (wasHealthy) {
    log.warn(`proxy failed; using DIRECT and retrying proxy in ${Math.round(PROXY_RETRY_COOLDOWN_MS / 1000)}s`, {
      context,
      detail,
      proxy: redactProxy(ctx.key),
    });
  }
}

// One undici ProxyAgent per distinct proxy URL (reused across requests).
const dispatcherCache = new Map<string, unknown>();
let undiciModule: { ProxyAgent: new (uri: string) => unknown } | null | undefined;

/** Lazily build (and cache) an undici ProxyAgent for the active proxy, or null. */
async function getProxyDispatcher(): Promise<unknown | null> {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return null;
  const cached = dispatcherCache.get(proxyUrl);
  if (cached !== undefined) return cached;
  if (undiciModule === undefined) {
    try {
      undiciModule = (await import("undici")) as { ProxyAgent: new (uri: string) => unknown };
    } catch (err) {
      undiciModule = null;
      log.warn("undici ProxyAgent unavailable; scraping direct", { message: (err as Error).message });
    }
  }
  if (!undiciModule) return null;
  const dispatcher = new undiciModule.ProxyAgent(proxyUrl);
  dispatcherCache.set(proxyUrl, dispatcher);
  log.info("fetch proxy configured", { proxy: redactProxy(getProxyConfig()?.server) });
  return dispatcher;
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
  const rotating = isProxyRotating();
  const attempts = rotating ? PROXY_RETRY_ATTEMPTS : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(input, { ...init, dispatcher } as RequestInit, PROXY_FETCH_TIMEOUT_MS);
      if (res.status === 407) {
        // Auth failure won't fix itself by retrying — bail to direct.
        if (!rotating) markProxyUnhealthy("proxyFetch", "HTTP 407 proxy authentication required");
        return fetchWithTimeout(input, init, PROXY_FETCH_TIMEOUT_MS);
      }
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  // All proxy attempts failed.
  if (!rotating) markProxyUnhealthy("proxyFetch", (lastErr as Error)?.message);
  else log.warn("proxy attempts exhausted; falling back to DIRECT for this request", { message: (lastErr as Error)?.message });
  return fetchWithTimeout(input, init, PROXY_FETCH_TIMEOUT_MS);
}
