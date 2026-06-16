import { load, type CheerioAPI } from "cheerio";
import { sitesConfig } from "../../../../config/sites.config.js";
import type { ProgressReporter } from "./progressHub.js";
import type { BrowserSession, LoadedPage } from "./pageLoader.js";

/**
 * Clamp a per-request maxPages override against the configured default/ceiling.
 * Returns the configured default when `requested` is missing/invalid.
 */
export function resolveMaxPages(requested: number | undefined): number {
  const { maxPages, maxPagesCeiling } = sitesConfig.collections;
  if (!Number.isFinite(requested) || (requested as number) <= 0) return maxPages;
  return Math.min(Math.floor(requested as number), maxPagesCeiling);
}

export interface CrawlOptions {
  maxPages: number;
  progress?: ProgressReporter;
  /** Label used in progress messages, e.g. "Scanning collection". */
  label?: string;
  /** Which scroll budget to use when rendering pages. */
  scrollProfile?: "product" | "listing";
  /** Return true to stop crawling early (e.g. enough items collected). */
  shouldStop?: () => boolean;
  /** Optional already-rendered first page, to avoid re-rendering it. */
  firstPage?: LoadedPage;
}

/**
 * Walk paginated listing pages starting at `startUrl`, rendering each with the
 * shared browser session and following the detected "next page" link. Calls
 * `onPage` for every rendered page. Bounded by `maxPages`, visited-URL dedup,
 * and `shouldStop`.
 */
export async function crawlPages(
  session: BrowserSession,
  startUrl: string,
  options: CrawlOptions,
  onPage: (ctx: { $: CheerioAPI; finalUrl: string; pageNumber: number }) => void,
): Promise<number> {
  const visited = new Set<string>();
  let url: string | null = startUrl;
  let pageNumber = 0;

  while (url && pageNumber < options.maxPages) {
    if (visited.has(url)) break;
    visited.add(url);
    pageNumber += 1;

    const page: LoadedPage =
      pageNumber === 1 && options.firstPage
        ? options.firstPage
        : await session.loadPage(url, { scrollProfile: options.scrollProfile ?? "listing" });
    const $ = load(page.html);
    onPage({ $, finalUrl: page.finalUrl, pageNumber });

    options.progress?.({
      phase: "scanning-pages",
      message: `${options.label ?? "Scanning"}, page ${pageNumber} of up to ${options.maxPages}`,
      url: page.finalUrl,
      current: pageNumber,
      total: options.maxPages,
    });

    if (options.shouldStop?.()) break;
    visited.add(page.finalUrl);
    url = findNextPageUrl($, page.finalUrl, visited);
  }

  return pageNumber;
}

/**
 * Detect the URL of the next listing page from common pagination patterns:
 * `<link rel=next>`, `rel=next` anchors, pagination nav links, and `?page=N+1`.
 * Returns null when no safe next page is found (single-page listing).
 */
export function findNextPageUrl(
  $: CheerioAPI,
  finalUrl: string,
  visited: Set<string>,
): string | null {
  const base = new URL(finalUrl);
  const currentPage = Number(base.searchParams.get("page") ?? "1") || 1;
  const candidates: string[] = [];
  const fallbackCandidates: string[] = [];

  const relNext = $('link[rel="next"]').attr("href") ?? $('a[rel="next"]').attr("href");
  if (relNext) candidates.push(relNext);

  $('a[aria-label*="next" i], a.next, a[class*="next" i]').each(
    (_, el) => {
      const href = $(el).attr("href");
      if (href) candidates.push(href);
    },
  );

  $('nav[aria-label*="pag" i] a[href], ul[class*="pag" i] a[href], div[class*="pag" i] a[href], nav[class*="pag" i] a[href]').each(
    (_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (looksLikeNextControl($, el)) candidates.push(href);
      else fallbackCandidates.push(href);
    },
  );

  const sameHost = (u: URL) => u.hostname.toLowerCase() === base.hostname.toLowerCase();
  const samePath = (u: URL) => normalizePathname(u.pathname) === normalizePathname(base.pathname);

  // Prefer a candidate that explicitly points at page = current + 1.
  for (const raw of [...candidates, ...fallbackCandidates]) {
    const abs = toAbsolute(raw, base);
    if (!abs || visited.has(abs)) continue;
    const u = new URL(abs);
    if (!sameHost(u)) continue;
    const pageParam = Number(u.searchParams.get("page") ?? "");
    if (pageParam === currentPage + 1) return abs;
  }

  // Otherwise take the first explicit "next" control that stays on the same
  // listing path. Do NOT fall back to arbitrary same-host links from a broad
  // "pagination-ish" container; some themes wrap the whole mobile/site nav in
  // such a container, and that sends the crawler to "/" or "/search".
  for (const raw of candidates) {
    const abs = toAbsolute(raw, base);
    if (!abs || visited.has(abs)) continue;
    const u = new URL(abs);
    if (!sameHost(u)) continue;
    if (u.pathname === base.pathname && u.search === base.search) continue;
    if (!samePath(u)) continue;
    return abs;
  }

  return null;
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function looksLikeNextControl($: CheerioAPI, el: unknown): boolean {
  const node = $(el as Parameters<CheerioAPI>[0]);
  const text = node.text().trim().replace(/\s+/g, " ").toLowerCase();
  const aria = (node.attr("aria-label") ?? "").trim().toLowerCase();
  const rel = (node.attr("rel") ?? "").trim().toLowerCase();
  const className = (node.attr("class") ?? "").trim().toLowerCase();
  return /\b(next|suivant|volgende|weiter|older|more)\b/.test(`${text} ${aria} ${rel} ${className}`);
}

function toAbsolute(raw: string, base: URL): string | null {
  const value = raw.trim();
  if (!value || value.startsWith("#") || value.startsWith("mailto:") || value.startsWith("tel:")) {
    return null;
  }
  try {
    const u = new URL(value, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
