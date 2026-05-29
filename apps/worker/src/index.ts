type ExtractedField<T> = {
  value: T;
  source: string;
  confidence: number;
  warnings: string[];
};

type DiscoveredImage = {
  url: string;
  normalizedUrl: string;
  source: string;
  alt?: string;
};

type DownloadedImage = {
  originalUrl: string;
  filePath: string;
  filename: string;
  bytes: number;
  width?: number;
  height?: number;
  sha256: string;
  perceptualHash?: string;
  groupId?: string;
  reason: string;
};

type SkippedImage = {
  originalUrl: string;
  reason: string;
  similarTo?: string;
  confidence?: number;
};

type ImageSelectionStrategyReport = {
  mode: "worker_url_only";
  reason: string;
  groups: Array<{
    groupId: string;
    representativeImage: string;
    imageCount: number;
    reason: string;
  }>;
};

type SeoSnapshot = {
  inputUrl: string;
  finalUrl: string;
  domain: string;
  checkedAt: string;
  title: ExtractedField<string | null>;
  description: ExtractedField<string | null>;
  canonicalUrl: ExtractedField<string | null>;
  productTitle: ExtractedField<string | null>;
  productDescription: ExtractedField<string | null>;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  structuredData: unknown[];
  downloadedImages: Array<{
    originalUrl: string;
    filePath: string;
    width?: number;
    height?: number;
    reason: string;
  }>;
  warnings: string[];
  errors: string[];
};

type ProductCheckResult = {
  kind: "product";
  inputUrl: string;
  finalUrl: string;
  domain: string;
  checkedAt: string;
  seo: {
    title: ExtractedField<string | null>;
    description: ExtractedField<string | null>;
    canonicalUrl: ExtractedField<string | null>;
    openGraph: Record<string, string>;
    twitter: Record<string, string>;
  };
  seoSnapshot: SeoSnapshot;
  product: {
    title: ExtractedField<string | null>;
    description: ExtractedField<string | null>;
    structuredData: unknown[];
  };
  images: {
    discovered: DiscoveredImage[];
    downloaded: DownloadedImage[];
    skipped: SkippedImage[];
    strategy: ImageSelectionStrategyReport;
  };
  files: {
    outputDir: string | null;
    dataJsonPath: string | null;
    seoJsonPath: string | null;
    rawHtmlPath: string | null;
    rawMetadataPath: string | null;
  };
  warnings: string[];
  errors: string[];
};

type CollectionProductResult =
  | { url: string; success: true; result: ProductCheckResult; fileBaseUrl: string | null }
  | { url: string; success: false; error: { code: ErrorCode; message: string } };

type CollectionCheckResult = {
  kind: "collection";
  inputUrl: string;
  finalUrl: string;
  domain: string;
  checkedAt: string;
  discoveredProductUrls: string[];
  products: CollectionProductResult[];
  summary: { discovered: number; succeeded: number; failed: number };
  warnings: string[];
  errors: string[];
};

type CheckResult = ProductCheckResult | CollectionCheckResult;
type ErrorCode = "INVALID_URL" | "DOMAIN_NOT_ALLOWED" | "PAGE_LOAD_FAILED" | "UNKNOWN_ERROR";

type Env = {
  ALLOW_ALL_DOMAINS?: string;
  ALLOWED_DOMAINS?: string;
  MAX_COLLECTION_PRODUCTS?: string;
};

type LoadedPage = {
  finalUrl: string;
  html: string;
  title: string;
};

const REAL_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

class ApiError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, runtime: "cloudflare-worker" });
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, service: "seoscrape-worker" });
    if (request.method === "GET" && url.pathname.startsWith("/api/check-progress/")) {
      const runId = decodeURIComponent(url.pathname.split("/").pop() ?? "worker-run");
      return sse({
        runId,
        phase: "worker-fetch-mode",
        message: "Cloudflare Workers fetch-first mode runs synchronously and does not stream detailed Playwright progress.",
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/check-product") {
      try {
        const body = (await request.json()) as { url?: unknown };
        if (typeof body.url !== "string" || !body.url.trim()) {
          throw new ApiError("INVALID_URL", "url is required.");
        }
        const result = await runCheck(body.url, env);
        return json({ success: true, result, fileBaseUrl: null });
      } catch (err) {
        if (err instanceof ApiError) {
          return json({ success: false, error: { code: err.code, message: err.message } }, err.code === "PAGE_LOAD_FAILED" ? 502 : 400);
        }
        return json({ success: false, error: { code: "UNKNOWN_ERROR", message: (err as Error).message || "Unexpected error." } }, 500);
      }
    }

    return json({ success: false, error: { code: "UNKNOWN_ERROR", message: "Not found." } }, 404);
  },
};

async function runCheck(inputUrl: string, env: Env): Promise<CheckResult> {
  const parsed = validateUrl(inputUrl);
  assertDomainAllowed(parsed.hostname, env);

  const page = await fetchPage(parsed.toString());
  const discoveredProductUrls = discoverProductUrls(page.html, page.finalUrl, getMaxProducts(env));
  const isCollection = isLikelyCollection(page.finalUrl, page.html, discoveredProductUrls.length);

  if (!isCollection) return processProductPage(inputUrl, page);

  const products: CollectionProductResult[] = [];
  for (const productUrl of discoveredProductUrls) {
    try {
      const productPage = await fetchPage(productUrl);
      products.push({
        url: productUrl,
        success: true,
        result: processProductPage(productUrl, productPage),
        fileBaseUrl: null,
      });
    } catch (err) {
      products.push({
        url: productUrl,
        success: false,
        error: {
          code: err instanceof ApiError ? err.code : "UNKNOWN_ERROR",
          message: (err as Error).message || "Unexpected error.",
        },
      });
    }
  }

  const warnings = workerWarnings();
  if (discoveredProductUrls.length === 0) warnings.push("No static product links were discovered in the initial HTML.");

  const succeeded = products.filter((product) => product.success).length;
  return {
    kind: "collection",
    inputUrl,
    finalUrl: page.finalUrl,
    domain: new URL(page.finalUrl).hostname,
    checkedAt: new Date().toISOString(),
    discoveredProductUrls,
    products,
    summary: {
      discovered: discoveredProductUrls.length,
      succeeded,
      failed: products.length - succeeded,
    },
    warnings,
    errors: [],
  };
}

async function fetchPage(url: string): Promise<LoadedPage> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": REAL_CHROME_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "upgrade-insecure-requests": "1",
      },
    });
  } catch (err) {
    throw new ApiError("PAGE_LOAD_FAILED", `Fetch failed: ${(err as Error).message}`);
  }

  if (!response.ok) throw new ApiError("PAGE_LOAD_FAILED", `Page returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("text/html")) {
    throw new ApiError("PAGE_LOAD_FAILED", `Expected HTML but received ${contentType}.`);
  }

  const html = await response.text();
  return {
    finalUrl: response.url || url,
    html,
    title: cleanText(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i)) ?? "",
  };
}

function processProductPage(inputUrl: string, page: LoadedPage): ProductCheckResult {
  const checkedAt = new Date().toISOString();
  const domain = new URL(page.finalUrl).hostname;
  const warnings = workerWarnings();
  if (page.html.length < 5000) warnings.push("Fetched HTML is small; page may be blocked or client-rendered.");
  if (inputUrl !== page.finalUrl) warnings.push(`Final URL differs from input URL: ${page.finalUrl}`);

  const openGraph = extractMetaMap(page.html, "property", "og:");
  const twitter = extractMetaMap(page.html, "name", "twitter:");
  const jsonLd = extractJsonLd(page.html);
  const productNode = findJsonLdByType(jsonLd, "Product");

  const title = pickTitle(page.html, openGraph, twitter, productNode);
  const description = pickDescription(page.html, openGraph, twitter, productNode);
  const canonicalUrl = pickCanonical(page.html, openGraph, page.finalUrl);
  const productTitle = pickProductTitle(page.html, productNode, openGraph);
  const productDescription = pickProductDescription(page.html, productNode, openGraph);
  const discoveredImages = discoverImages(page.html, page.finalUrl, openGraph, twitter, productNode);
  const structuredData = jsonLd.filter((node) => isStructuredProductNode(node));
  const errors: string[] = [];

  if (!productNode && !productTitle.value && !productDescription.value) {
    warnings.push("No Product JSON-LD or strong product fields found in initial HTML.");
  }

  const seoSnapshot: SeoSnapshot = {
    inputUrl,
    finalUrl: page.finalUrl,
    domain,
    checkedAt,
    title,
    description,
    canonicalUrl,
    productTitle,
    productDescription,
    openGraph,
    twitter,
    structuredData,
    downloadedImages: [],
    warnings,
    errors,
  };

  return {
    kind: "product",
    inputUrl,
    finalUrl: page.finalUrl,
    domain,
    checkedAt,
    seo: { title, description, canonicalUrl, openGraph, twitter },
    seoSnapshot,
    product: { title: productTitle, description: productDescription, structuredData },
    images: {
      discovered: discoveredImages,
      downloaded: [],
      skipped: [],
      strategy: {
        mode: "worker_url_only",
        reason: "Cloudflare Workers fetch-first mode does not download, store, or pixel-deduplicate images; returning discovered image URLs only.",
        groups: [],
      },
    },
    files: {
      outputDir: null,
      dataJsonPath: null,
      seoJsonPath: null,
      rawHtmlPath: null,
      rawMetadataPath: null,
    },
    warnings,
    errors,
  };
}

function pickTitle(
  html: string,
  openGraph: Record<string, string>,
  twitter: Record<string, string>,
  productNode: Record<string, unknown> | null,
): ExtractedField<string | null> {
  const title = cleanText(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  if (title) return field(title, "title_tag", 0.95);
  if (openGraph["og:title"]) return field(openGraph["og:title"], "og:title", 0.9);
  if (twitter["twitter:title"]) return field(twitter["twitter:title"], "twitter:title", 0.85);
  const productName = cleanText(asString(productNode?.["name"]));
  if (productName) return field(productName, "jsonld:Product.name", 0.95);
  const h1 = cleanText(matchFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));
  if (h1) return field(h1, "h1", 0.65, ["Title taken from first h1 fallback."]);
  return emptyField("No SEO title found.");
}

function pickDescription(
  html: string,
  openGraph: Record<string, string>,
  twitter: Record<string, string>,
  productNode: Record<string, unknown> | null,
): ExtractedField<string | null> {
  const meta = getMetaContent(html, "name", "description");
  if (meta) return field(meta, "meta_description", 0.9);
  if (openGraph["og:description"]) return field(openGraph["og:description"], "og:description", 0.85);
  if (twitter["twitter:description"]) return field(twitter["twitter:description"], "twitter:description", 0.8);
  const productDescription = cleanText(asString(productNode?.["description"]));
  if (productDescription) return field(productDescription, "jsonld:Product.description", 0.95);
  return emptyField("No SEO description found.");
}

function pickCanonical(html: string, openGraph: Record<string, string>, finalUrl: string): ExtractedField<string | null> {
  const canonical = matchFirst(html, /<link\b(?=[^>]*\brel=["'][^"']*canonical[^"']*["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/i);
  if (canonical) {
    try {
      return field(new URL(decodeHtml(canonical), finalUrl).toString(), "canonical_link", 0.95);
    } catch {
      return field(decodeHtml(canonical), "canonical_link", 0.75, ["Canonical href is not a valid URL."]);
    }
  }
  if (openGraph["og:url"]) return field(openGraph["og:url"], "og:url", 0.8, ["No canonical link found; used og:url."]);
  return emptyField("No canonical URL found.");
}

function pickProductTitle(html: string, productNode: Record<string, unknown> | null, openGraph: Record<string, string>): ExtractedField<string | null> {
  const name = cleanText(asString(productNode?.["name"]));
  if (name) return field(name, "jsonld:Product.name", 0.95);
  if (openGraph["og:title"]) return field(openGraph["og:title"], "og:title", 0.85);
  const h1 = cleanText(matchFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));
  if (h1) return field(h1, "h1", 0.7);
  return emptyField("No product title found.");
}

function pickProductDescription(html: string, productNode: Record<string, unknown> | null, openGraph: Record<string, string>): ExtractedField<string | null> {
  const desc = cleanText(asString(productNode?.["description"]));
  if (desc) return field(desc, "jsonld:Product.description", 0.95);
  if (openGraph["og:description"]) return field(openGraph["og:description"], "og:description", 0.8);
  const meta = getMetaContent(html, "name", "description");
  if (meta) return field(meta, "meta_description", 0.75);
  return emptyField("No product description found.");
}

function discoverProductUrls(html: string, finalUrl: string, maxProducts: number): string[] {
  const urls = new Map<string, string>();
  for (const href of extractAttributeValues(html, "a", "href")) {
    if (urls.size >= maxProducts) break;
    const normalized = normalizeProductUrl(href, finalUrl);
    if (normalized && !urls.has(normalized)) urls.set(normalized, normalized);
  }
  return [...urls.values()];
}

function discoverImages(
  html: string,
  finalUrl: string,
  openGraph: Record<string, string>,
  twitter: Record<string, string>,
  productNode: Record<string, unknown> | null,
): DiscoveredImage[] {
  const images = new Map<string, DiscoveredImage>();
  const add = (raw: string | undefined, source: string, alt?: string): void => {
    if (!raw) return;
    const normalized = normalizeUrl(raw, finalUrl);
    if (!normalized || images.has(normalized)) return;
    images.set(normalized, { url: raw, normalizedUrl: normalized, source, ...(alt ? { alt } : {}) });
  };

  collectJsonLdImages(productNode?.["image"]).forEach((image) => add(image, "jsonld"));
  add(openGraph["og:image"], "og:image");
  add(openGraph["og:image:secure_url"], "og:image");
  add(twitter["twitter:image"], "twitter:image");
  add(twitter["twitter:image:src"], "twitter:image");

  const imgTagPattern = /<img\b[^>]*>/gi;
  for (const match of html.matchAll(imgTagPattern)) {
    const tag = match[0];
    const alt = getAttribute(tag, "alt") ?? undefined;
    add(getAttribute(tag, "src") ?? undefined, "img", alt);
    add(getAttribute(tag, "data-src") ?? undefined, "data-src", alt);
    add(getAttribute(tag, "data-original") ?? undefined, "data-original", alt);
    add(getAttribute(tag, "data-lazy") ?? undefined, "data-lazy", alt);
    const srcset = getAttribute(tag, "srcset") ?? getAttribute(tag, "data-srcset");
    if (srcset) parseSrcset(srcset).forEach((src) => add(src, "srcset", alt));
  }

  return [...images.values()].slice(0, 30);
}

function isLikelyCollection(finalUrl: string, html: string, productUrlCount: number): boolean {
  const path = new URL(finalUrl).pathname;
  const pathLooksLikeCollection = /\/collections(?:\/|$)|\/category(?:\/|$)|\/categories(?:\/|$)|\/shop(?:\/|$)/i.test(path);
  const hasProductSchema = findJsonLdByType(extractJsonLd(html), "Product") !== null;
  if (hasProductSchema && /\/products\//i.test(path)) return false;
  if (pathLooksLikeCollection) return true;
  return productUrlCount > 1 && !hasProductSchema;
}

function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const text = decodeHtml(match[1] ?? "").trim();
    if (!text) continue;
    try {
      flattenJsonLd(JSON.parse(text), out);
    } catch {
      continue;
    }
  }
  return out;
}

function flattenJsonLd(value: unknown, out: unknown[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenJsonLd(item, out));
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) obj["@graph"].forEach((item) => flattenJsonLd(item, out));
  out.push(obj);
}

function findJsonLdByType(nodes: unknown[], type: string): Record<string, unknown> | null {
  const wanted = type.toLowerCase();
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const t = (node as Record<string, unknown>)["@type"];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((item) => typeof item === "string" && item.toLowerCase() === wanted)) return node as Record<string, unknown>;
  }
  return null;
}

function isStructuredProductNode(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const t = (node as Record<string, unknown>)["@type"];
  const types = Array.isArray(t) ? t : [t];
  return types.some((item) => typeof item === "string" && ["product", "offer", "imageobject", "breadcrumblist"].includes(item.toLowerCase()));
}

function extractMetaMap(html: string, attrName: "name" | "property", prefix: string): Record<string, string> {
  const map: Record<string, string> = {};
  const pattern = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[0];
    const key = getAttribute(tag, attrName)?.toLowerCase();
    const content = getAttribute(tag, "content");
    if (key?.startsWith(prefix) && content) map[key] = cleanText(content) ?? content;
  }
  return map;
}

function getMetaContent(html: string, attrName: "name" | "property", attrValue: string): string | null {
  const pattern = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[0];
    const value = getAttribute(tag, attrName)?.toLowerCase();
    if (value === attrValue.toLowerCase()) return cleanText(getAttribute(tag, "content"));
  }
  return null;
}

function extractAttributeValues(html: string, tagName: string, attrName: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  for (const match of html.matchAll(pattern)) {
    const value = getAttribute(match[0], attrName);
    if (value) out.push(value);
  }
  return out;
}

function getAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const match = tag.match(pattern);
  return match?.[2] ? decodeHtml(match[2]) : null;
}

function normalizeProductUrl(raw: string, baseUrl: string): string | null {
  const url = normalizeUrl(raw, baseUrl);
  if (!url) return null;
  const parsed = new URL(url);
  const base = new URL(baseUrl);
  if (parsed.hostname.toLowerCase() !== base.hostname.toLowerCase()) return null;
  if (!/\/products\/[^/?#]+/i.test(parsed.pathname)) return null;
  const match = parsed.pathname.match(/^(.*?\/products\/[^/?#]+)/i);
  const productPath = match?.[1];
  if (!productPath) return null;
  parsed.pathname = productPath.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeUrl(raw: string, baseUrl: string): string | null {
  const value = raw.trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("#")) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function collectJsonLdImages(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectJsonLdImages(item));
  if (typeof value === "object") {
    const url = (value as Record<string, unknown>)["url"];
    return typeof url === "string" ? [url] : [];
  }
  return [];
}

function parseSrcset(srcset: string): string[] {
  return srcset.split(",").map((part) => part.trim().split(/\s+/)[0]).filter((item): item is string => Boolean(item));
}

function validateUrl(input: string): URL {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
    return url;
  } catch {
    throw new ApiError("INVALID_URL", "Only valid http/https URLs are supported.");
  }
}

function assertDomainAllowed(hostname: string, env: Env): void {
  if (isPrivateHost(hostname)) throw new ApiError("DOMAIN_NOT_ALLOWED", "Loopback and private network hosts are not allowed.");
  if ((env.ALLOW_ALL_DOMAINS ?? "true") === "true") return;
  const allowed = (env.ALLOWED_DOMAINS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const host = hostname.toLowerCase();
  if (!allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new ApiError("DOMAIN_NOT_ALLOWED", "URL must belong to an allowed domain.");
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function getMaxProducts(env: Env): number {
  const n = Number(env.MAX_COLLECTION_PRODUCTS ?? 20);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : 20;
}

function workerWarnings(): string[] {
  return [
    "WORKER_FETCH_MODE: Cloudflare Workers mode uses fetch-only HTML extraction without Playwright/Chromium.",
    "WORKER_FETCH_MODE: JavaScript-rendered content, infinite scroll, browser-only redirects, local file saves, and Sharp image deduplication are unavailable.",
  ];
}

function field<T>(value: T, source: string, confidence: number, warnings: string[] = []): ExtractedField<T> {
  return { value, source, confidence, warnings };
}

function emptyField(message: string): ExtractedField<null> {
  return { value: null, source: "not_found", confidence: 0, warnings: [message] };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function matchFirst(html: string, pattern: RegExp): string | null {
  return html.match(pattern)?.[1] ?? null;
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = decodeHtml(value.replace(/<[^>]+>/g, " "));
  const cleaned = stripped.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function json(data: unknown, status = 200): Response {
  return cors(new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  }));
}

function sse(data: unknown): Response {
  return cors(new Response(`data: ${JSON.stringify(data)}\n\n`, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  }));
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
