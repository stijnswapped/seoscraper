/** A single extracted value plus provenance metadata. */
export interface ExtractedField<T> {
  value: T;
  /** Where the value came from, e.g. "title_tag", "og:title", "jsonld:Product.name". */
  source: string;
  /** 0..1 confidence in the value. Higher = more authoritative source. */
  confidence: number;
  warnings: string[];
}

export interface DiscoveredImage {
  url: string;
  normalizedUrl: string;
  /** Where the URL was found, e.g. "jsonld", "og:image", "img", "srcset", "data-src", "preload", "css-bg". */
  source: string;
  alt?: string;
  width?: number;
  height?: number;
  contentType?: string;
}

export interface DownloadedImage {
  originalUrl: string;
  /** Path relative to the run folder, e.g. "images/001-main.jpg". */
  filePath: string;
  filename: string;
  bytes: number;
  width?: number;
  height?: number;
  sha256: string;
  perceptualHash?: string;
  /** Identifies the visual group this image represents. */
  groupId?: string;
  /** Human-readable reason this image was kept. */
  reason: string;
}

export interface SkippedImage {
  originalUrl: string;
  reason: string;
  /** If skipped as a duplicate, the URL it was a duplicate of. */
  similarTo?: string;
  confidence?: number;
}

export interface ImageSelectionStrategyReport {
  mode: "selective" | "download_all_fallback" | "worker_url_only";
  reason: string;
  groups: Array<{
    groupId: string;
    representativeImage: string;
    imageCount: number;
    reason: string;
  }>;
}

export interface ProductCheckResult {
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
}

export interface SeoSnapshot {
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
}

export interface CollectionProductSuccess {
  url: string;
  success: true;
  result: ProductCheckResult;
  fileBaseUrl: string | null;
}

export interface CollectionProductFailure {
  url: string;
  success: false;
  error: {
    code: ErrorCode;
    message: string;
  };
}

export type CollectionProductResult =
  | CollectionProductSuccess
  | CollectionProductFailure;

export interface CollectionCheckResult {
  kind: "collection";
  inputUrl: string;
  finalUrl: string;
  domain: string;
  checkedAt: string;
  discoveredProductUrls: string[];
  products: CollectionProductResult[];
  summary: {
    discovered: number;
    succeeded: number;
    failed: number;
  };
  warnings: string[];
  errors: string[];
}

export type CheckResult = ProductCheckResult | CollectionCheckResult;

export type ListingSourceStrategy = "auto" | "html" | "shopify_json" | "both";
export type ListingSourceUsed = "html" | "shopify_json" | "both";
export type ListingRankDirection = "up" | "down" | "same" | "new" | "missing";

export interface ListingRankItem {
  rank: number;
  productKey: string;
  url: string;
  handle?: string;
  title?: string;
  imageUrl?: string;
  productId?: string;
  source: ListingSourceUsed;
}

export interface ListingRankChange {
  productKey: string;
  url: string;
  handle?: string;
  title?: string;
  previousRank: number | null;
  currentRank: number | null;
  delta: number | null;
  direction: ListingRankDirection;
  previousSnapshotId: string | null;
  currentSnapshotId: string;
}

export interface ListingRankSnapshot {
  kind: "listing_rank_snapshot";
  snapshotId: string;
  trackedListingId: string;
  listingKey: string;
  storeDomain: string;
  listingUrl: string;
  sourceStrategy: ListingSourceStrategy;
  sourceUsed: ListingSourceUsed;
  checkedAt: string;
  items: ListingRankItem[];
  changes: ListingRankChange[];
  summary: {
    tracked: number;
    new: number;
    movedUp: number;
    movedDown: number;
    unchanged: number;
    missing: number;
  };
  warnings: string[];
}

/** Consistent error codes surfaced by the API. */
export type ErrorCode =
  | "INVALID_URL"
  | "DOMAIN_NOT_ALLOWED"
  | "PAGE_LOAD_FAILED"
  | "NO_PRODUCT_DATA_FOUND"
  | "IMAGE_DOWNLOAD_FAILED"
  | "OUTPUT_WRITE_FAILED"
  | "UNKNOWN_ERROR";

/** Thrown internally; carries a stable error code for the API layer. */
export class CheckError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CheckError";
  }
}

/** Raw metadata blob saved to raw/metadata.json for debugging. */
export interface RawMetadata {
  finalUrl: string;
  fetchedAt: string;
  title: string | null;
  metaTags: Array<{ name?: string; property?: string; content: string }>;
  linkTags: Array<{ rel: string; href: string }>;
  jsonLd: unknown[];
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
}
