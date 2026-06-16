import { load, type Cheerio, type CheerioAPI } from "cheerio";
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
import { assertDomainAllowed, safeCollectionRedirectTarget, validateAndNormalizeUrl } from "../utils/url.js";
import { withBrowserSession } from "./pageLoader.js";
import { buildRealisticHeaders, fetchDirect, isBlockedResponse, isProxyConfigured, isProxyRotating, proxyFetch } from "./antiBlock.js";
import { crawlPages, resolveMaxPages } from "./pagination.js";
import { enrichListingItemsWithSeo } from "./listingSeoEnrichment.js";
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
  /** Owning user (from the authenticated key/session). null for operator/env-key runs. */
  userId: string | null;
  sourceStrategy: ListingSourceStrategy;
  maxProducts: number;
  maxPages?: number;
  progress?: ProgressReporter;
  /**
   * Fetch each best-seller's product page to capture the REAL page SEO title
   * (and the rest of the SEO set, which is free once the page is fetched). Off
   * by default: it's one extra proxy request per product, so it's opt-in.
   */
  enrichSeo?: boolean;
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

  // Replace each item's grid-derived `titleSeo` with the REAL product-page SEO
  // title before the snapshot is persisted, so it's stored and returned in the
  // existing `title` + `titleSeo` shape. Opt-in: one fetch per product.
  if (input.enrichSeo) {
    const seo = await enrichListingItemsWithSeo(extraction.items, progress);
    extraction.rawMetadata = { ...extraction.rawMetadata, seoEnriched: seo.enriched, seoFailed: seo.failed };
    if (seo.failed > 0) {
      extraction.warnings.push(`Could not read the SEO title for ${seo.failed} of ${extraction.items.length} products.`);
    }
  }

  const trackedListingId = await upsertTrackedListing({
    userId: input.userId,
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
  // Ranking source: capped at maxProducts (order matters). Enrichment index:
  // full feed (bounded by maxPages) so every best-selling handle can be matched.
  const shopifyJson = () => extractShopifyListingItems(url, maxProducts, maxPages, progress, warnings);
  const shopifyIndex = () =>
    extractShopifyListingItems(url, maxProducts, maxPages, progress, warnings, SHOPIFY_ENRICHMENT_INDEX_CAP);

  // Some stores IP-cloak: a "bad" exit IP is redirected away from the collection
  // (e.g. laurence-boutique.fr → /search), so the browser renders zero products
  // even though the store isn't empty. With a ROTATING residential pool, each
  // attempt gets a fresh exit, so retrying recovers the real grid. Only retry
  // when rotating (a static/no proxy would just hit the same blocked IP again).
  const browserHtmlWithRetry = async (): Promise<ListingRankItem[]> => {
    let items = await browserHtml();
    if (items.length > 0 || !isProxyRotating()) return items;
    for (let attempt = 1; attempt <= LISTING_BROWSER_RETRY_ATTEMPTS && items.length === 0; attempt++) {
      items = await browserHtml(); // fresh exit IP on the rotating gateway
    }
    return items;
  };

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
      items = await browserHtmlWithRetry();
      tier = "browser-html";
    }
    return { sourceUsed: "html", items, warnings, rawMetadata: { htmlCount: items.length, tier, orderReliable: true } };
  }

  // auto + both: best-selling ORDER from HTML (fetch first, browser fallback),
  // TITLE/IMAGE/productId enriched from products.json (merged by handle). The
  // HTML fetch preserves the exact ?sort_by=best-selling URL (no JS), so the
  // order is reliable; json only fills display fields.
  let htmlItems = await fetchHtml();
  if (htmlItems.length === 0) htmlItems = await browserHtmlWithRetry();
  // Full products.json index (not maxProducts-capped) so enrichment reaches
  // best-sellers that sit on later default-order pages of large catalogs.
  const shopifyItems = await shopifyIndex();
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
    const result = await fetchCollectionPageHtml(pageUrl, url.origin);
    if (!result.ok) {
      if (page === 1) warnings.push(result.warning);
      break;
    }

    const $ = load(result.html);
    const before = byKey.size;
    // Resolve product links against the URL we actually landed on (a safe
    // localized/`www.` redirect of the requested collection), so relative
    // `/products/…` hrefs match the page's own host.
    collectProductLinks($, result.finalUrl, byKey, maxProducts);
    if (byKey.size === before) break; // no new products → end of pagination

    progress?.({
      phase: "scanning-pages",
      message: `Best-sellers (fetched HTML${result.viaDirect ? ", direct retry" : ""}) — page ${page} · ${byKey.size} products`,
      current: page,
      total: maxPages,
    });
  }

  return [...byKey.values()].map((item, index) => ({ ...item, rank: index + 1 }));
}

type CollectionPageFetch =
  | { ok: true; html: string; viaDirect: boolean; finalUrl: string }
  | { ok: false; warning: string };

/** Max redirect hops to follow before giving up (guards against loops). */
const MAX_SAFE_REDIRECTS = 4;
/**
 * Upper bound on how many products.json entries to pull when building the
 * enrichment index (title/image/productId by handle) for the merge path. Unlike
 * the ranking cap (maxProducts), the index must cover EVERY best-selling handle
 * — which, on large stores, sit on later products.json pages in default order —
 * so it's intentionally generous. Still bounded by maxPages, and the feed ends
 * early when a page returns < 250.
 */
const SHOPIFY_ENRICHMENT_INDEX_CAP = 2000;
/**
 * Extra browser retries after the first empty render when we're on a rotating
 * proxy pool. Each retry gets a fresh exit IP, which can recover a cloaked
 * collection without affecting static-proxy or direct traffic.
 */
const LISTING_BROWSER_RETRY_ATTEMPTS =
  Number(process.env.LISTING_BROWSER_RETRY_ATTEMPTS) > 0 ? Number(process.env.LISTING_BROWSER_RETRY_ATTEMPTS) : 5;

/**
 * Fetch one collection page, retrying DIRECT (bypassing the proxy) when the
 * proxied attempt is blocked by bot protection.
 *
 * Why this matters for best-selling order: the plain-fetch HTML is the ONLY tier
 * that honors `?sort_by=best-selling` (products.json is unsorted). A shared /
 * datacenter proxy exit IP is challenged by Cloudflare far more readily than the
 * store's own origin IP, and a blocked HTML fetch silently demotes ranking to
 * products.json's default order — so a best-selling listing comes back looking
 * identical to the default order (observed on avelinethelabel.com: the proxy got
 * a challenge, so "Men's Classic Jumper" — products.json #1 — outranked the real
 * best-seller). Retrying direct recovers the real, correctly-sorted grid. We only
 * retry on a BLOCK (not a redirect/HTTP error) and only when a proxy is actually
 * in play, so the no-proxy and happy paths are unchanged.
 *
 * `redirect: "manual"` makes a 3xx come back as an inspectable response so we can
 * decide whether to follow it: a redirect to the SAME collection (localized
 * `/en-us/…` or `www.`-canonicalized) IS followed — with the requested
 * `sort_by`/`page` re-applied — because the server-rendered grid there is still
 * the listing we asked for, in the order we asked for. A redirect that changes
 * the collection handle is NOT followed (it's a different listing).
 */
export async function fetchCollectionPageHtml(pageUrl: string, origin: string): Promise<CollectionPageFetch> {
  const init: RequestInit = { headers: buildRealisticHeaders(origin), redirect: "manual" };

  type Attempt =
    | { ok: true; html: string; finalUrl: string }
    | { ok: false; blocked: boolean; warning: string };

  const attempt = async (fetcher: typeof proxyFetch): Promise<Attempt> => {
    let currentUrl = pageUrl;
    for (let hop = 0; hop < MAX_SAFE_REDIRECTS; hop++) {
      try {
        const response = await fetcher(currentUrl, init);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          const safeTarget = location ? safeCollectionRedirectTarget(currentUrl, location) : null;
          if (safeTarget) {
            currentUrl = safeTarget;
            continue;
          }
          return {
            ok: false,
            blocked: false,
            warning:
              `Fetched HTML returned a redirect (HTTP ${response.status} → ${location ?? "unknown"}); ` +
              "it points at a different collection, so it was not followed.",
          };
        }
        if (!response.ok) {
          const blocked = isBlockedResponse(response.status, "", response.headers.get("server"));
          return {
            ok: false,
            blocked,
            warning: blocked
              ? `Fetched HTML blocked by bot protection (HTTP ${response.status}).`
              : `Fetched HTML returned HTTP ${response.status}.`,
          };
        }
        const html = await response.text();
        if (isBlockedResponse(response.status, html, response.headers.get("server"))) {
          return { ok: false, blocked: true, warning: "Fetched HTML returned a Cloudflare challenge; escalating." };
        }
        return { ok: true, html, finalUrl: currentUrl };
      } catch (err) {
        return { ok: false, blocked: false, warning: `Fetched HTML extraction failed: ${(err as Error).message}` };
      }
    }
    return { ok: false, blocked: false, warning: "Fetched HTML exceeded the redirect limit." };
  };

  const proxied = await attempt(proxyFetch);
  if (proxied.ok) return { ok: true, html: proxied.html, viaDirect: false, finalUrl: proxied.finalUrl };

  // Only a BLOCK is worth retrying direct, and only when the first attempt
  // actually used a proxy IP (otherwise a direct retry just hits the same wall).
  if (proxied.blocked && isProxyConfigured()) {
    const direct = await attempt(fetchDirect);
    if (direct.ok) return { ok: true, html: direct.html, viaDirect: true, finalUrl: direct.finalUrl };
  }
  return { ok: false, warning: proxied.warning };
}

/**
 * Containers whose product links are NOT part of the collection's ranked grid:
 * site chrome (header/nav/footer/menus/cart drawer) and cross-sell/upsell blocks
 * (add-on products, recommendations, "related", "you may also like"). These link
 * to the same products regardless of the collection's sort order, and many appear
 * BEFORE the grid in the DOM — so counting them buries the real best-selling grid
 * under fixed menu/upsell items, making a ?sort_by=best-selling listing look
 * identical to the default order. (Observed on themes with an "add-on-products"
 * upsell block rendered above the grid.)
 */
const NON_GRID_LINK_CONTAINER = [
  "header",
  "nav",
  "footer",
  '[class*="mega-menu" i]',
  '[class*="menu-drawer" i]',
  '[class*="site-nav" i]',
  // Exclude cart/menu/search/account drawers, but NOT a collection's own layout
  // container that merely has "drawer" in its name. Several themes wrap the whole
  // product grid in e.g. `collection collection--filters-drawer` (sendowear.com),
  // and a bare `[class*="drawer"]` wrongly dropped the entire grid — leaving zero
  // products, so the tracker silently fell back to products.json's default
  // (alphabetical) order and recorded wrong "best-selling" ranks.
  '[class*="drawer" i]:not([class*="filter" i]):not([class*="collection" i]):not([class*="product" i])',
  '[class*="mini-cart" i]',
  '[class*="cart-drawer" i]',
  '[class*="add-on" i]',
  '[class*="addon" i]',
  '[class*="upsell" i]',
  '[class*="cross-sell" i]',
  '[class*="recommend" i]',
  '[class*="related-product" i]',
  '[class*="also-like" i]',
  '[class*="you-may" i]',
  '[class*="frequently-bought" i]',
  '[class*="predictive" i]',
  '[class*="complementary" i]',
].join(", ");

/**
 * Markers that positively identify the collection's product-grid container across
 * common Shopify themes. Scoping to the grid (rather than the whole page) keeps
 * menu / upsell / recommendation links — identical across sort orders — out of the
 * ranking, so ?sort_by=best-selling reflects the real on-page grid order.
 * hausofmode.de matches via data-section-type="collection-grid"; Dawn via
 * #product-grid / [class*="product-grid"].
 */
const GRID_CONTAINER = [
  '[data-section-type*="collection-grid" i]',
  '[data-section-type*="collection-template" i]',
  '[data-section-type*="main-collection" i]',
  "#product-grid",
  "#ProductGridContainer",
  "#CollectionProductGrid",
  "#CollectionAjaxContent",
  '[class*="product-grid" i]',
  '[class*="collection-grid" i]',
  '[class*="products-grid" i]',
  '[class*="collection-products" i]',
].join(", ");

/**
 * The ordered product anchors to rank for a listing page, most-reliable signal
 * first:
 *   1. the product-grid container with the most distinct product links (the real
 *      grid; chrome/upsell blocks match no grid marker, so they're excluded
 *      structurally — and any nested recommend block is still dropped by the
 *      NON_GRID filter);
 *   2. otherwise every anchor minus NON_GRID_LINK_CONTAINER (chrome/upsell);
 *   3. otherwise every anchor (only if the filter removed everything).
 */
function selectListingAnchors($: CheerioAPI): Cheerio<Element> {
  const dropChrome = (els: Cheerio<Element>) =>
    els.filter((_, el) => $(el).closest(NON_GRID_LINK_CONTAINER).length === 0);

  const countHandles = (anchors: Cheerio<Element>): number => {
    const handles = new Set<string>();
    anchors.each((_, el) => {
      const match = ($(el).attr("href") ?? "").match(/\/products\/([^/?#]+)/i);
      if (match?.[1]) handles.add(match[1].toLowerCase());
    });
    return handles.size;
  };

  type GridMatch = { anchors: Cheerio<Element>; count: number };
  let best: GridMatch | null = null;
  for (const container of $(GRID_CONTAINER).toArray()) {
    const anchors = dropChrome($(container).find("a[href]"));
    const count = countHandles(anchors);
    if (count >= 2 && (!best || count > best.count)) best = { anchors, count };
  }
  if (best) return best.anchors;

  const filtered = dropChrome($("a[href]"));
  return filtered.length > 0 ? filtered : $("a[href]");
}

/** Walk product anchors in DOM order, appending newly-seen products to `byKey`. */
function collectProductLinks(
  $: CheerioAPI,
  finalUrl: string,
  byKey: Map<string, ListingRankItem>,
  maxProducts: number,
): void {
  // Rank only the real product grid (see selectListingAnchors) so the order
  // reflects the requested sort_by, not menu/cart/upsell links that are identical
  // across every sort order.
  const siteName = detectSiteName($);
  const anchors = selectListingAnchors($);
  const before = byKey.size;
  anchors.each((_, el) => {
    if (byKey.size >= maxProducts) return;
    const href = $(el).attr("href");
    if (!href) return;
    const productUrl = normalizeProductUrl(href, finalUrl);
    if (!productUrl) return;
    const product = productIdentity(productUrl);
    if (isJunkProductHandle(product.handle)) return; // cart add-ons / gift cards aren't ranked
    // titleSeo = the raw storefront title (with any store-name suffix); title =
    // the same title with the suffix stripped (the clean product name).
    const titleSeo = findProductTitle($, el);
    const title = stripSiteSuffix(titleSeo, siteName);
    const imageUrl = findNearestImageUrl($, el, finalUrl);
    const existing = byKey.get(product.productKey);
    if (existing) {
      // Some Shopify themes render one image anchor and one title anchor for the
      // same product. Keep the first rank, but let later duplicate anchors fill
      // in better display fields.
      if (!existing.title && title) existing.title = title;
      if (!existing.titleSeo && titleSeo) existing.titleSeo = titleSeo;
      if (!existing.imageUrl && imageUrl) existing.imageUrl = imageUrl;
      return;
    }
    byKey.set(product.productKey, {
      rank: byKey.size + 1,
      productKey: product.productKey,
      url: productUrl,
      ...(product.handle ? { handle: product.handle } : {}),
      ...(title ? { title } : {}),
      ...(titleSeo ? { titleSeo } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      source: "html",
    });
  });

  if (byKey.size === before) {
    collectShopifyCollectionViewProducts($, finalUrl, byKey, maxProducts);
  }
}

interface ShopifyPixelVariant {
  id?: unknown;
  image?: { src?: unknown } | null;
  product?: {
    id?: unknown;
    title?: unknown;
    url?: unknown;
  } | null;
}

function collectShopifyCollectionViewProducts(
  $: CheerioAPI,
  finalUrl: string,
  byKey: Map<string, ListingRankItem>,
  maxProducts: number,
): void {
  const scripts = $('script[data-page-type="collection"][data-events], script[data-events*="collection_viewed"]');
  scripts.each((_, el) => {
    if (byKey.size >= maxProducts) return;
    const raw = decodeHtmlEntities($(el).attr("data-events"));
    if (!raw) return;
    const variants = parseCollectionViewVariants(raw);
    for (const variant of variants) {
      if (byKey.size >= maxProducts) break;
      const rawProductUrl = asString(variant.product?.url);
      const productUrl = rawProductUrl ? normalizeProductUrl(rawProductUrl, finalUrl) : null;
      if (!productUrl) continue;
      const product = productIdentity(productUrl);
      if (isJunkProductHandle(product.handle)) continue;
      if (byKey.has(product.productKey)) continue;
      const productId = asString(variant.product?.id);
      const title = asString(variant.product?.title);
      const imageUrl = normalizeImageUrl(asString(variant.image?.src), finalUrl);
      byKey.set(product.productKey, {
        rank: byKey.size + 1,
        // Identity is always the stable handle key (productIdentity). The Shopify
        // productId is kept as an attribute only — never promoted into the key —
        // so a product never changes identity between runs based on whether its id
        // happened to be discoverable. See mergeListingItems.
        productKey: product.productKey,
        url: productUrl,
        ...(product.handle ? { handle: product.handle } : {}),
        ...(title ? { title } : {}),
        // The pixel exposes only the product title — no distinct SEO form — so
        // mirror it into titleSeo to keep the field populated for the toggle.
        ...(title ? { titleSeo: title } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(productId ? { productId } : {}),
        source: "html",
      });
    }
  });
}

function parseCollectionViewVariants(raw: string): ShopifyPixelVariant[] {
  try {
    const events = JSON.parse(raw) as unknown;
    if (!Array.isArray(events)) return [];
    for (const event of events) {
      if (!Array.isArray(event) || event.length < 2 || event[0] !== "collection_viewed") continue;
      const payload = event[1];
      const variants = payload && typeof payload === "object" ? (payload as { collection?: { productVariants?: unknown } }).collection?.productVariants : null;
      if (Array.isArray(variants)) return variants as ShopifyPixelVariant[];
    }
  } catch {}
  return [];
}

function decodeHtmlEntities(value: string | undefined): string | undefined {
  if (!value) return value;
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeImageUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    if (value.startsWith("//")) return new URL(`https:${value}`).toString();
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
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
  // How many entries to collect. Defaults to the ranking cap (maxProducts) for
  // the standalone shopify_json source; the merge path passes a large cap so the
  // enrichment index covers best-sellers that live on later default-order pages.
  itemCap: number = maxProducts,
): Promise<ListingRankItem[]> {
  const collectionPath = getShopifyCollectionPath(url);
  if (!collectionPath) return [];

  const items: ListingRankItem[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= maxPages && items.length < itemCap; page++) {
    const endpoint = `${url.origin}${collectionPath}/products.json?limit=250&page=${page}`;
    let products: unknown;
    let redirected = false;
    try {
      // Follow only SAFE redirects (a localized `/en-us/…` or `www.`-canonical
      // copy of the SAME collection), re-applying ?page. A redirect that changes
      // the collection handle (a renamed/merged collection) is NOT followed —
      // that would silently return a different listing's products.
      let currentUrl = endpoint;
      let response: Response | null = null;
      for (let hop = 0; hop < MAX_SAFE_REDIRECTS; hop++) {
        response = await proxyFetch(currentUrl, {
          headers: {
            ...buildRealisticHeaders(url.origin),
            // products.json is an XHR-style request, not a top-level navigation.
            accept: "application/json,text/plain,*/*;q=0.8",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
          },
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          const safeTarget = location ? safeCollectionRedirectTarget(currentUrl, location) : null;
          if (safeTarget) {
            currentUrl = safeTarget;
            continue;
          }
          warnings.push(
            `Shopify products JSON redirected (HTTP ${response.status} → ${location ?? "unknown"}); ` +
              "it points at a different collection, so the redirect was not followed.",
          );
          redirected = true;
        }
        break;
      }
      if (redirected || !response) break;
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
      if (items.length >= itemCap || !product || typeof product !== "object") break;
      const obj = product as ShopifyProductJson;
      const handle = asString(obj.handle);
      if (!handle) continue;
      if (isJunkProductHandle(handle)) continue; // cart add-ons / gift cards aren't ranked
      const productUrl = new URL(`/products/${handle}`, url.origin).toString();
      const productId = asString(obj.id);
      // Stable identity = handle key; productId is carried as an attribute only
      // (kept consistent with the HTML and merge paths to avoid identity churn).
      const productKey = `handle:${handle.toLowerCase()}`;
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
        // products.json has no SEO title; mirror the product title so the toggle
        // field stays populated even on the products.json-only fallback path.
        ...(title ? { titleSeo: title } : {}),
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
      // Keep the stable handle key. Enrichment only fills display/attribute fields
      // (title/image/productId); it never changes identity, so a product can't flip
      // between `handle:` and `shopify:` keys when products.json is flaky/blocked.
      productKey: item.productKey,
      // Prefer products.json's canonical product title over the HTML-scraped one:
      // the JSON `title` is the authoritative product name, while themes often
      // expose an SEO-flavored `img alt` like "H.D Balboa Shorts - Handsome Dans"
      // (store-name suffix). HTML title is kept only when there's no JSON match.
      title: enrichment?.title ?? item.title,
      // titleSeo keeps the storefront/SEO-flavored grid title (the toggle target).
      // Fall back to the canonical title so the field is never empty when a title
      // exists — e.g. products.json-only items that had no HTML grid title.
      titleSeo: item.titleSeo ?? enrichment?.title ?? item.title,
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
  // Collapse a collection-scoped link (`/collections/all/products/<handle>`, which
  // some themes render in the grid) down to the canonical `/products/<handle>`.
  // A leading Shopify locale segment (`/en-us`, `/fr-fr`, …) is preserved so the
  // URL still points at the localized storefront the shopper actually sees.
  const handleMatch = url.pathname.match(/\/products\/([^/?#]+)/i);
  if (!handleMatch?.[1]) return null;
  const handle = handleMatch[1].replace(/\/+$/, "");
  const localePrefix = getLocalePrefix(url.pathname);
  url.pathname = `${localePrefix}/products/${handle}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * A leading Shopify locale path segment — a 2-letter language optionally followed
 * by a 2-letter country (`/en`, `/fr-fr`, `/nl-nl`). Returns "" when the path has
 * no locale prefix. `/collections` and `/products` can never match (too long), so
 * a real first segment is never mistaken for a locale.
 */
function getLocalePrefix(pathname: string): string {
  const match = pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?=\/)/i);
  return match?.[1] ? `/${match[1].toLowerCase()}` : "";
}

function productIdentity(productUrl: string): { productKey: string; handle?: string } {
  const url = new URL(productUrl);
  const match = url.pathname.match(/\/products\/([^/?#]+)/i);
  // Decode the handle so a percent-encoded URL segment (e.g. "akrisna%E2%84%A2-…")
  // becomes the same readable form products.json reports ("akrisna™-…"). This keeps
  // the `handle` field clean AND lets enrichment match by handle (the encoded vs
  // decoded mismatch otherwise silently skipped these products). The `url` field
  // stays percent-encoded — only the identity/display handle is decoded.
  const handle = match?.[1] ? decodeHandle(match[1]).toLowerCase() : undefined;
  return handle ? { productKey: `handle:${handle}`, handle } : { productKey: productUrl };
}

/** decodeURIComponent, but never throws on a malformed `%` sequence. */
function decodeHandle(rawHandle: string): string {
  try {
    return decodeURIComponent(rawHandle);
  } catch {
    return rawHandle;
  }
}

/**
 * Storefront "products" that are NOT real catalog items: cart add-ons injected by
 * apps (shipping/package protection, order insurance, tips, donations) and gift
 * cards. Several themes render these inside the collection grid, where they can
 * outrank real products (e.g. jackhafford's "Shipping Protection" landed at rank
 * #1). They link to a /products/ handle like a normal product, so they slip past
 * the grid filter — exclude them by handle so best-selling ranks stay clean.
 */
const JUNK_PRODUCT_HANDLE_RE =
  /(^|[-_])(?:(?:shipping|package|order|delivery)[-_]?(?:protection|insurance|guarantee)|route[-_]?insurance|seel[-_]?protection|worry[-_]?free|e?[-_]?gift[-_]?card|tip|tipping|donation|round[-_]?up)s?([-_]|$)/i;

function isJunkProductHandle(handle: string | undefined): boolean {
  return handle ? JUNK_PRODUCT_HANDLE_RE.test(handle.toLowerCase()) : false;
}

/**
 * The store's display name, used to strip a trailing "<product> - <store>"
 * suffix that themes bake into image `alt` text / SEO titles. Prefer the
 * explicit og:site_name; otherwise fall back to the trailing segment of the
 * document <title> (e.g. "Best sellers – Handsome Dans" → "Handsome Dans").
 */
function detectSiteName($: CheerioAPI): string | undefined {
  const og = cleanText($('meta[property="og:site_name"]').attr("content"));
  if (og) return og;
  const docTitle = cleanText($("title").first().text());
  const trailing = docTitle?.match(/[|\-–—]\s*([^|\-–—]{2,40})\s*$/);
  return trailing?.[1]?.trim();
}

/**
 * Remove a trailing " - {store}" / " | {store}" / " – {store}" suffix from a
 * scraped title (handsomedans' `img alt` is "H.D Balboa Shorts - Handsome
 * Dans"). Only strips when the suffix matches the detected store name, so real
 * product names containing a dash (e.g. "Tee - Black") are left intact. If
 * stripping would empty the title, the original is kept.
 */
function stripSiteSuffix(title: string | undefined, siteName: string | undefined): string | undefined {
  if (!title || !siteName) return title;
  const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = title.replace(new RegExp(`\\s*[|\\-–—]\\s*${escaped}\\s*$`, "i"), "").trim();
  return stripped.length > 0 ? stripped : title;
}

/**
 * Best-effort product title for a listing anchor. Many themes use image-only
 * product links (no anchor text), so fall back through aria-label / title attr /
 * nested img alt / the nearest card heading. (products.json enrichment fills the
 * rest by handle, but this keeps html-only items from having a null title.)
 */
function findProductTitle($: CheerioAPI, el: Element): string | undefined {
  const link = $(el);
  const imageAlt = cleanText(link.find("img").first().attr("alt"));
  const card = findProductCard($, el);
  const cardDataTitle = cleanText(card.find("[data-product-title]").first().attr("data-product-title"));
  const heading = card
    .find("h2, h3, h4, [class*=title], [class*=name], [class*=Title], [class*=Name]")
    .first();
  const headingText = cleanText(heading.text());
  const fromLink =
    cleanText(link.attr("data-product-title")) ??
    cleanText(link.attr("aria-label")) ??
    cleanText(link.attr("title")) ??
    imageAlt ??
    cardDataTitle ??
    headingText ??
    cleanText(link.text());
  return fromLink;
}

function findNearestImageUrl($: CheerioAPI, el: Element, finalUrl: string): string | null {
  const link = $(el);
  const candidates = [link.find("img").first(), findProductCard($, el).find("img").first()];
  for (const candidate of candidates) {
    const raw =
      candidate.attr("src") ??
      candidate.attr("data-src") ??
      candidate.attr("data-original") ??
      firstSrcsetUrl(candidate.attr("srcset")) ??
      firstSrcsetUrl(candidate.attr("data-srcset"));
    const normalized = raw ? normalizeMediaUrl(raw, finalUrl) : null;
    if (normalized) return normalized;
  }
  return null;
}

function findProductCard($: CheerioAPI, el: Element): Cheerio<Element> {
  const link = $(el) as Cheerio<Element>;
  const card = link.closest(
    [
      "li",
      "article",
      '[class*="product-card" i]',
      '[class*="product-item" i]',
      '[class*="grid-item" i]',
      '[class*="card-product" i]',
      '[class*="card" i]',
    ].join(", "),
  ) as Cheerio<Element>;
  return card.length > 0 ? card : link;
}

function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  return srcset
    ?.split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .find((candidate) => Boolean(candidate));
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
