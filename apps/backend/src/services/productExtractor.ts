import type { CheerioAPI } from "cheerio";
import type { ExtractedField } from "../types/productCheck.js";
import { CONFIDENCE, emptyField, field } from "../utils/confidence.js";
import { findJsonLdByType } from "./metadataExtractor.js";
import type { ExtractedMetadata } from "./metadataExtractor.js";

/** Text labels that mark a product description / details section (NL + EN). */
const DESCRIPTION_LABELS = [
  "description",
  "omschrijving",
  "productinformatie",
  "productomschrijving",
  "details",
  "productdetails",
  "materiaal",
  "pasvorm",
  "kenmerken",
  "product details",
  "over dit product",
];

export interface ExtractedProduct {
  title: ExtractedField<string | null>;
  description: ExtractedField<string | null>;
  /** Product/Offer/ImageObject/BreadcrumbList nodes from JSON-LD. */
  structuredData: unknown[];
  /** True if nothing product-like was found at all. */
  empty: boolean;
}

function clean(value: string | undefined | null): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length ? trimmed : null;
}

export function extractProduct(meta: ExtractedMetadata): ExtractedProduct {
  const { $, jsonLd, seo } = meta;
  const product = findJsonLdByType(jsonLd, "Product");

  const structuredData = collectStructuredData(jsonLd);
  const title = pickProductTitle($, product, seo);
  const description = pickProductDescription($, product, seo);

  const empty =
    title.value == null && description.value == null && structuredData.length === 0;

  return { title, description, structuredData, empty };
}

function collectStructuredData(nodes: unknown[]): unknown[] {
  const wanted = new Set(["product", "offer", "imageobject", "breadcrumblist"]);
  return nodes.filter((node) => {
    if (!node || typeof node !== "object") return false;
    const t = (node as Record<string, unknown>)["@type"];
    const types = Array.isArray(t) ? t : [t];
    return types.some(
      (x) => typeof x === "string" && wanted.has(x.toLowerCase()),
    );
  });
}

function pickProductTitle(
  $: CheerioAPI,
  product: Record<string, unknown> | null,
  seo: ExtractedMetadata["seo"],
): ExtractedField<string | null> {
  const ldName = clean(product?.["name"] as string | undefined);
  if (ldName) return field(ldName, "jsonld:Product.name", CONFIDENCE.jsonLd);

  const ogTitle = clean(seo.openGraph["og:title"]);
  const h1 = clean($("h1").first().text());
  // The real <title> tag (not a fallback) — used to detect when og:title merely
  // echoes the SEO page title (store/brand suffix) rather than naming the product.
  const titleTag = seo.title.source === "title_tag" ? clean(seo.title.value) : null;
  const ogEchoesPageTitle = Boolean(ogTitle && titleTag && ogTitle === titleTag && h1);

  // og:title is usually a good product name — UNLESS it just echoes the page
  // <title>, in which case the <h1> is the real product name.
  if (ogTitle && !ogEchoesPageTitle) return field(ogTitle, "og:title", CONFIDENCE.ogTag);
  if (h1) return field(h1, "h1", CONFIDENCE.domSemantic);
  if (ogTitle) return field(ogTitle, "og:title", CONFIDENCE.ogTag);

  // Largest "product-like" heading near the top of the document.
  let best: { text: string; len: number } | null = null;
  $("h1, h2, [role=heading]").slice(0, 10).each((_, el) => {
    const text = clean($(el).text());
    if (text && text.length >= 3 && (!best || text.length > best.len)) {
      best = { text, len: text.length };
    }
  });
  if (best) {
    return field((best as { text: string }).text, "dom_heading", CONFIDENCE.domFallback, [
      "Product title guessed from a prominent heading.",
    ]);
  }

  return emptyField("No product title found.");
}

function pickProductDescription(
  $: CheerioAPI,
  product: Record<string, unknown> | null,
  seo: ExtractedMetadata["seo"],
): ExtractedField<string | null> {
  const ldDesc = clean(product?.["description"] as string | undefined);
  if (ldDesc) return field(ldDesc, "jsonld:Product.description", CONFIDENCE.jsonLd);

  const ogDesc = clean(seo.openGraph["og:description"]);
  if (ogDesc) return field(ogDesc, "og:description", CONFIDENCE.ogTag);

  const metaDesc = clean($('meta[name="description"]').attr("content"));
  if (metaDesc) return field(metaDesc, "meta_description", CONFIDENCE.metaDescription);

  // Label-based heuristic: find an element whose own text is a known label,
  // then take the most substantial nearby text block.
  const labelHit = findByLabel($);
  if (labelHit) {
    return field(labelHit, "dom_label_heuristic", CONFIDENCE.domLabelHeuristic, [
      "Description guessed from a labelled section.",
    ]);
  }

  return emptyField("No product description found.");
}

/**
 * Look for headings / dt / strong / summary elements whose text matches a
 * description label, then return the richest adjacent text. Uses only generic
 * semantic selectors — no site-specific classes.
 */
function findByLabel($: CheerioAPI): string | null {
  let result: string | null = null;
  const candidates = $(
    "h2, h3, h4, dt, summary, strong, b, [role=heading]",
  );

  candidates.each((_, el) => {
    if (result) return;
    const labelText = clean($(el).text())?.toLowerCase() ?? "";
    if (!labelText || labelText.length > 40) return;
    const matches = DESCRIPTION_LABELS.some((lbl) => labelText.includes(lbl));
    if (!matches) return;

    // Prefer the next sibling block; fall back to the parent's text.
    const sibling = clean($(el).next().text());
    if (sibling && sibling.length >= 30) {
      result = sibling;
      return;
    }
    const parentText = clean($(el).parent().text());
    if (parentText && parentText.length >= 30) {
      // Strip the label itself from the front if present.
      result = parentText;
    }
  });

  return result;
}
