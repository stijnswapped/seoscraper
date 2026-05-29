// Mirror of the backend response shapes (kept minimal for the test UI).

export interface ExtractedField<T> {
  value: T;
  source: string;
  confidence: number;
  warnings: string[];
}

export interface DiscoveredImage {
  url: string;
  normalizedUrl: string;
  source: string;
  alt?: string;
}

export interface DownloadedImage {
  originalUrl: string;
  filePath: string;
  filename: string;
  bytes: number;
  width?: number;
  height?: number;
  groupId?: string;
  reason: string;
}

export interface SkippedImage {
  originalUrl: string;
  reason: string;
  similarTo?: string;
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

export interface ProgressEvent {
  runId: string;
  phase: string;
  message: string;
  url?: string;
  current?: number;
  total?: number;
  timestamp: string;
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
    strategy: {
      mode: "selective" | "download_all_fallback" | "worker_url_only";
      reason: string;
      groups: Array<{
        groupId: string;
        representativeImage: string;
        imageCount: number;
        reason: string;
      }>;
    };
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

export interface CollectionProductSuccess {
  url: string;
  success: true;
  result: ProductCheckResult;
  fileBaseUrl: string | null;
}

export interface CollectionProductFailure {
  url: string;
  success: false;
  error: ApiError;
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

export interface ApiError {
  code: string;
  message: string;
}

export type CheckResponse =
  | { success: true; result: CheckResult; fileBaseUrl?: string | null }
  | { success: false; error: ApiError };

export async function checkProduct(url: string, runId?: string): Promise<CheckResponse> {
  const res = await fetch("/api/check-product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, runId }),
  });
  return (await res.json()) as CheckResponse;
}

export function createProgressSource(runId: string): EventSource {
  return new EventSource(`/api/check-progress/${encodeURIComponent(runId)}`);
}
