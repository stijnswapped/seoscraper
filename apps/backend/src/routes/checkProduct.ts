import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sitesConfig } from "../../../../config/sites.config.js";
import {
  CheckError,
  type CheckResult,
  type CollectionCheckResult,
  type CollectionProductResult,
  type ErrorCode,
  type ProductCheckResult,
  type SeoSnapshot,
} from "../types/productCheck.js";
import { createLogger } from "../utils/logger.js";
import {
  assertDomainAllowed,
  validateAndNormalizeUrl,
} from "../utils/url.js";
import type { CheerioAPI } from "cheerio";
import {
  loadRenderedPage,
  withBrowserSession,
  type BrowserSession,
} from "../services/pageLoader.js";
import type { LoadedPage } from "../services/pageLoader.js";
import { extractMetadata } from "../services/metadataExtractor.js";
import { extractProduct } from "../services/productExtractor.js";
import { discoverImages } from "../services/imageDiscovery.js";
import { downloadAndSelect } from "../services/imageDownloader.js";
import { crawlPages, resolveMaxPages } from "../services/pagination.js";
import { extractProductUrlsFromPage } from "../services/collectionDiscovery.js";
import {
  createRun,
  writeData,
  writeRaw,
  writeSeoData,
} from "../services/outputWriter.js";
import { discoverCollectionProducts } from "../services/collectionDiscovery.js";
import {
  attachProgressClient,
  createProgressReporter,
  finishProgress,
  type ProgressReporter,
} from "../services/progressHub.js";
import { requireApiKeyAuth } from "../services/apiAuth.js";
import { runWithConcurrency } from "../utils/concurrency.js";

const log = createLogger("checkProduct");
const COLLECTION_PATH_PATTERNS = [
  /\/collections(?:\/|$)/i,
  /\/category(?:\/|$)/i,
  /\/categories(?:\/|$)/i,
  /\/shop(?:\/|$)/i,
];

const bodySchema = z.object({
  url: z.string().min(1, "url is required"),
  runId: z.string().min(1).optional(),
  maxPages: z.number().int().positive().optional(),
  responseMode: z.enum(["full", "url"]).optional(),
});

interface ApiResult {
  result: CheckResult;
  fileBaseUrl?: string;
  dataUrl?: string;
}

export async function runCheck(
  inputUrl: string,
  progress: ProgressReporter = () => {},
  maxPagesRequested?: number,
): Promise<ApiResult> {
  const { url, hostname } = validateAndNormalizeUrl(inputUrl);
  assertDomainAllowed(hostname);

  const maxPages = resolveMaxPages(maxPagesRequested);
  const maxProducts = sitesConfig.collections.maxProducts;

  progress({ phase: "loading", message: "Rendering input URL.", url: url.toString() });

  return withBrowserSession(async (session) => {
   const page = await session.loadPage(url.toString(), {
     scrollProfile: guessScrollProfile(url),
   });
   progress({ phase: "loaded", message: "Input URL loaded and settled.", url: page.finalUrl });

   const meta = extractMetadata(page.html, page.finalUrl);
   const collection = discoverCollectionProducts(meta, page.finalUrl, maxProducts);
   if (!collection.isCollection) {
     return processProductPage(inputUrl, hostname, page, meta, progress);
   }

   const urls = new Map<string, string>();
   const addFrom = ($: CheerioAPI, finalUrl: string) => {
     for (const productUrl of extractProductUrlsFromPage($, finalUrl)) {
       if (urls.size >= maxProducts) break;
       if (!urls.has(productUrl)) urls.set(productUrl, productUrl);
     }
   };

   await crawlPages(
     session,
     page.finalUrl,
     {
       maxPages,
       progress,
       label: "Scanning collection",
       scrollProfile: "listing",
       firstPage: page,
       shouldStop: () => urls.size >= maxProducts,
     },
     ({ $, finalUrl }) => addFrom($, finalUrl),
   );

   return runCollectionCheck(
     inputUrl,
     hostname,
     page,
     meta,
     [...urls.values()].slice(0, maxProducts),
     session,
     progress,
   );
  });
}

function guessScrollProfile(url: URL): "product" | "listing" {
  return COLLECTION_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))
   ? "listing"
   : "product";
}

export async function runSingleProductCheck(
  inputUrl: string,
  progress: ProgressReporter = () => {},
  session?: BrowserSession,
): Promise<{
  result: ProductCheckResult;
  fileBaseUrl: string;
  dataUrl: string;
}> {
  const { url, hostname } = validateAndNormalizeUrl(inputUrl);
  assertDomainAllowed(hostname);
  progress({ phase: "loading-product", message: "Rendering product page.", url: url.toString() });
  const page = session
   ? await session.loadPage(url.toString(), { scrollProfile: "product" })
   : await loadRenderedPage(url.toString());
  progress({ phase: "loaded-product", message: "Product page loaded.", url: page.finalUrl });
  const meta = extractMetadata(page.html, page.finalUrl);
  return processProductPage(inputUrl, hostname, page, meta, progress);
}

async function processProductPage(
  inputUrl: string,
  hostname: string,
  page: LoadedPage,
  meta: ReturnType<typeof extractMetadata>,
  progress: ProgressReporter = () => {},
): Promise<{
  result: ProductCheckResult;
  fileBaseUrl: string;
  dataUrl: string;
}> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const checkedAt = new Date().toISOString();

  progress({ phase: "saving", message: "Creating output run folder.", url: page.finalUrl });
  const run = await createRun(sitesConfig.output.baseDir, hostname);

  progress({ phase: "extracting-seo", message: "Extracting SEO metadata and product schema.", url: page.finalUrl });
  const product = extractProduct(meta);
  if (product.empty) {
    errors.push("NO_PRODUCT_DATA_FOUND: no product title, description, or structured data.");
  }
  collectFieldWarnings(meta, product, warnings);

  progress({ phase: "discovering-images", message: "Discovering product image candidates.", url: page.finalUrl });
  const discovered = discoverImages(meta, page.finalUrl);
  progress({ phase: "downloading-images", message: `Downloading and deduplicating ${discovered.length} image candidates.`, url: page.finalUrl });
  const images = await downloadAndSelect(discovered, run.imagesDir, run.tempDir);
  if (discovered.length > 0 && images.downloaded.length === 0) {
    warnings.push("Images were discovered but none could be downloaded.");
  }

  const seoSnapshot: SeoSnapshot = {
    inputUrl,
    finalUrl: page.finalUrl,
    domain: hostname,
    checkedAt,
    title: meta.seo.title,
    description: meta.seo.description,
    canonicalUrl: meta.seo.canonicalUrl,
    productTitle: product.title,
    productDescription: product.description,
    openGraph: meta.seo.openGraph,
    twitter: meta.seo.twitter,
    structuredData: product.structuredData,
    downloadedImages: images.downloaded.map((image) => ({
      originalUrl: image.originalUrl,
      filePath: image.filePath,
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {}),
      reason: image.reason,
    })),
    warnings,
    errors,
  };

  progress({ phase: "writing-files", message: "Writing SEO JSON, full data JSON, and raw metadata.", url: page.finalUrl });
  const raw = await writeRaw(run, page.html, meta.raw);
  const seoJsonPath = await writeSeoData(run, seoSnapshot);

  const dataJsonPath = path.join(run.runDir, "data.json");
  const result: ProductCheckResult = {
    kind: "product",
    inputUrl,
    finalUrl: page.finalUrl,
    domain: hostname,
    checkedAt,
    seo: {
      title: meta.seo.title,
      description: meta.seo.description,
      canonicalUrl: meta.seo.canonicalUrl,
      openGraph: meta.seo.openGraph,
      twitter: meta.seo.twitter,
    },
    seoSnapshot,
    product: {
      title: product.title,
      description: product.description,
      structuredData: product.structuredData,
    },
    images: {
      discovered,
      downloaded: images.downloaded,
      skipped: images.skipped,
      strategy: images.strategy,
    },
    files: {
      outputDir: run.runDir,
      dataJsonPath,
      seoJsonPath,
      rawHtmlPath: raw.rawHtmlPath,
      rawMetadataPath: raw.rawMetadataPath,
    },
    warnings,
    errors,
  };

  await writeData(run, result);

  const fileBaseUrl = `/files/runs/${run.runId}`;
  const dataUrl = `${fileBaseUrl}/data.json`;
  log.info("check complete", {
    finalUrl: page.finalUrl,
    downloaded: images.downloaded.length,
    runDir: run.runDir,
  });
  return { result, fileBaseUrl, dataUrl };
}

async function runCollectionCheck(
  inputUrl: string,
  hostname: string,
  page: LoadedPage,
  meta: ReturnType<typeof extractMetadata>,
  discoveredProductUrls: string[],
  session: BrowserSession,
  progress: ProgressReporter = () => {},
): Promise<ApiResult> {
  const products: CollectionProductResult[] = new Array(discoveredProductUrls.length);
  const warnings: string[] = [];
  const run = await createRun(sitesConfig.output.baseDir, hostname);

  progress({
    phase: "collection-discovered",
    message: `Discovered ${discoveredProductUrls.length} visible product URLs.`,
    url: page.finalUrl,
    total: discoveredProductUrls.length,
  });

  if (discoveredProductUrls.length === 0) {
    warnings.push("No visible product links were discovered on the collection page.");
  }

  if (discoveredProductUrls.length === sitesConfig.collections.maxProducts) {
    warnings.push(`Collection discovery stopped at ${sitesConfig.collections.maxProducts} products.`);
  }

  await runWithConcurrency(discoveredProductUrls, sitesConfig.scraping.concurrency, async (productUrl, index) => {
    const current = index + 1;
    progress({
      phase: "product-start",
      message: `Scraping product ${current} of ${discoveredProductUrls.length}.`,
      url: productUrl,
      current,
      total: discoveredProductUrls.length,
    });
    try {
      const productResult = await runSingleProductCheck(productUrl, progress, session);
      products[index] = {
        url: productUrl,
        success: true,
        result: productResult.result,
        fileBaseUrl: productResult.fileBaseUrl,
      };
      progress({
        phase: "product-complete",
        message: `Finished product ${current} of ${discoveredProductUrls.length}.`,
        url: productUrl,
        current,
        total: discoveredProductUrls.length,
      });
    } catch (err) {
      progress({
        phase: "product-failed",
        message: `Product ${current} failed: ${(err as Error).message}`,
        url: productUrl,
        current,
        total: discoveredProductUrls.length,
      });
      if (err instanceof CheckError) {
        products[index] = {
          url: productUrl,
          success: false,
          error: { code: err.code, message: err.message },
        };
      } else {
        products[index] = {
          url: productUrl,
          success: false,
          error: {
            code: "UNKNOWN_ERROR",
            message: (err as Error).message || "An unexpected error occurred.",
          },
        };
      }
    }
  });

  const succeeded = products.filter((product) => product.success).length;
  const failed = products.length - succeeded;
  const result: CollectionCheckResult = {
    kind: "collection",
    inputUrl,
    finalUrl: page.finalUrl,
    domain: hostname,
    checkedAt: new Date().toISOString(),
    discoveredProductUrls,
    products,
    summary: {
      discovered: discoveredProductUrls.length,
      succeeded,
      failed,
    },
    warnings,
    errors: [],
  };

  log.info("collection check complete", {
    finalUrl: page.finalUrl,
    discovered: discoveredProductUrls.length,
    succeeded,
    failed,
  });
  await writeRaw(run, page.html, meta.raw);
  await writeData(run, result);

  const fileBaseUrl = `/files/runs/${run.runId}`;
  const dataUrl = `${fileBaseUrl}/data.json`;
  return { result, fileBaseUrl, dataUrl };
}

function collectFieldWarnings(
  meta: ReturnType<typeof extractMetadata>,
  product: ReturnType<typeof extractProduct>,
  warnings: string[],
): void {
  for (const f of [
    meta.seo.title,
    meta.seo.description,
    meta.seo.canonicalUrl,
    product.title,
    product.description,
  ]) {
    for (const w of f.warnings) warnings.push(w);
  }
}

export function registerCheckProductRoute(app: FastifyInstance): void {
  app.get("/api/check-progress/:runId", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: "Invalid runId." });
    attachProgressClient(params.data.runId, reply);
  });

  app.post("/api/check-product", { preHandler: requireApiKeyAuth }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: {
          code: "INVALID_URL" satisfies ErrorCode,
          message: parsed.error.issues[0]?.message ?? "Invalid request body.",
        },
      });
    }

    const progress = createProgressReporter(parsed.data.runId);
    try {
      progress({ phase: "queued", message: "Check request accepted.", url: parsed.data.url });
      const { result, fileBaseUrl, dataUrl } = await runCheck(parsed.data.url, progress, parsed.data.maxPages);
      if (parsed.data.responseMode === "url") {
        return reply.send({
          success: true,
          kind: result.kind,
          fileBaseUrl,
          dataUrl,
          ...(result.kind === "collection" ? { summary: result.summary } : {}),
        });
      }
      return reply.send({ success: true, result, fileBaseUrl, dataUrl });
    } catch (err) {
      if (err instanceof CheckError) {
        const status = err.code === "DOMAIN_NOT_ALLOWED" || err.code === "INVALID_URL" ? 400 : 502;
        log.warn("check failed", { code: err.code, message: err.message });
        progress({ phase: "failed", message: err.message });
        return reply.status(status).send({
          success: false,
          error: { code: err.code, message: err.message },
        });
      }
      log.error("unexpected error", { message: (err as Error).message });
      progress({ phase: "failed", message: (err as Error).message || "An unexpected error occurred." });
      return reply.status(500).send({
        success: false,
        error: {
          code: "UNKNOWN_ERROR" satisfies ErrorCode,
          message: (err as Error).message || "An unexpected error occurred.",
        },
      });
    } finally {
      finishProgress(parsed.data.runId);
    }
  });
}
