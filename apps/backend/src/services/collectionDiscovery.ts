import type { CheerioAPI } from "cheerio";
import { findJsonLdByType } from "./metadataExtractor.js";
import type { ExtractedMetadata } from "./metadataExtractor.js";

export interface CollectionDiscoveryResult {
  isCollection: boolean;
  productUrls: string[];
}

const COLLECTION_PATH_PATTERNS = [
  /\/collections(?:\/|$)/i,
  /\/category(?:\/|$)/i,
  /\/categories(?:\/|$)/i,
  /\/shop(?:\/|$)/i,
];

export function discoverCollectionProducts(
  meta: ExtractedMetadata,
  finalUrl: string,
  maxProducts: number,
): CollectionDiscoveryResult {
  const productUrls = extractProductUrls(meta.$, finalUrl, maxProducts);
  const isCollection = isLikelyCollection(meta, finalUrl, productUrls.length);
  return { isCollection, productUrls };
}

/** Extract all normalized product URLs from one rendered page (no cap). */
export function extractProductUrlsFromPage($: CheerioAPI, finalUrl: string): string[] {
  return extractProductUrls($, finalUrl, Number.POSITIVE_INFINITY);
}

function isLikelyCollection(
  meta: ExtractedMetadata,
  finalUrl: string,
  productUrlCount: number,
): boolean {
  const url = new URL(finalUrl);
  const pathLooksLikeCollection = COLLECTION_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname));
  const hasProductSchema = findJsonLdByType(meta.jsonLd, "Product") !== null;
  if (hasProductSchema && /\/products\//i.test(url.pathname)) return false;
  if (hasProductSchema && !pathLooksLikeCollection) return false;
  if (pathLooksLikeCollection) return true;
  if (productUrlCount > 1) return true;
  return productUrlCount >= 4;
}

function extractProductUrls(
  $: CheerioAPI,
  finalUrl: string,
  maxProducts: number,
): string[] {
  const byUrl = new Map<string, string>();
  const base = new URL(finalUrl);

  $("a[href]").each((_, el) => {
    if (byUrl.size >= maxProducts) return;
    const rawHref = $(el).attr("href");
    if (!rawHref) return;
    const normalized = normalizeProductUrl(rawHref, base);
    if (!normalized) return;
    if (!byUrl.has(normalized)) byUrl.set(normalized, normalized);
  });

  return [...byUrl.values()];
}

function normalizeProductUrl(rawHref: string, base: URL): string | null {
  const value = rawHref.trim();
  if (!value || value.startsWith("#") || value.startsWith("mailto:") || value.startsWith("tel:")) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null;
  if (!/\/products\/[^/?#]+/i.test(url.pathname)) return null;

  const match = url.pathname.match(/^(.*?\/products\/[^/?#]+)/i);
  if (!match?.[1]) return null;

  url.pathname = match[1].replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}
