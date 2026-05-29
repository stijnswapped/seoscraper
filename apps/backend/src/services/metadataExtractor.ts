import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { ExtractedField, RawMetadata } from "../types/productCheck.js";
import { CONFIDENCE, emptyField, field } from "../utils/confidence.js";

export interface ExtractedMetadata {
  seo: {
    title: ExtractedField<string | null>;
    description: ExtractedField<string | null>;
    canonicalUrl: ExtractedField<string | null>;
    openGraph: Record<string, string>;
    twitter: Record<string, string>;
  };
  /** Parsed JSON-LD nodes (flattened from arrays/@graph). */
  jsonLd: unknown[];
  raw: RawMetadata;
  /** Shared cheerio instance so callers don't re-parse. */
  $: CheerioAPI;
}

function clean(value: string | undefined | null): string | null {
  if (value == null) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length ? trimmed : null;
}

/** Flatten JSON-LD which may be a single object, an array, or use @graph. */
export function flattenJsonLd(parsed: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj["@graph"])) {
        (obj["@graph"] as unknown[]).forEach(visit);
      }
      out.push(obj);
    }
  };
  visit(parsed);
  return out;
}

/** Find the first JSON-LD node whose @type matches (case-insensitive). */
export function findJsonLdByType(
  nodes: unknown[],
  type: string,
): Record<string, unknown> | null {
  const target = type.toLowerCase();
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const t = (node as Record<string, unknown>)["@type"];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => typeof x === "string" && x.toLowerCase() === target)) {
      return node as Record<string, unknown>;
    }
  }
  return null;
}

export function extractMetadata(html: string, finalUrl: string): ExtractedMetadata {
  const $ = cheerio.load(html);

  // --- Collect raw meta/link tags + OG/Twitter maps ------------------------
  const metaTags: RawMetadata["metaTags"] = [];
  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};

  $("meta").each((_, el) => {
    const name = $(el).attr("name");
    const property = $(el).attr("property");
    const content = $(el).attr("content");
    if (content == null) return;
    metaTags.push({
      ...(name ? { name } : {}),
      ...(property ? { property } : {}),
      content,
    });
    const key = (property ?? name ?? "").toLowerCase();
    if (key.startsWith("og:")) openGraph[key] = content;
    else if (key.startsWith("twitter:")) twitter[key] = content;
  });

  const linkTags: RawMetadata["linkTags"] = [];
  $("link").each((_, el) => {
    const rel = $(el).attr("rel");
    const href = $(el).attr("href");
    if (rel && href) linkTags.push({ rel, href });
  });

  // --- JSON-LD --------------------------------------------------------------
  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).contents().text();
    if (!text.trim()) return;
    try {
      jsonLd.push(...flattenJsonLd(JSON.parse(text)));
    } catch {
      // Malformed JSON-LD is common; skip silently but it's recorded by absence.
    }
  });
  const product = findJsonLdByType(jsonLd, "Product");

  // --- SEO title (priority chain) ------------------------------------------
  const title = pickTitle($, openGraph, twitter, product);
  const description = pickDescription($, openGraph, twitter, product);
  const canonicalUrl = pickCanonical($, openGraph, finalUrl);

  return {
    seo: { title, description, canonicalUrl, openGraph, twitter },
    jsonLd,
    $,
    raw: {
      finalUrl,
      fetchedAt: new Date().toISOString(),
      title: clean($("title").first().text()),
      metaTags,
      linkTags,
      jsonLd,
      openGraph,
      twitter,
    },
  };
}

function pickTitle(
  $: CheerioAPI,
  og: Record<string, string>,
  tw: Record<string, string>,
  product: Record<string, unknown> | null,
): ExtractedField<string | null> {
  const titleTag = clean($("title").first().text());
  if (titleTag) return field(titleTag, "title_tag", CONFIDENCE.titleTag);

  const ogTitle = clean(og["og:title"]);
  if (ogTitle) return field(ogTitle, "og:title", CONFIDENCE.ogTag);

  const twTitle = clean(tw["twitter:title"]);
  if (twTitle) return field(twTitle, "twitter:title", CONFIDENCE.twitterTag);

  const ldName = clean(product?.["name"] as string | undefined);
  if (ldName) return field(ldName, "jsonld:Product.name", CONFIDENCE.jsonLd);

  const h1 = clean($("h1").first().text());
  if (h1) return field(h1, "h1", CONFIDENCE.domSemantic, ["Title taken from first <h1> as fallback."]);

  return emptyField("No SEO title found.");
}

function pickDescription(
  $: CheerioAPI,
  og: Record<string, string>,
  tw: Record<string, string>,
  product: Record<string, unknown> | null,
): ExtractedField<string | null> {
  const metaDesc = clean($('meta[name="description"]').attr("content"));
  if (metaDesc) return field(metaDesc, "meta_description", CONFIDENCE.metaDescription);

  const ogDesc = clean(og["og:description"]);
  if (ogDesc) return field(ogDesc, "og:description", CONFIDENCE.ogTag);

  const twDesc = clean(tw["twitter:description"]);
  if (twDesc) return field(twDesc, "twitter:description", CONFIDENCE.twitterTag);

  const ldDesc = clean(product?.["description"] as string | undefined);
  if (ldDesc) return field(ldDesc, "jsonld:Product.description", CONFIDENCE.jsonLd);

  return emptyField("No SEO description found.");
}

function pickCanonical(
  $: CheerioAPI,
  og: Record<string, string>,
  finalUrl: string,
): ExtractedField<string | null> {
  const canonical = clean($('link[rel="canonical"]').attr("href"));
  if (canonical) {
    const warnings: string[] = [];
    try {
      const abs = new URL(canonical, finalUrl).toString();
      if (new URL(abs).pathname !== new URL(finalUrl).pathname) {
        warnings.push("Canonical path differs from the loaded page path.");
      }
      return field(abs, "canonical_link", CONFIDENCE.canonicalLink, warnings);
    } catch {
      return field(canonical, "canonical_link", CONFIDENCE.canonicalLink, [
        "Canonical href is not a valid URL.",
      ]);
    }
  }
  const ogUrl = clean(og["og:url"]);
  if (ogUrl) return field(ogUrl, "og:url", CONFIDENCE.ogTag, ["No <link rel=canonical>; used og:url."]);

  return emptyField("No canonical URL found.");
}
