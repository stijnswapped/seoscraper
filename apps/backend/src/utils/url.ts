import { sitesConfig } from "../../../../config/sites.config.js";
import { CheckError } from "../types/productCheck.js";

/** Tracking query params that are safe to strip from image URLs. */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "yclid",
  "igshid",
  "ref",
  "ref_src",
];

/**
 * Params that frequently encode a meaningful image variant (size/format/crop).
 * We keep these even if they look noisy.
 */
const VARIANT_PARAMS = new Set([
  "w",
  "h",
  "width",
  "height",
  "size",
  "s",
  "q",
  "quality",
  "fm",
  "format",
  "fit",
  "crop",
  "dpr",
  "v",
  "version",
  "rev",
  "sku",
  "variant",
]);

export interface ValidatedUrl {
  url: URL;
  hostname: string;
}

/** Validate that input is a well-formed http(s) URL. Throws INVALID_URL. */
export function validateAndNormalizeUrl(input: string): ValidatedUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CheckError("INVALID_URL", "The provided value is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CheckError(
      "INVALID_URL",
      "Only http and https URLs are supported.",
    );
  }
  return { url, hostname: url.hostname.toLowerCase() };
}

/** True if the hostname is a loopback / private / link-local address or name. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  // IPv6 loopback / unique-local / link-local
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) {
    return true;
  }
  // IPv4 literals
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/**
 * Enforce the domain policy. Throws DOMAIN_NOT_ALLOWED if rejected.
 * Loopback/private hosts are always rejected, even in allow-all mode.
 */
export function assertDomainAllowed(hostname: string): void {
  if (isPrivateHost(hostname)) {
    throw new CheckError(
      "DOMAIN_NOT_ALLOWED",
      "Loopback and private network hosts are not allowed.",
    );
  }
  if (sitesConfig.allowAllDomains) return;

  const allowed = sitesConfig.allowedDomains.map((d) => d.toLowerCase());
  const ok = allowed.some(
    (d) => hostname === d || hostname.endsWith(`.${d}`),
  );
  if (!ok) {
    throw new CheckError(
      "DOMAIN_NOT_ALLOWED",
      "URL must belong to an allowed domain.",
    );
  }
}

/**
 * Resolve an image URL against the page URL and strip tracking params while
 * preserving variant params. Returns null for unusable values (data:, blank).
 */
export function normalizeImageUrl(raw: string, baseUrl: string): string | null {
  const value = raw.trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  for (const param of [...url.searchParams.keys()]) {
    const lower = param.toLowerCase();
    if (VARIANT_PARAMS.has(lower)) continue;
    if (TRACKING_PARAMS.includes(lower) || lower.startsWith("utm_")) {
      url.searchParams.delete(param);
    }
  }
  url.hash = "";
  return url.toString();
}

/**
 * Strip a single leading Shopify locale/market segment from a path, e.g.
 * `/en-us/collections/all` -> `/collections/all`, `/fr/products/x` -> `/products/x`.
 * Only a `{lang}` or `{lang}-{region}` segment is removed (never a real path part
 * like `/collections`), so non-localized paths are returned unchanged.
 */
export function stripLocalePrefix(pathname: string): string {
  return pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, "");
}

/** The `/collections/<handle>` handle of a URL (locale prefix ignored), or null. */
export function collectionHandleOf(url: URL): string | null {
  const match = stripLocalePrefix(url.pathname).match(/\/collections\/([^/?#]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Same registrable host ignoring a leading `www.` (e.g. www.shop.com == shop.com). */
function sameHostIgnoringWww(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return strip(a) === strip(b);
}

/**
 * Decide whether a redirect from a collection page is "safe" to follow, and if
 * so return the URL to fetch next.
 *
 * Many Shopify stores 301/302 a collection to a localized (`/en-us/…`,
 * `/fr-fr/…`) or `www.`-canonicalized copy of the SAME collection. Refusing to
 * follow these (the old `redirect: "manual"` behavior) made the best-selling
 * HTML tier fail, so the tracker silently fell back to products.json's UNSORTED
 * default order — recording wrong "best-selling" ranks (deloxusa, vitellimoda)
 * or skipping the store entirely when products.json also redirected
 * (kouvrfashion).
 *
 * A redirect is safe only when it lands on the SAME collection handle on the
 * same registrable host. Redirects that change the collection handle (a
 * renamed/merged collection = a different listing) return null and must NOT be
 * followed. The requested `sort_by`/`page` params are re-applied to the target
 * so a redirect that drops them still yields the correctly-sorted grid.
 */
export function safeCollectionRedirectTarget(requestedUrl: string, location: string): string | null {
  let requested: URL;
  let target: URL;
  try {
    requested = new URL(requestedUrl);
    target = new URL(location, requestedUrl);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (!sameHostIgnoringWww(requested.hostname, target.hostname)) return null;

  const requestedHandle = collectionHandleOf(requested);
  const targetHandle = collectionHandleOf(target);
  if (!requestedHandle || !targetHandle || requestedHandle !== targetHandle) return null;

  // Re-apply the params that drive ordering/pagination so a redirect that drops
  // them (e.g. a theme that strips ?sort_by) still returns the requested view.
  const sortBy = requested.searchParams.get("sort_by");
  if (sortBy && target.searchParams.get("sort_by") !== sortBy) target.searchParams.set("sort_by", sortBy);
  const page = requested.searchParams.get("page");
  if (page && !target.searchParams.get("page")) target.searchParams.set("page", page);

  const next = target.toString();
  return next === requestedUrl ? null : next;
}

/**
 * Parse a srcset attribute and return the candidate URLs (descriptors stripped).
 */
export function parseSrcset(srcset: string): string[] {
  return srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((u): u is string => Boolean(u));
}
