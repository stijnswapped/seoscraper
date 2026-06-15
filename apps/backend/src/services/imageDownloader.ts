import { mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import type {
  DiscoveredImage,
  DownloadedImage,
  ImageSelectionStrategyReport,
  SkippedImage,
} from "../types/productCheck.js";
import { sitesConfig } from "../../../../config/sites.config.js";
import { createLogger } from "../utils/logger.js";
import { extFromContentType, sanitizeSegment } from "../utils/filesystem.js";
import { runWithConcurrency } from "../utils/concurrency.js";
import {
  extractFeatures,
  selectImages,
  type CandidateImage,
} from "./imageSimilarity.js";

const log = createLogger("imageDownloader");

export interface DownloadOutcome {
  downloaded: DownloadedImage[];
  skipped: SkippedImage[];
  strategy: ImageSelectionStrategyReport;
}

/**
 * Download candidate images to a temp dir, build deterministic features,
 * select a representative set, and persist the kept images into `imagesDir`.
 */
export async function downloadAndSelect(
  discovered: DiscoveredImage[],
  imagesDir: string,
  tempDir: string,
): Promise<DownloadOutcome> {
  const cfg = sitesConfig.images;
  await mkdir(tempDir, { recursive: true });
  await mkdir(imagesDir, { recursive: true });

  const candidates: Array<CandidateImage | null> = new Array(discovered.length).fill(null);
  const skipped: SkippedImage[] = [];
  let failures = 0;

  // --- Download + feature extraction --------------------------------------
  await runWithConcurrency(discovered, cfg.downloadConcurrency, async (img, index) => {
    if (!img) return;
    try {
      const { buffer, contentType } = await fetchImage(img.normalizedUrl, cfg.maxBytesPerImage);
      const tempPath = path.join(tempDir, `cand-${String(index).padStart(3, "0")}`);
      await writeFile(tempPath, buffer);
      const features = await extractFeatures(buffer);
      candidates[index] = {
        originalUrl: img.normalizedUrl,
        tempPath,
        filenameHint: deriveLabel(img),
        bytes: buffer.byteLength,
        ...(contentType ? { contentType } : {}),
        features,
      };
    } catch (err) {
      failures++;
      skipped.push({
        originalUrl: img.normalizedUrl,
        reason: `Download/processing failed: ${(err as Error).message}`,
      });
      log.warn("image failed", { url: img.normalizedUrl, message: (err as Error).message });
    }
  });

  // --- Selection -----------------------------------------------------------
  const selection = selectImages(
    {
      candidates: candidates.filter((candidate): candidate is CandidateImage => candidate != null),
      processingFailures: failures,
      totalAttempted: discovered.length,
    },
    cfg,
  );

  // --- Persist kept images -------------------------------------------------
  const downloaded: DownloadedImage[] = [];
  let n = 0;
  for (const item of selection.kept) {
    n++;
    const c = item.candidate;
    const ext = extFromContentType(c.contentType);
    const label = n === 1 ? "main" : c.filenameHint;
    const filename = `${String(n).padStart(3, "0")}-${label}.${ext}`;
    const dest = path.join(imagesDir, filename);
    try {
      await copyFile(c.tempPath, dest);
      downloaded.push({
        originalUrl: c.originalUrl,
        filePath: path.join("images", filename),
        filename,
        bytes: c.bytes,
        width: c.features.width,
        height: c.features.height,
        sha256: c.features.sha256,
        perceptualHash: c.features.phash,
        groupId: item.groupId,
        reason: item.reason,
      });
    } catch (err) {
      skipped.push({
        originalUrl: c.originalUrl,
        reason: `Failed to write image to output: ${(err as Error).message}`,
      });
    }
  }

  // --- Cleanup temp --------------------------------------------------------
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});

  log.info("download+select complete", {
    discovered: discovered.length,
    downloaded: downloaded.length,
    skipped: selection.skipped.length + skipped.length,
    mode: selection.strategy.mode,
  });

  return {
    downloaded,
    skipped: [...skipped, ...selection.skipped],
    strategy: selection.strategy,
  };
}

/**
 * Fetch an image with a byte cap and a timeout.
 *
 * Intentionally a DIRECT `fetch` (never `proxyFetch`): product-image CDNs don't
 * IP-block the way storefront HTML does, and images are by far the heaviest
 * payload — routing them through a metered residential proxy would dominate the
 * bandwidth bill for no benefit. Keep this direct.
 */
async function fetchImage(
  url: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; contentType?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), sitesConfig.browser.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": sitesConfig.browser.userAgent },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? undefined;
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > maxBytes) {
      throw new Error(`Image exceeds max size (${arrayBuf.byteLength} > ${maxBytes}).`);
    }
    return { buffer: Buffer.from(arrayBuf), ...(contentType ? { contentType } : {}) };
  } finally {
    clearTimeout(timeout);
  }
}

/** Build a short readable filename label from alt text, URL, or source. */
function deriveLabel(img: DiscoveredImage): string {
  if (img.alt) {
    const fromAlt = sanitizeSegment(img.alt, "");
    if (fromAlt) return fromAlt;
  }
  try {
    const base = path.basename(new URL(img.normalizedUrl).pathname);
    const noExt = base.replace(/\.[a-z0-9]+$/i, "");
    const fromUrl = sanitizeSegment(noExt, "");
    if (fromUrl) return fromUrl;
  } catch {
    // ignore
  }
  return sanitizeSegment(img.source, "image");
}
