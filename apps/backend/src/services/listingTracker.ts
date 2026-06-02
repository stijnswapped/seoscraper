import { load, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { sitesConfig } from "../../../../config/sites.config.js";
import type {
  ListingRankChange,
  ListingRankItem,
  ListingRankSnapshot,
  ListingSourceStrategy,
  ListingSourceUsed,
} from "../types/productCheck.js";
import { CheckError } from "../types/productCheck.js";
import { assertDomainAllowed, validateAndNormalizeUrl } from "../utils/url.js";
import { withBrowserSession } from "./pageLoader.js";
import { buildRealisticHeaders, isBlockedResponse, proxyFetch } from "./antiBlock.js";
import { crawlPages, resolveMaxPages } from "./pagination.js";
import type { ProgressReporter } from "./progressHub.js";
import {
  createSnapshot,
  getLatestSnapshot,
  pruneSnapshots,
  upsertTrackedListing,
  type PreviousSnapshot,
} from "../db/listingRepository.js";

interface TrackListingInput {
  url: string;
  sourceStrategy: ListingSourceStrategy;
  maxProducts: number;
  maxPages?: number;
  progress?: ProgressReporter;
}

interface ExtractionResult {
  sourceUsed: ListingSourceUsed;
  items: ListingRankItem[];
  warnings: string[];
  rawMetadata: Record<string, unknown>;
}

interface ShopifyProductJson {
  id?: unknown;
  handle?: unknown;
  title?: unknown;
  url?: unknown;
  images?: unknown;
  featured_image?: unknown;
  image?: unknown;
}

const LISTING_SOURCE_STRATEGIES = new Set<ListingSourceStrategy>(["auto", "html", "shopify_json", "both"]);

export async function trackListing(input: TrackListingInput): Promise<ListingRankSnapshot> {
  const strategy = normalizeSourceStrategy(input.sourceStrategy);
  const maxProducts = normalizeMaxProducts(input.maxProducts);
  const maxPages = resolveMaxPages(input.maxPages);
  const progress = input.progress;
  const { url, hostname } = validateAndNormalizeUrl(input.url);
  assertDomainAllowed(hostname);

  const listingKey = createListingKey(url);
  const extraction = await extractListingItems(url, strategy, maxProducts, maxPages, progress);
  if (extraction.items.length === 0) {
    throw new CheckError("NO_PRODUCT_DATA_FOUND", "No product ranking items were found for this listing.");
  }

  const trackedListingId = await upsertTrackedListing({
    storeDomain: hostname,
    listingKey,
    listingUrl: url.toString(),
  });
  const previous = await getLatestSnapshot(trackedListingId);
  const snapshot = await createSnapshot({
    trackedListingId,
    sourceStrategy: strategy,
    sourceUsed: extraction.sourceUsed,
    items: extraction.items,
    rawMetadata: extraction.rawMetadata,
  });
  const changes = compareSnapshots(previous, snapshot.id, extraction.items);

  // Keep storage flat: retain only the baseline + this latest snapshot. The diff
  // above was already computed against the prior latest, so day-over-day change
  // detection is preserved while old snapshots are discarded.
  await pruneSnapshots(trackedListingId).catch(() => {});

  return {
    kind: "listing_rank_snapshot",
    snapshotId: snapshot.id,
    trackedListingId,
    listingKey,
    storeDomain: hostname,
    listingUrl: url.toString(),
    sourceStrategy: strategy,
    sourceUsed: extraction.sourceUsed,
    checkedAt: snapshot.checkedAt,
    items: extraction.items,
    changes,
    summary: summarizeChanges(extraction.items.length, changes),
    warnings: extraction.warnings,
  };
}

export function normalizeSourceStrategy(value: unknown): ListingSourceStrategy {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  if (LISTING_SOURCE_STRATEGIES.has(normalized as ListingSourceStrategy)) return normalized as ListingSourceStrategy;
  return "auto";
}

function normalizeMaxProducts(value: number): number {
  if (!Number.isFinite(value)) return sitesConfig.collections.maxProducts;
  return Math.max(1, Math.min(Math.floor(value), 250));
}

const ORDER_UNRELIABLE_WARNING =
  "Best-selling order could not be preserved: Shopify's products.json feed is unsorted. " +
  "Ranks reflect the store's default product order, not best-selling.";

/**
 * Resolve the ranking items for a listing, honoring the requested sort order as
 * far as possible. Tiers run lazily (stop at the first that yields products):
 *
 *   1. plain-fetch HTML  — cheap, no Chromium, honors sort_by on server-rendered grids
 *   2. browser HTML      — for JS-rendered themes the plain fetch can't read
 *   3. products.json     — last resort; CANNOT honor sort_by (feed is unsorted)
 *
 * Running tiers lazily also slashes how often we launch a browser, which is the
 * main driver of the container's memory crashes.
 */
export async function extractListingItems(
  url: URL,
  strategy: ListingSourceStrategy,
  maxProducts: number,
  maxPages: number,
  progress?: ProgressReporter,
): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const hasSortBy = url.searchParams.has("sort_by");

  const fetchHtml = () => extractFetchedHtmlListingItems(url, maxProducts, maxPages, progress, warnings);
  const browserHtml = () => extractHtmlListingItems(url, maxProducts, maxPages, progress, warnings);
  const shopifyJson = () => extractShopifyListingItems(url, maxProducts, maxPages, progress, warnings);

  if (strategy === "shopify_json") {
    const items = await shopifyJson();
    if (hasSortBy && items.length > 0) warnings.push(ORDER_UNRELIABLE_WARNING);
    return {
      sourceUsed: "shopify_json",
      items,
      warnings,
      rawMetadata: { shopifyCount: items.length, orderReliable: !hasSortBy },
    };
  }

  if (strategy === "html") {
    let items = await fetchHtml();
    let tier = "fetched-html";
    if (items.length === 0) {
      items = await browserHtml();
      tier = "browser-html";
    }
    return { sourceUsed: "html", items, warnings, rawMetadata: { htmlCount: items.length, tier, orderReliable: true } };
  }

  // auto + both: best-selling ORDER from HTML (fetch first, browser fallback),
  // TITLE/IMAGE/productId enriched from products.json (merged by handle). The
  // HTML fetch preserves the exact ?sort_by=best-selling URL (no JS), so the
  // order is reliable; json only fills display fields.
  let htmlItems = await fetchHtml();
  if (htmlItems.length === 0) htmlItems = await browserHtml();
  const shopifyItems = await shopifyJson();
  const orderReliable = htmlItems.length > 0 || !hasSortBy;
  if (hasSortBy && htmlItems.length === 0 && shopifyItems.length > 0) warnings.push(ORDER_UNRELIABLE_WARNING);
  return {
    sourceUsed: htmlItems.length > 0 && shopifyItems.length > 0 ? "both" : htmlItems.length > 0 ? "html" : "shopify_json",
    items: mergeListingItems(htmlItems, shopifyItems, maxProducts),
    warnings,
    rawMetadata: { htmlCount: htmlItems.length, shopifyCount: shopifyItems.length, orderReliable },
  };
}

async function extractHtmlListingItems(
  url: URL,
  maxProducts: number,
  maxPages: number,
  progress: ProgressReporter | undefined,
  warnings: string[],
): Promise<ListingRankItem[]> {
  try {
    const byKey = new Map<string, ListingRankItem>();

    await withBrowserSession(async (session) => {
      await crawlPages(
        session,
        url.toString(),
        {
          maxPages,
          progress,
          label: "Scanning best-sellers",
          shouldStop: () => byKey.size >= maxProducts,
        },
        ({ $, finalUrl }) => collectProductLinks($, finalUrl, byKey, maxProducts),
      );
    });

    return [...byKey.values()].map((item, index) => ({ ...item, rank: index + 1 }));
  } catch (err) {
    warnings.push(`HTML listing extraction failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Like {@link extractHtmlListingItems} but with a plain `fetch()` instead of a
 * headless browser. The server-rendered Shopify collection page already lists
 * products in the requested `sort_by` order (e.g. best-selling), so parsing the
 * HTML in DOM order preserves ranks — without launching Chromium (no crash risk)
 * and often slipping past bot checks that block headless browsers.
 */
async function extractFetchedHtmlListingItems(
  url: URL,
  maxProducts: number,
  maxPages: number,
  progress: ProgressReporter | undefined,
  warnings: string[],
): Promise<ListingRankItem[]> {
  const byKey = new Map<string, ListingRankItem>();

  for (let page = 1; page <= maxPages && byKey.size < maxProducts; page++) {
    const pageUrl = buildPaginatedUrl(url, page);
    let html: string;
    // Scrape exactly the URL that was requested — never the target of a redirect.
    // `redirect: "manual"` makes a 3xx come back as a response we can inspect
    // (instead of fetch silently following it to a canonical/other page), and we
    // keep finalUrl pinned to the requested URL so links resolve against it.
    const finalUrl = pageUrl;
    try {
      const response = await proxyFetch(pageUrl, {
        headers: buildRealisticHeaders(url.origin),
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        if (page === 1) {
          warnings.push(
            `Fetched HTML returned a redirect (HTTP ${response.status} → ${response.headers.get("location") ?? "unknown"}); ` +
              "scraping only the requested URL, so the redirect was not followed.",
          );
        }
        break;
      }
      if (!response.ok) {
        if (page === 1) {
          warnings.push(
            isBlockedResponse(response.status, "", response.headers.get("server"))
              ? `Fetched HTML blocked by bot protection (HTTP ${response.status}).`
              : `Fetched HTML returned HTTP ${response.status}.`,
          );
        }
        break;
      }
      html = await response.text();
      if (isBlockedResponse(response.status, html, response.headers.get("server"))) {
        if (page === 1) warnings.push("Fetched HTML returned a Cloudflare challenge; escalating.");
        break;
      }
    } catch (err) {
      if (page === 1) warnings.push(`Fetched HTML extraction failed: ${(err as Error).message}`);
      break;
    }

    const $ = load(html);
    const before = byKey.size;
    collectProductLinks($, finalUrl, byKey, maxProducts);
    if (byKey.size === before) break; // no new products → end of pagination

    progress?.({
      phase: "scanning-pages",
      message: `Best-sellers (fetched HTML) — page ${page} · ${byKey.size} products`,
      current: page,
      total: maxPages,
    });
  }

  return [...byKey.values()].map((item, index) => ({ ...item, rank: index + 1 }));
}

/** Walk product anchors in DOM order, appending newly-seen products to `byKey`. */
function collectProductLinks(
  $: CheerioAPI,
  finalUrl: string,
  byKey: Map<string, ListingRankItem>,
  maxProducts: number,
): void {
  $("a[href]").each((_, el) => {
    if (byKey.size >= maxProducts) return;
    const href = $(el).attr("href");
    if (!href) return;
    const productUrl = normalizeProductUrl(href, finalUrl);
    if (!productUrl) return;
    const product = productIdentity(productUrl);
    if (byKey.has(product.productKey)) return;
    const title = findProductTitle($, el);
    const imageUrl = findNearestImageUrl($, el, finalUrl);
    byKey.set(product.productKey, {
      rank: byKey.size + 1,
      productKey: product.productKey,
      url: productUrl,
      ...(product.handle ? { handle: product.handle } : {}),
      ...(title ? { title } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      source: "html",
    });
  });
}

/** Append/replace `?page=N` while preserving existing query params (e.g. sort_by). */
function buildPaginatedUrl(url: URL, page: number): string {
  const next = new URL(url.toString());
  if (page <= 1) next.searchParams.delete("page");
  else next.searchParams.set("page", String(page));
  return next.toString();
}

async function extractShopifyListingItems(
  url: URL,
  maxProducts: number,
  maxPages: number,
  progress: ProgressReporter | undefined,
  warnings: string[],
): Promise<ListingRankItem[]> {
  const collectionPath = getShopifyCollectionPath(url);
  if (!collectionPath) return [];

  const items: ListingRankItem[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= maxPages && items.length < maxProducts; page++) {
    const endpoint = `${url.origin}${collectionPath}/products.json?limit=250&page=${page}`;
    let products: unknown;
    try {
      const response = await proxyFetch(endpoint, {
        headers: {
          ...buildRealisticHeaders(url.origin),
          // products.json is an XHR-style request, not a top-level navigation.
          accept: "application/json,text/plain,*/*;q=0.8",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
        },
        // Don't follow redirects: a renamed/merged collection 301s
        // /collections/OLD/products.json → /collections/NEW/products.json on the
        // SAME origin, which would silently return a different listing's products.
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        warnings.push(
          `Shopify products JSON redirected (HTTP ${response.status} → ${response.headers.get("location") ?? "unknown"}); ` +
            "scraping only the requested collection, so the redirect was not followed.",
        );
        break;
      }
      if (!response.ok) {
        if (page === 1) warnings.push(`Shopify products JSON returned HTTP ${response.status}.`);
        break;
      }
      const data = (await response.json()) as unknown;
      products = data && typeof data === "object" ? (data as Record<string, unknown>)["products"] : null;
    } catch (err) {
      warnings.push(`Shopify listing extraction failed: ${(err as Error).message}`);
      break;
    }

    if (!Array.isArray(products) || products.length === 0) break;

    for (const product of products) {
      if (items.length >= maxProducts || !product || typeof product !== "object") break;
      const obj = product as ShopifyProductJson;
      const handle = asString(obj.handle);
      if (!handle) continue;
      const productUrl = new URL(`/products/${handle}`, url.origin).toString();
      const productId = asString(obj.id);
      const productKey = productId ? `shopify:${productId}` : `handle:${handle.toLowerCase()}`;
      if (seen.has(productKey)) continue;
      seen.add(productKey);
      const title = asString(obj.title);
      const imageUrl = firstShopifyImage(obj);
      items.push({
        rank: items.length + 1,
        productKey,
        url: productUrl,
        handle,
        ...(title ? { title } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(productId ? { productId } : {}),
        source: "shopify_json",
      });
    }

    progress?.({
      phase: "scanning-pages",
      message: `Best-sellers (Shopify) — page ${page} · ${items.length} products`,
      current: page,
      total: maxPages,
    });

    if (products.length < 250) break;
  }

  return items.map((item, index) => ({ ...item, rank: index + 1 }));
}

function mergeListingItems(htmlItems: ListingRankItem[], shopifyItems: ListingRankItem[], maxProducts: number): ListingRankItem[] {
  if (htmlItems.length === 0) return shopifyItems.slice(0, maxProducts);
  const shopifyByHandle = new Map(shopifyItems.filter((item) => item.handle).map((item) => [item.handle?.toLowerCase(), item]));
  return htmlItems.slice(0, maxProducts).map((item, index) => {
    const enrichment = item.handle ? shopifyByHandle.get(item.handle.toLowerCase()) : undefined;
    return {
      ...item,
      rank: index + 1,
      productKey: enrichment?.productId ? `shopify:${enrichment.productId}` : item.productKey,
      title: item.title ?? enrichment?.title,
      imageUrl: item.imageUrl ?? enrichment?.imageUrl,
      productId: enrichment?.productId ?? item.productId,
      source: enrichment ? "both" : item.source,
    };
  });
}

function compareSnapshots(
  previous: PreviousSnapshot | null,
  currentSnapshotId: string,
  currentItems: ListingRankItem[],
): ListingRankChange[] {
  const changes: ListingRankChange[] = [];
  const previousByKey = new Map(previous?.items.map((item) => [item.productKey, item]) ?? []);
  const currentByKey = new Map(currentItems.map((item) => [item.productKey, item]));

  for (const item of currentItems) {
    const before = previousByKey.get(item.productKey);
    const delta = before ? before.rank - item.rank : null;
    changes.push({
      productKey: item.productKey,
      url: item.url,
      ...(item.handle ? { handle: item.handle } : {}),
      ...(item.title ? { title: item.title } : {}),
      previousRank: before?.rank ?? null,
      currentRank: item.rank,
      delta,
      direction: before ? deltaDirection(delta ?? 0) : "new",
      previousSnapshotId: previous?.id ?? null,
      currentSnapshotId,
    });
  }

  if (previous) {
    for (const item of previous.items) {
      if (currentByKey.has(item.productKey)) continue;
      changes.push({
        productKey: item.productKey,
        url: item.url,
        ...(item.handle ? { handle: item.handle } : {}),
        ...(item.title ? { title: item.title } : {}),
        previousRank: item.rank,
        currentRank: null,
        delta: null,
        direction: "missing",
        previousSnapshotId: previous.id,
        currentSnapshotId,
      });
    }
  }

  return changes;
}

function summarizeChanges(tracked: number, changes: ListingRankChange[]): ListingRankSnapshot["summary"] {
  return {
    tracked,
    new: changes.filter((change) => change.direction === "new").length,
    movedUp: changes.filter((change) => change.direction === "up").length,
    movedDown: changes.filter((change) => change.direction === "down").length,
    unchanged: changes.filter((change) => change.direction === "same").length,
    missing: changes.filter((change) => change.direction === "missing").length,
  };
}

function deltaDirection(delta: number): ListingRankChange["direction"] {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "same";
}

function createListingKey(url: URL): string {
  const normalized = new URL(url.toString());
  const sortBy = normalized.searchParams.get("sort_by");
  normalized.search = "";
  normalized.hash = "";
  const path = normalized.pathname.replace(/\/+$/, "") || "/";
  return `${normalized.hostname.toLowerCase()}|${path}${sortBy ? `|sort_by=${sortBy}` : ""}`;
}

function getShopifyCollectionPath(url: URL): string | null {
  const match = url.pathname.match(/^(.*?\/collections\/[^/?#]+)/i);
  const collectionPath = match?.[1]?.replace(/\/+$/, "");
  return collectionPath ?? null;
}

function normalizeProductUrl(rawHref: string, baseUrl: string): string | null {
  const value = rawHref.trim();
  if (!value || value.startsWith("#") || value.startsWith("mailto:") || value.startsWith("tel:")) return null;

  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }

  const base = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null;
  const match = url.pathname.match(/^(.*?\/products\/[^/?#]+)/i);
  if (!match?.[1]) return null;
  url.pathname = match[1].replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function productIdentity(productUrl: string): { productKey: string; handle?: string } {
  const url = new URL(productUrl);
  const match = url.pathname.match(/\/products\/([^/?#]+)/i);
  const handle = match?.[1]?.toLowerCase();
  return handle ? { productKey: `handle:${handle}`, handle } : { productKey: productUrl };
}

/**
 * Best-effort product title for a listing anchor. Many themes use image-only
 * product links (no anchor text), so fall back through aria-label / title attr /
 * nested img alt / the nearest card heading. (products.json enrichment fills the
 * rest by handle, but this keeps html-only items from having a null title.)
 */
function findProductTitle($: CheerioAPI, el: Element): string | undefined {
  const link = $(el);
  const fromLink =
    cleanText(link.text()) ??
    cleanText(link.attr("aria-label")) ??
    cleanText(link.attr("title")) ??
    cleanText(link.find("img").first().attr("alt"));
  if (fromLink) return fromLink;

  const card = link.closest("li, article, div, section");
  const heading = card
    .find("h2, h3, h4, [class*=title], [class*=name], [class*=Title], [class*=Name]")
    .first();
  return cleanText(heading.text());
}

function findNearestImageUrl($: CheerioAPI, el: Element, finalUrl: string): string | null {
  const link = $(el);
  const candidates = [link.find("img").first(), link.closest("li, article, div, section").find("img").first()];
  for (const candidate of candidates) {
    const raw = candidate.attr("src") ?? candidate.attr("data-src") ?? candidate.attr("data-original");
    const normalized = raw ? normalizeMediaUrl(raw, finalUrl) : null;
    if (normalized) return normalized;
  }
  return null;
}

function normalizeMediaUrl(raw: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw.trim(), baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function firstShopifyImage(product: ShopifyProductJson): string | undefined {
  const image = imageValue(product.featured_image) ?? imageValue(product.image);
  if (image) return image;
  if (Array.isArray(product.images)) {
    for (const value of product.images) {
      const out = imageValue(value);
      if (out) return out;
    }
  }
  return undefined;
}

function imageValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return asString(obj["src"]) ?? asString(obj["url"]);
  }
  return undefined;
}

function cleanText(value: string | undefined | null): string | undefined {
  const clean = value?.replace(/\s+/g, " ").trim();
  return clean || undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
