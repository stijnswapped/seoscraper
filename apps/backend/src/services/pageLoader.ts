import { chromium, type Browser, type Page } from "playwright";
import { sitesConfig } from "../../../../config/sites.config.js";
import { CheckError } from "../types/productCheck.js";
import { createLogger } from "../utils/logger.js";
import { Semaphore } from "../utils/semaphore.js";
import {
  STEALTH_INIT_SCRIPT,
  buildRealisticHeaders,
  getProxyConfig,
  isBlockedResponse,
  isProxyHealthy,
  markProxyUnhealthy,
  proxyFetch,
} from "./antiBlock.js";

/** Chromium navigation errors that indicate the proxy (not the site) is at fault. */
const PROXY_ERROR_RE = /ERR_PROXY|ERR_TUNNEL|PROXY_CONNECTION|ERR_NO_SUPPORTED_PROXIES|ECONNREFUSED.*proxy/i;

const log = createLogger("pageLoader");

/**
 * Caps concurrent Chromium processes across ALL in-flight requests. Without
 * this, N simultaneous requests each launch their own browser and OOM-kill the
 * container (the SIGTRAP-during-launch crash). Tune via BROWSER_MAX_CONCURRENCY.
 */
const browserSlots = new Semaphore(sitesConfig.browser.maxConcurrency);

/**
 * Launch Chromium with an explicit timeout and a couple of retries. The
 * chrome-headless-shell process occasionally dies mid-launch under memory
 * pressure (exitCode=null, signal=SIGTRAP); a transient failure shouldn't sink
 * the whole check.
 */
async function launchBrowserWithRetry(): Promise<Browser> {
  const { launchTimeoutMs } = sitesConfig.browser;
  // Only attach the proxy while it's healthy; once it fails we launch direct.
  const proxy = isProxyHealthy() ? getProxyConfig() : null;
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chromium.launch({
        headless: true,
        timeout: launchTimeoutMs,
        // Route through a residential/rotating proxy when configured — the only
        // reliable defense against Cloudflare IP-based blocking.
        ...(proxy ? { proxy } : {}),
        args: [
          "--disable-blink-features=AutomationControlled",
          // Container-friendly flags (Railway): avoid /dev/shm crashes + GPU overhead.
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
    } catch (err) {
      lastErr = err;
      log.warn("browser launch failed", { attempt, maxAttempts, message: (err as Error).message });
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new CheckError(
    "PAGE_LOAD_FAILED",
    `Failed to launch browser after ${maxAttempts} attempts: ${(lastErr as Error)?.message ?? "unknown error"}`,
  );
}

export interface LoadedPage {
  finalUrl: string;
  html: string;
  title: string;
}

export interface LoadPageOptions {
  /** "product" uses a short scroll budget; "listing" uses the long one. */
  scrollProfile?: "product" | "listing";
}

/** A browser session that can render multiple pages without relaunching Chromium. */
export interface BrowserSession {
  loadPage(url: string, opts?: LoadPageOptions): Promise<LoadedPage>;
}

/**
 * Launch one headless browser, run `fn` with a session that can render many
 * pages (reused context = far cheaper than a browser per URL), then close it.
 */
export async function withBrowserSession<T>(
  fn: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const { browser } = sitesConfig;
  let browserInstance: Browser | null = null;

  // Hold a global slot for the entire session so we never exceed the configured
  // number of live Chromium processes, no matter how many requests arrive.
  await browserSlots.acquire();
  try {
    browserInstance = await launchBrowserWithRetry();
    const context = await browserInstance.newContext({
      userAgent: browser.userAgent,
      viewport: browser.viewport,
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: browser.extraHTTPHeaders,
      ignoreHTTPSErrors: false,
    });
    // Hide the headless/automation tells before any site script runs.
    await context.addInitScript(STEALTH_INIT_SCRIPT);

    const session: BrowserSession = {
      async loadPage(url: string, opts?: LoadPageOptions): Promise<LoadedPage> {
        const page = await context.newPage();
        page.setDefaultTimeout(browser.timeoutMs);
        try {
          log.info("navigating", { url });
          const response = await page.goto(url, {
            waitUntil: browser.waitUntil,
            timeout: browser.timeoutMs,
          });
          await page
            .waitForLoadState("networkidle", { timeout: Math.min(5000, browser.timeoutMs) })
            .catch(() => {});

          if (response && response.status() >= 400) {
            throw new CheckError("PAGE_LOAD_FAILED", `Page returned HTTP ${response.status()}.`);
          }

          // Detect a Cloudflare (or similar) challenge page so callers can fall
          // back instead of parsing the interstitial as if it were the product.
          const earlyHtml = await page.content();
          if (isBlockedResponse(response?.status() ?? 200, earlyHtml, response?.headers()["server"])) {
            throw new CheckError("PAGE_LOAD_FAILED", "Blocked by bot protection (Cloudflare challenge).");
          }

          const scrollTimeout =
            opts?.scrollProfile === "listing"
              ? browser.scrollTimeoutMs
              : browser.productScrollTimeoutMs;
          await autoScroll(page, scrollTimeout, browser.scrollSettleRounds);

          const html = await page.content();
          const finalUrl = page.url();
          const title = await page.title();
          log.info("loaded", { inputUrl: url, finalUrl, status: response?.status() ?? null, htmlBytes: html.length });
          return { finalUrl, html, title };
        } catch (err) {
          if (err instanceof CheckError) throw err;
          // A proxy connection failure shouldn't doom every later request — trip
          // the health flag so subsequent sessions launch direct.
          if (PROXY_ERROR_RE.test((err as Error).message)) {
            markProxyUnhealthy("browser navigation", (err as Error).message);
          }
          log.error("page load failed", { url, message: (err as Error).message });
          throw new CheckError("PAGE_LOAD_FAILED", `Failed to load page: ${(err as Error).message}`);
        } finally {
          await page.close().catch(() => {});
        }
      },
    };

    return await fn(session);
  } finally {
    if (browserInstance) await browserInstance.close().catch(() => {});
    browserSlots.release();
  }
}

/** Render a single page (convenience wrapper around a one-shot session). */
export async function loadRenderedPage(url: string): Promise<LoadedPage> {
  return withBrowserSession((session) => session.loadPage(url, { scrollProfile: "product" }));
}

/**
 * Fetch a page's HTML directly (no browser), with realistic headers + proxy.
 * Used as a fallback when the headless browser is blocked (Cloudflare 403 /
 * challenge) or times out — many stores serve a normal fetch fine even when they
 * block headless Chromium. The returned HTML still contains server-rendered SEO
 * tags (<title>, og:*, JSON-LD), which is all the metadata extractor needs.
 */
export async function fetchPageDirect(url: string): Promise<LoadedPage> {
  const headers = buildRealisticHeaders(new URL(url).origin);

  // Read a response into a LoadedPage, or null if it was an error/block page.
  const toPage = async (res: Response): Promise<LoadedPage | null> => {
    if (!res.ok) return null;
    const html = await res.text();
    if (isBlockedResponse(res.status, html, res.headers.get("server"))) return null;
    return { finalUrl: res.url || url, html, title: extractHtmlTitle(html) };
  };

  // Try the proxy first (best against Cloudflare), then plain direct — some
  // stores block/mis-route the proxy's IP while serving a normal request fine.
  let lastDetail = "";
  for (const [label, attempt] of [
    ["proxy", () => proxyFetch(url, { headers, redirect: "follow" })],
    ["direct", () => fetch(url, { headers, redirect: "follow" })],
  ] as const) {
    try {
      const res = await attempt();
      const page = await toPage(res);
      if (page) {
        log.info("loaded via direct fetch fallback", { inputUrl: url, finalUrl: page.finalUrl, via: label, htmlBytes: page.html.length });
        return page;
      }
      lastDetail = `${label} HTTP ${res.status}`;
    } catch (err) {
      lastDetail = `${label}: ${(err as Error).message}`;
    }
  }
  throw new CheckError("PAGE_LOAD_FAILED", `Direct fetch failed or blocked (${lastDetail}).`);
}

/**
 * Load a page via the headless browser, falling back to a direct fetch if the
 * browser is blocked or fails. `onFallback` is invoked (once) with the browser
 * error before the fetch is attempted, for progress/logging.
 */
export async function loadPageOrFetch(
  url: string,
  opts: LoadPageOptions | undefined,
  session: BrowserSession | undefined,
  onFallback?: (reason: string) => void,
): Promise<LoadedPage> {
  try {
    return session ? await session.loadPage(url, opts) : await loadRenderedPage(url);
  } catch (err) {
    if (!(err instanceof CheckError)) throw err;
    onFallback?.((err as Error).message);
    return fetchPageDirect(url);
  }
}

/** Pull the <title> text out of raw HTML (best-effort; extractor re-derives it). */
function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Scroll down in steps to trigger lazy-load / infinite-scroll handlers.
 * Stops when the page height is stable for `settleRounds` consecutive rounds
 * (after trying a "load more" button), or when the overall timeout is hit.
 */
async function autoScroll(page: Page, timeoutMs: number, settleRounds: number): Promise<void> {
  const start = Date.now();
  try {
    let previousHeight = 0;
    let stable = 0;
    while (Date.now() - start < timeoutMs) {
      const height = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
        return document.body.scrollHeight;
      });
      await page.waitForTimeout(300);

      if (height === previousHeight) {
        stable += 1;
        if (stable >= settleRounds) {
          // Page seems done — try a "load more" control before giving up.
          const clicked = await clickLoadMore(page);
          if (!clicked) break;
          stable = 0;
          await page.waitForTimeout(500);
        }
      } else {
        stable = 0;
      }
      previousHeight = height;
    }
    // Return to top so above-the-fold lazy images settle too.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
  } catch (err) {
    log.warn("auto-scroll interrupted", { message: (err as Error).message });
  }
}

/** Best-effort click of a visible "load more / show more" button. */
async function clickLoadMore(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const labels = ["load more", "show more", "view more", "meer laden", "meer tonen", "toon meer", "laad meer"];
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button]"));
      const btn = nodes.find((el) => {
        const text = (el.textContent || "").trim().toLowerCase();
        if (!text || text.length > 40) return false;
        const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        return visible && labels.some((l) => text.includes(l));
      });
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}
