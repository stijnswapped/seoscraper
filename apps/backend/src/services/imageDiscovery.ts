import type { CheerioAPI, Cheerio } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { DiscoveredImage } from "../types/productCheck.js";
import { normalizeImageUrl, parseSrcset } from "../utils/url.js";
import { findJsonLdByType } from "./metadataExtractor.js";
import type { ExtractedMetadata } from "./metadataExtractor.js";
import { sitesConfig } from "../../../../config/sites.config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("imageDiscovery");

// ---------------------------------------------------------------------------
// Exclusion patterns — URL fragments that indicate NON-product assets
// ---------------------------------------------------------------------------
const EXCLUDE_PATTERNS = [
  /\.svg($|\?)/i,
  /sprite/i,
  /logo/i,
  /\bicon\b/i,
  /favicon/i,
  /badge/i,
  /\bflag\b/i,
  /payment/i,
  /pixel/i,
  /tracking/i,
  /placeholder/i,
  /spinner/i,
  /loader/i,
  /1x1/i,
  // Common non-product patterns
  /avatar/i,
  /profile/i,
  /newsletter/i,
  /banner/i,
  /hero/i,
  /\/brand\//i,
  /\/brands\//i,
  /trust/i,
  /review-star/i,
  /star-rating/i,
  /social/i,
  /share/i,
  /cart/i,
  /\/cms\//i,
  /arrow/i,
  /chevron/i,
  /checkmark/i,
  /check-mark/i,
];

function isExcludedAsset(url: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(url));
}

/**
 * Reject unrendered template placeholders (e.g. `<IMAGE_URL>`, `{{ img }}`,
 * `${url}`) that leak into markup — resolving them yields bogus URLs like
 * `/products/%3CIMAGE_URL%3E` that 404 on download.
 */
function isTemplatePlaceholder(raw: string): boolean {
  return /[<>]|%3c|%3e|\{\{|\}\}|\$\{/i.test(raw);
}

// ---------------------------------------------------------------------------
// Product-container selectors — ordered from most to least specific
// ---------------------------------------------------------------------------

/**
 * CSS selectors that identify the primary product content area.
 * We try them in order and use the first match as the scope for DOM image scanning.
 * Excludes nav, header, footer, aside, cookie banners, and recommendation sections.
 */
const PRODUCT_CONTAINER_SELECTORS = [
  // Microdata product
  "[itemtype*='schema.org/Product']",
  "[itemtype*='schema.org/product']",
  // Common Shopify / WooCommerce / Magento product page sections
  ".product__media-gallery",
  ".product-gallery",
  ".product-images",
  ".product-single",
  ".product-detail",
  ".product-page",
  ".product--full",
  "#product-images",
  "#product-media",
  "#product-gallery",
  // Generic semantic zones
  "main article",
  "[role=main] article",
  "main",
  "[role=main]",
];

/**
 * Selectors for sections that should NEVER be included in the product scope,
 * even if they happen to be inside `main`.
 */
const EXCLUDE_SECTION_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  "[role=navigation]",
  "[role=banner]",
  "[role=complementary]",
  "[role=contentinfo]",
  // Cross-sell / upsell carousels
  ".related",
  ".upsell",
  ".cross-sell",
  ".recommendations",
  ".recently-viewed",
  ".also-bought",
  // Reviews
  ".reviews",
  ".testimonials",
  "[id*='reviews']",
  "[class*='review']",
  // Cookie / GDPR banners
  "[id*='cookie']",
  "[class*='cookie']",
  "[id*='gdpr']",
  "[class*='gdpr']",
  // Newsletter / popups
  "[id*='newsletter']",
  "[class*='newsletter']",
  "[id*='popup']",
  "[class*='popup']",
];

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Discover candidate product images from structured data, metadata, and the
 * rendered DOM.
 *
 * Priority tiers (high → low):
 *   T1  JSON-LD Product.image         (explicitly about the product)
 *   T2  OG / Twitter image tags       (social share image = usually the main product shot)
 *   T3  <img> inside product container (scoped to identified product area)
 *   T4  <picture>/<source> inside product container
 *   T5  CSS background inside product container
 *   T6  <link rel=preload as=image>   (browser hints — often product hero)
 *
 * Anything in nav / footer / aside / review / cross-sell sections is skipped.
 */
export function discoverImages(meta: ExtractedMetadata, finalUrl: string): DiscoveredImage[] {
  const { $, jsonLd, seo } = meta;
  const byNormalized = new Map<string, DiscoveredImage>();

  const add = (raw: string | undefined, source: string, alt?: string): void => {
    if (!raw) return;
    if (isTemplatePlaceholder(raw)) return;
    const normalized = normalizeImageUrl(raw, finalUrl);
    if (!normalized) return;
    if (isExcludedAsset(normalized)) return;
    if (byNormalized.has(normalized)) return;
    byNormalized.set(normalized, {
      url: raw,
      normalizedUrl: normalized,
      source,
      ...(alt ? { alt } : {}),
    });
  };

  // T1 — JSON-LD Product.image
  const product = findJsonLdByType(jsonLd, "Product");
  if (product) collectJsonLdImages(product["image"], add);
  const t1Count = byNormalized.size;

  // T2 — OG / Twitter meta images
  add(seo.openGraph["og:image"], "og:image");
  add(seo.openGraph["og:image:secure_url"], "og:image");
  add(seo.twitter["twitter:image"], "twitter:image");
  add(seo.twitter["twitter:image:src"], "twitter:image");
  const t2Count = byNormalized.size - t1Count;

  // T3-T5 — DOM scanning, scoped to the product container
  const scope = findProductScope($);
  const scopeLabel = scope === null ? "body" : "product-container";
  const domScope = scope ?? $("body");

  collectImgsInScope($, domScope, add);
  const t3Count = byNormalized.size - t1Count - t2Count;

  collectPictureSourcesInScope($, domScope, add);
  const t4Count = byNormalized.size - t1Count - t2Count - t3Count;

  collectBackgroundImagesInScope($, domScope, add);
  const t5Count = byNormalized.size - t1Count - t2Count - t3Count - t4Count;

  // T6 — preload link hints (these are usually above-fold / hero images)
  $('link[rel="preload"][as="image"]').each((_, el) => {
    add($(el).attr("href"), "preload");
    const imagesrcset = $(el).attr("imagesrcset");
    if (imagesrcset) parseSrcset(imagesrcset).forEach((u) => add(u, "preload-srcset"));
  });
  const t6Count = byNormalized.size - t1Count - t2Count - t3Count - t4Count - t5Count;

  const all = [...byNormalized.values()];
  const capped = all.slice(0, sitesConfig.images.maxImagesToProcess);

  log.info("discovered images", {
    scope: scopeLabel,
    total: all.length,
    capped: capped.length,
    t1_jsonld: t1Count,
    t2_og: t2Count,
    t3_img: t3Count,
    t4_picture: t4Count,
    t5_css_bg: t5Count,
    t6_preload: t6Count,
  });

  return capped;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Find the tightest product-content scope in the DOM.
 * Returns null if nothing suitable is found (caller falls back to <body>).
 */
function findProductScope($: CheerioAPI): Cheerio<AnyNode> | null {
  for (const selector of PRODUCT_CONTAINER_SELECTORS) {
    const el = $(selector).first();
    if (el.length) return el;
  }
  return null;
}

/**
 * Determine whether a given element (or one of its ancestors up to `scopeRoot`)
 * falls inside an excluded section (nav, footer, reviews carousel, etc.).
 */
function isInExcludedSection($: CheerioAPI, el: Element): boolean {
  // Walk up the ancestors and test each against the exclusion selectors.
  let node: AnyNode | null = el;
  while (node) {
    for (const excl of EXCLUDE_SECTION_SELECTORS) {
      try {
        if ($(node).is(excl)) return true;
      } catch {
        // ignore invalid selector
      }
    }
    // Stop at document root (parent is null or a Document node without a parent)
    if (!node.parent || !node.parent.parent) break;
    node = node.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scoped collectors
// ---------------------------------------------------------------------------

function collectImgsInScope(
  $: CheerioAPI,
  scope: Cheerio<AnyNode>,
  add: (raw: string | undefined, source: string, alt?: string) => void,
): void {
  scope.find("img").each((_, el) => {
    if (isInExcludedSection($, el)) return;
    const alt = $(el).attr("alt") ?? undefined;
    add($(el).attr("src"), "img", alt);
    add($(el).attr("data-src"), "data-src", alt);
    add($(el).attr("data-original"), "data-original", alt);
    add($(el).attr("data-lazy"), "data-lazy", alt);
    add($(el).attr("data-zoom-image"), "data-zoom-image", alt);
    add($(el).attr("data-large"), "data-large", alt);
    const srcset = $(el).attr("srcset");
    if (srcset) parseSrcset(srcset).forEach((u) => add(u, "srcset", alt));
    const dataSrcset = $(el).attr("data-srcset");
    if (dataSrcset) parseSrcset(dataSrcset).forEach((u) => add(u, "data-srcset", alt));
  });
}

function collectPictureSourcesInScope(
  $: CheerioAPI,
  scope: Cheerio<AnyNode>,
  add: (raw: string | undefined, source: string, alt?: string) => void,
): void {
  scope.find("picture source").each((_, el) => {
    if (isInExcludedSection($, el)) return;
    const srcset = $(el).attr("srcset") ?? $(el).attr("data-srcset");
    if (srcset) parseSrcset(srcset).forEach((u) => add(u, "picture-source"));
  });
}

function collectBackgroundImagesInScope(
  $: CheerioAPI,
  scope: Cheerio<AnyNode>,
  add: (raw: string | undefined, source: string, alt?: string) => void,
): void {
  scope.find("[style*='background']").each((_, el) => {
    if (isInExcludedSection($, el)) return;
    const style = $(el).attr("style") ?? "";
    const match = style.match(/background(?:-image)?\s*:\s*[^;]*url\((['"]?)(.*?)\1\)/i);
    if (match && match[2]) add(match[2], "css-bg");
  });
}

// ---------------------------------------------------------------------------
// JSON-LD helper
// ---------------------------------------------------------------------------

function collectJsonLdImages(
  value: unknown,
  add: (raw: string | undefined, source: string, alt?: string) => void,
): void {
  if (!value) return;
  if (typeof value === "string") {
    add(value, "jsonld");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => collectJsonLdImages(v, add));
    return;
  }
  if (typeof value === "object") {
    const url = (value as Record<string, unknown>)["url"];
    if (typeof url === "string") add(url, "jsonld:ImageObject");
  }
}
