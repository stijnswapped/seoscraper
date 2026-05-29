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
 * Parse a srcset attribute and return the candidate URLs (descriptors stripped).
 */
export function parseSrcset(srcset: string): string[] {
  return srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter((u): u is string => Boolean(u));
}
