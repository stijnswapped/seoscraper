import type { CheerioAPI } from "cheerio";
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
import { crawlPages, resolveMaxPages } from "./pagination.js";
import type { ProgressReporter } from "./progressHub.js";
import {
  createSnapshot,
  getLatestSnapshot,
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

async function extractListingItems(
  url: URL,
  strategy: ListingSourceStrategy,
  maxProducts: number,
  maxPages: number,
  progress?: ProgressReporter,
): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const htmlItems = strategy === "shopify_json" ? [] : await extractHtmlListingItems(url, maxProducts, maxPages, progress, warnings);
  const shopifyItems = strategy === "html" ? [] : await extractShopifyListingItems(url, maxProducts, maxPages, progress, warnings);

  if (strategy === "html") {
    return { sourceUsed: "html", items: htmlItems, warnings, rawMetadata: { htmlCount: htmlItems.length } };
  }

  if (strategy === "shopify_json") {
    return { sourceUsed: "shopify_json", items: shopifyItems, warnings, rawMetadata: { shopifyCount: shopifyItems.length } };
  }

  if (strategy === "both") {
    const merged = mergeListingItems(htmlItems, shopifyItems, maxProducts);
    return {
      sourceUsed: htmlItems.length > 0 && shopifyItems.length > 0 ? "both" : htmlItems.length > 0 ? "html" : "shopify_json",
      items: merged,
      warnings,
      rawMetadata: { htmlCount: htmlItems.length, shopifyCount: shopifyItems.length },
    };
  }

  if (htmlItems.length > 0) {
    return {
      sourceUsed: shopifyItems.length > 0 ? "both" : "html",
      items: mergeListingItems(htmlItems, shopifyItems, maxProducts),
      warnings,
      rawMetadata: { htmlCount: htmlItems.length, shopifyCount: shopifyItems.length },
    };
  }

  if (shopifyItems.length > 0) {
    warnings.push("Rendered HTML did not expose product links; used Shopify products JSON fallback.");
  }
  return {
    sourceUsed: "shopify_json",
    items: shopifyItems,
    warnings,
    rawMetadata: { htmlCount: htmlItems.length, shopifyCount: shopifyItems.length },
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
        ({ $, finalUrl }) => {
          $("a[href]").each((_, el) => {
            if (byKey.size >= maxProducts) return;
            const href = $(el).attr("href");
            if (!href) return;
            const productUrl = normalizeProductUrl(href, finalUrl);
            if (!productUrl) return;
            const product = productIdentity(productUrl);
            if (byKey.has(product.productKey)) return;
            const title = cleanText($(el).text()) ?? cleanText($(el).attr("aria-label"));
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
        },
      );
    });

    return [...byKey.values()].map((item, index) => ({ ...item, rank: index + 1 }));
  } catch (err) {
    warnings.push(`HTML listing extraction failed: ${(err as Error).message}`);
    return [];
  }
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
      const response = await fetch(endpoint, {
        headers: {
          accept: "application/json,text/plain,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": sitesConfig.browser.userAgent,
        },
        redirect: "follow",
      });
      if (!response.ok) {
        if (page === 1) warnings.push(`Shopify products JSON returned HTTP ${response.status}.`);
        break;
      }
      if (!sameOrigin(endpoint, response.url || endpoint)) {
        warnings.push("Shopify products JSON redirected to another origin and was ignored.");
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

function sameOrigin(left: string, right: string): boolean {
  const a = new URL(left);
  const b = new URL(right);
  return a.protocol === b.protocol && a.hostname.toLowerCase() === b.hostname.toLowerCase() && a.port === b.port;
}
