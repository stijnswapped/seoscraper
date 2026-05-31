/**
 * Central configuration for the product content checker.
 *
 * This is the single place to control which domains are allowed, how the
 * headless browser behaves, how images are filtered/deduplicated, and where
 * output runs are written.
 */

export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

/**
 * Shape for FUTURE domain-specific extraction overrides.
 *
 * v1 works generically without any hardcoded classes, so `siteOverrides` is
 * intentionally empty. When a specific site needs help, add an entry keyed by
 * hostname, e.g.:
 *
 *   siteOverrides: {
 *     "shop.example.com": {
 *       productTitleSelectors: ["h1[itemprop=name]"],
 *       descriptionLabels: ["productomschrijving"],
 *       mainContentSelector: "main .product",
 *     },
 *   }
 *
 * The extractors read these as *additional* hints layered on top of the
 * generic strategy — they never replace the metadata-first approach.
 */
export interface SiteOverride {
  /** Extra CSS selectors to try first when finding the product title. */
  productTitleSelectors?: string[];
  /** Extra CSS selectors to try first when finding the description. */
  descriptionSelectors?: string[];
  /** Extra text labels (lowercased) that mark a description section. */
  descriptionLabels?: string[];
  /** Selector for the main product content container (for image scoping). */
  mainContentSelector?: string;
}

export interface SitesConfig {
  /**
   * TESTING TOGGLE.
   * When true, ANY http/https host is accepted (loopback/private IPs are still
   * blocked for basic SSRF safety). Set to `false` in production so only the
   * hosts in `allowedDomains` are accepted.
   */
  allowAllDomains: boolean;

  /** Hostnames accepted when `allowAllDomains` is false. */
  allowedDomains: string[];

  browser: {
    timeoutMs: number;
    waitUntil: WaitUntil;
    /** Max auto-scroll time for listing/collection pages (lazy grids). */
    scrollTimeoutMs: number;
    /** Max auto-scroll time for single product pages (settles fast). */
    productScrollTimeoutMs: number;
    /** Stop scrolling after this many consecutive rounds with no height change. */
    scrollSettleRounds: number;
    userAgent: string;
    extraHTTPHeaders: Record<string, string>;
    viewport: { width: number; height: number };
    /**
     * Max headless Chromium processes alive at once across ALL in-flight
     * requests. Keep low on small containers — unbounded concurrent launches
     * OOM-kill the box (SIGTRAP during launch).
     */
    maxConcurrency: number;
    /** Per-attempt timeout for chromium.launch() before we retry it. */
    launchTimeoutMs: number;
  };

  images: {
    minWidth: number;
    minHeight: number;
    maxImagesToProcess: number;
    /** 0..1 — structural similarity at/above this counts as "same view". */
    similarityThreshold: number;
    /** Max Hamming distance between perceptual hashes to call images near-identical. */
    perceptualHashMaxDistance: number;
    fallbackToDownloadAllOnLowConfidence: boolean;

    /** Max bytes to download per image (guards against runaways). */
    maxBytesPerImage: number;
    /** Aspect ratio (w/h or h/w) above this is considered "extreme" (banner/sprite). */
    maxAspectRatio: number;
    /** Edge-map difference at/below this (0..1) is considered the same silhouette. */
    edgeSimilarityThreshold: number;
    /** If more than this fraction of candidates fail processing, fall back. */
    maxProcessingFailureRatio: number;
    /** How many images to download + process in parallel per product. */
    downloadConcurrency: number;
  };

  output: {
    baseDir: string;
    /** Delete on-disk research runs older than this many days. */
    retentionDays: number;
    /** How often the background cleanup sweep runs. */
    cleanupIntervalMs: number;
    /** Hard cap on retained run folders (oldest beyond this are deleted). */
    maxRuns: number;
  };

  /** Parallelism for multi-product scraping (collections). */
  scraping: {
    concurrency: number;
  };

  /** Domain-specific extraction hints. Empty by default (generic mode). */
  siteOverrides: Record<string, SiteOverride>;

  collections: {
    maxProducts: number;
    /** Default max pages to crawl when walking pagination (overridable per request). */
    maxPages: number;
    /** Hard ceiling for a per-request maxPages override. */
    maxPagesCeiling: number;
  };

  /** Async per-product enrichment for the best-seller tracker. */
  enrichment: {
    /** How many product pages to scrape in parallel. */
    concurrency: number;
  };
}

/** Read a boolean env var. Empty/unset falls back to the provided default. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Read a comma-separated list env var (lowercased, trimmed, non-empty). */
function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** Read a positive integer env var, falling back when missing/invalid. */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const allowedDomainsFromEnv = envList("ALLOWED_DOMAINS");

export const sitesConfig: SitesConfig = {
  // --- Domain allowlist -----------------------------------------------------
  // Controlled by env in deployment; defaults keep local testing permissive.
  //   ALLOW_ALL_DOMAINS=false   -> enforce the allowlist below
  //   ALLOWED_DOMAINS=a.com,b.com (comma-separated) -> the allowlist
  allowAllDomains: envBool("ALLOW_ALL_DOMAINS", true),
  allowedDomains:
    allowedDomainsFromEnv.length > 0
      ? allowedDomainsFromEnv
      : [
          // Replace these placeholders with your owned webshop hostnames, then
          // set ALLOW_ALL_DOMAINS=false to enforce the allowlist.
          "example.com",
          "www.example.com",
        ],

  // --- Headless browser -----------------------------------------------------
  browser: {
    timeoutMs: 30000,
    waitUntil: "domcontentloaded",
    scrollTimeoutMs: envInt("LISTING_SCROLL_TIMEOUT_MS", 15000),
    productScrollTimeoutMs: envInt("PRODUCT_SCROLL_TIMEOUT_MS", 5000),
    scrollSettleRounds: 3,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    },
    viewport: { width: 1366, height: 1000 },
    maxConcurrency: envInt("BROWSER_MAX_CONCURRENCY", 1),
    launchTimeoutMs: envInt("BROWSER_LAUNCH_TIMEOUT_MS", 45000),
  },

  // --- Image filtering & selection -----------------------------------------
  images: {
    minWidth: 300,
    minHeight: 300,
    maxImagesToProcess: 30,
    similarityThreshold: 0.88,
    perceptualHashMaxDistance: 6,
    // Keep false: we want the deduplication pipeline to always run.
    // Setting this to true defeats dedup by dumping all images whenever < 2
    // candidates remain after filtering.
    fallbackToDownloadAllOnLowConfidence: false,

    maxBytesPerImage: 15 * 1024 * 1024,
    maxAspectRatio: 3.0,
    edgeSimilarityThreshold: 0.9,
    maxProcessingFailureRatio: 0.5,
    downloadConcurrency: envInt("IMAGE_CONCURRENCY", 4),
  },

  // --- Output ---------------------------------------------------------------
  output: {
    baseDir: process.env.OUTPUT_DIR ?? "output",
    // Research runs (rendered HTML + images) are heavy but low-volume; auto-prune
    // them so disk stays bounded. Best-seller tracking writes nothing to disk.
    retentionDays: envInt("RUN_RETENTION_DAYS", 7),
    cleanupIntervalMs: envInt("RUN_CLEANUP_INTERVAL_MS", 60 * 60 * 1000),
    maxRuns: envInt("RUN_MAX_COUNT", 300),
  },

  // --- Multi-product scraping parallelism -----------------------------------
  // Match this to the Railway box: ~1 concurrent page per vCPU,
  // ~250-350MB RAM per page. Mid box (2 vCPU / 2-4GB) -> 4.
  scraping: {
    concurrency: envInt("SCRAPE_CONCURRENCY", 4),
  },

  // --- Future per-site overrides (generic mode = empty) ---------------------
  siteOverrides: {},

  collections: {
    maxProducts: envInt("MAX_COLLECTION_PRODUCTS", 100),
    maxPages: envInt("MAX_COLLECTION_PAGES", 10),
    maxPagesCeiling: envInt("MAX_COLLECTION_PAGES_CEILING", 100),
  },

  enrichment: {
    concurrency: envInt("ENRICH_CONCURRENCY", 2),
  },
};
