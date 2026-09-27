import { chromium, type Browser, type Page } from "playwright";
import { sitesConfig } from "../../../../config/sites.config.js";
import { BrowserUnavailableError, CheckError } from "../types/productCheck.js";
import { createLogger } from "../utils/logger.js";
import { stripLocalePrefix } from "../utils/url.js";
import { Semaphore, SemaphoreAcquireTimeoutError } from "../utils/semaphore.js";
import { createBrowserHealth, type BrowserHealthSnapshot } from "./browserHealth.js";
import {
  STEALTH_INIT_SCRIPT,
  buildRealisticHeaders,
  getProxyConfig,
  isBlockedResponse,
  isProxyHealthy,
  markProxyBroken,
  fetchDirect,
  proxyFetch,
} from "./antiBlock.js";

/** Chromium navigation errors that indicate the proxy (not the site) is at fault. */
const PROXY_ERROR_RE = /ERR_PROXY|ERR_TUNNEL|PROXY_CONNECTION|ERR_NO_SUPPORTED_PROXIES|ECONNREFUSED.*proxy/i;

const log = createLogger("pageLoader");

/**
 * Caps concurrent Chromium processes across ALL in-flight requests. Without
 * this, N simultaneous requests each launch their own browser and exhaust the
 * container's memory. Tune via BROWSER_MAX_CONCURRENCY.
 */
const browserSlots = new Semaphore(sitesConfig.browser.maxConcurrency);

/**
 * Longest we wait for browser.close() before releasing the slot anyway.
 * Playwright's own close() is graceful for 30s and then SIGKILLs the browser's
 * whole process group, so waiting a little past that means the next session
 * never starts while the previous Chromium is still alive.
 */
const BROWSER_CLOSE_WAIT_MS = 35_000;

/** Launch outcomes; recycles the process when Chromium can no longer start. */
const browserHealth = createBrowserHealth({
  failuresBeforeExit: sitesConfig.browser.selfRestart ? sitesConfig.browser.launchFailuresBeforeExit : 0,
  graceMs: 30_000,
});

/** Launch stats for /health. */
export function getBrowserHealth(): BrowserHealthSnapshot {
  return browserHealth.snapshot();
}

/**
 * Launch Chromium with an explicit timeout and a couple of retries, so one
 * transient failure doesn't sink the whole check. When EVERY attempt dies
 * ~100ms in with `exitCode=null, signal=SIGTRAP` and no stderr, that is not a
 * transient: Chromium hit a hard container limit (typically pids.max, filled
 * with unreaped zombie helpers). Retrying can't fix that; browserHealth
 * restarts the process once it keeps happening.
 */
async function launchBrowserWithRetry(): Promise<Browser> {
  const { launchTimeoutMs } = sitesConfig.browser;
  // Only attach the proxy while it's healthy; once it fails we launch direct.
  const proxy = isProxyHealthy() ? getProxyConfig() : null;
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Last attempt drops the proxy: a browser that can't start (or can't tunnel)
    // through a dead gateway is strictly worse than one running direct, and the
    // browser tier is our only way past JS-rendered grids.
    const useProxy = attempt < maxAttempts ? proxy : null;
    try {
      const launched = await chromium.launch({
        headless: true,
        timeout: launchTimeoutMs,
        // Route through a residential/rotating proxy when configured — the only
        // reliable defense against Cloudflare IP-based blocking.
        ...(useProxy ? { proxy: useProxy } : {}),
        args: [
          "--disable-blink-features=AutomationControlled",
          // Container-friendly flags (Railway): avoid /dev/shm crashes + GPU overhead.
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
      browserHealth.recordLaunchSuccess();
      return launched;
    } catch (err) {
      lastErr = err;
      log.warn("browser launch failed", { attempt, maxAttempts, message: (err as Error).message });
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  const message = `Failed to launch browser after ${maxAttempts} attempts: ${(lastErr as Error)?.message ?? "unknown error"}`;
  browserHealth.recordLaunchFailure(message);
  throw new BrowserUnavailableError(message);
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

/**
 * Whether the headless browser should abort a request of this resource type to
 * save bandwidth (extracted as a pure function so the policy is unit-testable).
 *
 * Blocks pixels/media we never parse (image/media/font) and optionally CSS, but
 * NEVER document/script/xhr/fetch — those drive lazy grids and carry the actual
 * data. Blocking an image's *bytes* doesn't remove its <img> tag, so image
 * discovery (which reads attributes) and the separate DIRECT image download are
 * unaffected.
 */
export function shouldBlockResource(
  resourceType: string,
  opts: { blockAssets: boolean; blockStylesheets: boolean },
): boolean {
  if (!opts.blockAssets) return false;
  if (resourceType === "image" || resourceType === "media" || resourceType === "font") return true;
  if (opts.blockStylesheets && resourceType === "stylesheet") return true;
  return false;
}

const LISTING_PRODUCT_LINK_SELECTOR = 'a[href*="/products/"]';

/** A browser session that can render multiple pages without relaunching Chromium. */
export interface BrowserSession {
  loadPage(url: string, opts?: LoadPageOptions): Promise<LoadedPage>;
}

/**
 * True when `navUrl` points at a different page (path) than `targetUrl`. Used to
 * block client-side redirects (e.g. a collection that JS-redirects to the home
 * page) while still allowing same-page navigations and http→https / www changes.
 */
export function isRedirectAway(targetUrl: string, navUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    const nav = new URL(navUrl, targetUrl);
    // Compare paths with any leading Shopify locale segment stripped, so a
    // store that redirects /collections/all → /en-us/collections/all (the SAME
    // listing, localized) is NOT treated as a redirect-away (e.g. kouvrfashion).
    const tp = (stripLocalePrefix(target.pathname).replace(/\/+$/, "") || "/").toLowerCase();
    const np = (stripLocalePrefix(nav.pathname).replace(/\/+$/, "") || "/").toLowerCase();
    if (tp !== np) return true;
    // Same path, but if we asked for a specific sort (e.g. ?sort_by=best-selling)
    // and the page dropped/changed it, the order we'd capture is wrong — treat as
    // a redirect-away so the caller falls back to a direct fetch (which keeps it).
    const wantSort = target.searchParams.get("sort_by");
    if (wantSort && nav.searchParams.get("sort_by") !== wantSort) return true;
    return false;
  } catch {
    return false;
  }
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

  // The process is about to exit so the platform can restart it with a clean
  // container; don't start (and leave behind) yet another doomed Chromium.
  if (browserHealth.isRecycling()) {
    throw new BrowserUnavailableError("Browser unavailable: the service is restarting to recover Chromium.");
  }

  // Hold a global slot for the entire session so we never exceed the configured
  // number of live Chromium processes, no matter how many requests arrive. Time-
  // box the wait: if the pool is wedged, fail fast with a clear error instead of
  // parking this check in permanent "pending" behind the stuck holder.
  try {
    await browserSlots.acquire(browser.acquireTimeoutMs);
  } catch (err) {
    if (err instanceof SemaphoreAcquireTimeoutError) {
      throw new BrowserUnavailableError(
        `Browser pool saturated: no free slot after ${Math.round(browser.acquireTimeoutMs / 1000)}s.`,
      );
    }
    throw err;
  }

  // One close per browser, shared by the deadline timer and the finally below
  // (a second browser.close() adds nothing in Playwright; it only waits).
  let closing: Promise<void> | null = null;
  const closeBrowser = (): Promise<void> => {
    if (!browserInstance) return Promise.resolve();
    closing ??= browserInstance.close().catch(() => {});
    return closing;
  };

  // Safety net: if a session ever wedges (hung Chromium, a page that never
  // settles), force-close the browser at the deadline. That aborts in-flight
  // page work AND lets the finally below release the sole permit, so a single
  // bad store can't park every later check in permanent "pending".
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    log.error("session exceeded deadline; force-closing browser to release the slot", {
      deadlineMs: browser.sessionDeadlineMs,
    });
    void closeBrowser();
  }, browser.sessionDeadlineMs);
  killTimer.unref?.();

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

    // Drop bandwidth-heavy resources we never parse (images/media/fonts, and
    // optionally CSS). This is the single biggest proxy-bytes saver: a rendered
    // Shopify page is mostly assets, while SEO/rank extraction only needs the
    // HTML/JSON. JS, XHR and fetch are kept so lazy/infinite-scroll grids and
    // products.json-driven tiles still populate.
    if (browser.blockAssets) {
      await context.route("**/*", (route) => {
        if (shouldBlockResource(route.request().resourceType(), browser)) {
          return route.abort();
        }
        return route.continue();
      });
    }

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
          if (
            isBlockedResponse(
              response?.status() ?? 200,
              earlyHtml,
              response?.headers()["server"],
              response?.headers()["cf-mitigated"],
            )
          ) {
            throw new CheckError("PAGE_LOAD_FAILED", "Blocked by bot protection (Cloudflare challenge).");
          }

          // Some stores briefly render the real collection grid and then JS-redirect
          // headless browsers away (e.g. Laurence Boutique -> /search). Capture an
          // early snapshot as soon as product links appear so we can keep the real
          // listing if the later navigation tears down the page.
          const earlyListingSnapshot =
            opts?.scrollProfile === "listing" ? await captureListingSnapshot(page, url, browser.timeoutMs) : null;

          const scrollTimeout =
            opts?.scrollProfile === "listing"
              ? browser.scrollTimeoutMs
              : browser.productScrollTimeoutMs;
          await autoScroll(page, scrollTimeout, browser.scrollSettleRounds);

          let html: string;
          let finalUrl: string;
          let title: string;
          try {
            html = await page.content();
            finalUrl = page.url();
            title = await page.title();
          } catch (err) {
            if (earlyListingSnapshot && isNavigationInterruption(err)) {
              log.warn("using early listing snapshot after navigation interruption", {
                url,
                message: (err as Error).message,
              });
              return earlyListingSnapshot;
            }
            throw err;
          }

          // Some themes JS-redirect a deep URL (e.g. a sorted collection) to the
          // home page, which destroys the content we asked for. The browser can't
          // keep the page alive once its own script navigates away, so signal a
          // failure — callers fall back to a direct fetch, which (running no JS)
          // returns the real server-rendered content at the requested URL.
          if (isRedirectAway(url, finalUrl)) {
            if (earlyListingSnapshot) {
              log.warn("using early listing snapshot before redirect-away", {
                url,
                redirectedTo: finalUrl,
              });
              return earlyListingSnapshot;
            }
            throw new CheckError(
              "PAGE_LOAD_FAILED",
              `Page client-side redirected away from the requested URL (to ${finalUrl}).`,
            );
          }

          log.info("loaded", { inputUrl: url, finalUrl, status: response?.status() ?? null, htmlBytes: html.length });
          return { finalUrl, html, title };
        } catch (err) {
          if (err instanceof CheckError) throw err;
          // A proxy connection failure shouldn't doom every later request — trip
          // the health flag so subsequent sessions launch direct.
          if (PROXY_ERROR_RE.test((err as Error).message)) {
            markProxyBroken("browser navigation", (err as Error).message);
          }
          log.error("page load failed", { url, message: (err as Error).message });
          throw new CheckError("PAGE_LOAD_FAILED", `Failed to load page: ${(err as Error).message}`);
        } finally {
          await page.close().catch(() => {});
        }
      },
    };

    try {
      return await fn(session);
    } catch (err) {
      // A force-close at the deadline surfaces as an opaque "Target closed"
      // error; translate it so callers see a clear, actionable reason.
      if (timedOut) {
        throw new CheckError(
          "PAGE_LOAD_FAILED",
          `Session exceeded the ${Math.round(browser.sessionDeadlineMs / 1000)}s deadline and was aborted.`,
        );
      }
      throw err;
    }
  } finally {
    clearTimeout(killTimer);
    // Wait for the browser to be gone before handing the slot on: Playwright
    // escalates a hung close to SIGKILL on the process group after 30s, so this
    // normally resolves well inside BROWSER_CLOSE_WAIT_MS. Still capped, so a
    // stuck close can never hold the sole permit and wedge every later check in
    // permanent "pending".
    if (browserInstance && !(await settlesWithin(closeBrowser(), BROWSER_CLOSE_WAIT_MS))) {
      log.warn("browser did not close in time; releasing the slot anyway", { waitedMs: BROWSER_CLOSE_WAIT_MS });
    }
    browserSlots.release();
  }
}

/**
 * A session for when no browser can be had: every render fails straight away
 * with `reason`, so loadPageOrFetch takes its direct-fetch fallback.
 */
function browserlessSession(reason: string): BrowserSession {
  return {
    async loadPage() {
      throw new BrowserUnavailableError(reason);
    },
  };
}

/**
 * {@link withBrowserSession}, but when Chromium can't be obtained at all (launch
 * failure, saturated pool, process restarting) run `fn` without a browser: its
 * pages load via plain fetch, which still carries the server-rendered SEO tags
 * (<title>, meta, JSON-LD). Only launch-stage failures fall through — once `fn`
 * has started, its errors propagate unchanged, so it never runs twice.
 */
export async function withBrowserSessionOrFetch<T>(
  fn: (session: BrowserSession) => Promise<T>,
  onUnavailable?: (reason: string) => void,
): Promise<T> {
  let started = false;
  try {
    return await withBrowserSession((session) => {
      started = true;
      return fn(session);
    });
  } catch (err) {
    if (started || !(err instanceof BrowserUnavailableError)) throw err;
    log.warn("browser unavailable; continuing with direct fetch", { reason: err.message });
    onUnavailable?.(err.message);
    return fn(browserlessSession(err.message));
  }
}

/** Resolve true if `work` settles within `ms`, false otherwise (never rejects). */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureListingSnapshot(page: Page, targetUrl: string, timeoutMs: number): Promise<LoadedPage | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 8_000);
  while (Date.now() < deadline) {
    try {
      const finalUrl = page.url();
      if (isRedirectAway(targetUrl, finalUrl)) return null;
      const count = await page.locator(LISTING_PRODUCT_LINK_SELECTOR).count();
      if (count > 0) {
        const html = await page.content();
        const title = await page.title();
        return { finalUrl, html, title };
      }
    } catch (err) {
      if (!isNavigationInterruption(err)) return null;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

function isNavigationInterruption(err: unknown): boolean {
  const message = (err as Error)?.message ?? "";
  return /page\.content: Unable to retrieve content because the page is navigating|Execution context was destroyed|Target page, context or browser has been closed/i.test(
    message,
  );
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
    if (isBlockedResponse(res.status, html, res.headers.get("server"), res.headers.get("cf-mitigated"))) return null;
    return { finalUrl: res.url || url, html, title: extractHtmlTitle(html) };
  };

  // Try the proxy first (best against Cloudflare), then plain direct — some
  // stores block/mis-route the proxy's IP while serving a normal request fine.
  let lastDetail = "";
  for (const [label, attempt] of [
    ["proxy", () => proxyFetch(url, { headers, redirect: "follow" })],
    ["direct", () => fetchDirect(url, { headers, redirect: "follow" })],
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
