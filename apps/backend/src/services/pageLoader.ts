import { chromium, type Browser } from "playwright";
import { sitesConfig } from "../../../../config/sites.config.js";
import { CheckError } from "../types/productCheck.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("pageLoader");

export interface LoadedPage {
  finalUrl: string;
  html: string;
  title: string;
}

/**
 * Render a page with a headless browser, scroll to trigger lazy-loaded product
 * images, and return the settled HTML + final (post-redirect) URL.
 */
export async function loadRenderedPage(url: string): Promise<LoadedPage> {
  const { browser } = sitesConfig;
  let browserInstance: Browser | null = null;

  try {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browserInstance.newContext({
      userAgent: browser.userAgent,
      viewport: browser.viewport,
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: browser.extraHTTPHeaders,
      ignoreHTTPSErrors: false,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(browser.timeoutMs);

    log.info("navigating", { url });
    const response = await page.goto(url, {
      waitUntil: browser.waitUntil,
      timeout: browser.timeoutMs,
    });
    await page.waitForLoadState("networkidle", {
      timeout: Math.min(5000, browser.timeoutMs),
    }).catch(() => {});

    if (response && response.status() >= 400) {
      throw new CheckError(
        "PAGE_LOAD_FAILED",
        `Page returned HTTP ${response.status()}.`,
      );
    }

    await autoScroll(page, browser.scrollTimeoutMs);

    const html = await page.content();
    const finalUrl = page.url();
    const title = await page.title();

    log.info("loaded", {
      inputUrl: url,
      finalUrl,
      status: response?.status() ?? null,
      htmlBytes: html.length,
    });
    return { finalUrl, html, title };
  } catch (err) {
    if (err instanceof CheckError) throw err;
    log.error("page load failed", { url, message: (err as Error).message });
    throw new CheckError(
      "PAGE_LOAD_FAILED",
      `Failed to load page: ${(err as Error).message}`,
    );
  } finally {
    if (browserInstance) await browserInstance.close().catch(() => {});
  }
}

/** Scroll down in steps to trigger lazy-load handlers, bounded by a timeout. */
async function autoScroll(
  page: import("playwright").Page,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  try {
    let previousHeight = 0;
    while (Date.now() - start < timeoutMs) {
      const height = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
        return document.body.scrollHeight;
      });
      await page.waitForTimeout(300);
      if (height === previousHeight) break;
      previousHeight = height;
    }
    // Scroll back to top so above-the-fold lazy images settle too.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
  } catch (err) {
    log.warn("auto-scroll interrupted", { message: (err as Error).message });
  }
}
