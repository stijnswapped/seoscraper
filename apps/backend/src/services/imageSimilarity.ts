import { createHash } from "node:crypto";
import sharp from "sharp";
import type {
  ImageSelectionStrategyReport,
  SkippedImage,
} from "../types/productCheck.js";
import type { SitesConfig } from "../../../../config/sites.config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("imageSimilarity");

// ---------------------------------------------------------------------------
// Feature extraction (the only part that touches sharp / pixels)
// ---------------------------------------------------------------------------

export interface ImageFeatures {
  sha256: string;
  width: number;
  height: number;
  /** Longest/shortest side ratio (always >= 1). */
  aspectRatio: number;
  hasAlpha: boolean;
  /** 64-bit difference hash as 16 hex chars. */
  dhash: string;
  /** 64-bit perceptual (DCT) hash as 16 hex chars. */
  phash: string;
  /** Normalized 32x32 grayscale, length 1024, values 0..255. */
  gray32: number[];
}

export interface CandidateImage {
  originalUrl: string;
  tempPath: string;
  filenameHint: string;
  bytes: number;
  contentType?: string;
  features: ImageFeatures;
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Build all deterministic features for one image from its raw bytes. */
export async function extractFeatures(buffer: Buffer): Promise<ImageFeatures> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const aspectRatio =
    width > 0 && height > 0 ? Math.max(width / height, height / width) : 1;

  const dRaw = await sharp(buffer)
    .removeAlpha()
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();

  const gRaw = await sharp(buffer)
    .removeAlpha()
    .grayscale()
    .resize(32, 32, { fit: "fill" })
    .raw()
    .toBuffer();

  const gray32 = Array.from(gRaw.subarray(0, 1024), (v) => v);

  return {
    sha256: sha256(buffer),
    width,
    height,
    aspectRatio,
    hasAlpha: meta.hasAlpha ?? false,
    dhash: dHashFromGrayscale(Array.from(dRaw.subarray(0, 72)), 9, 8),
    phash: pHashFromGray32(gray32),
    gray32,
  };
}

// ---------------------------------------------------------------------------
// Pure hashing + comparison math (unit-testable, no I/O)
// ---------------------------------------------------------------------------

/** dHash: compare each pixel to its right neighbour. Expects cols*rows grayscale. */
export function dHashFromGrayscale(
  gray: number[],
  cols: number,
  rows: number,
): string {
  let bits = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const left = gray[r * cols + c] ?? 0;
      const right = gray[r * cols + c + 1] ?? 0;
      bits += left < right ? "1" : "0";
    }
  }
  return bitsToHex(bits);
}

/** pHash via 2D DCT-II on a 32x32 grayscale, low-frequency 8x8 block vs median. */
export function pHashFromGray32(gray32: number[]): string {
  const N = 32;
  const M = 8;
  // Precompute cosine tables.
  const coeffs: number[] = [];
  for (let u = 0; u < M; u++) {
    for (let v = 0; v < M; v++) {
      let sum = 0;
      for (let x = 0; x < N; x++) {
        for (let y = 0; y < N; y++) {
          const px = gray32[x * N + y] ?? 0;
          sum +=
            px *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * N));
        }
      }
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      coeffs.push((cu * cv * sum) / 4);
    }
  }
  // Median of the low-freq coefficients excluding the DC term.
  const acTerms = coeffs.slice(1).slice().sort((a, b) => a - b);
  const median =
    acTerms.length % 2 === 0
      ? ((acTerms[acTerms.length / 2 - 1] ?? 0) + (acTerms[acTerms.length / 2] ?? 0)) / 2
      : acTerms[(acTerms.length - 1) / 2] ?? 0;
  let bits = "";
  for (let i = 0; i < 64; i++) {
    bits += (coeffs[i] ?? 0) > median ? "1" : "0";
  }
  return bitsToHex(bits);
}

function bitsToHex(bits: string): string {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two equal-length hex hashes (bit differences). */
export function hexHammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length) * 4;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i] ?? "0", 16) ^ parseInt(b[i] ?? "0", 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

/** Global single-window SSIM between two equal-length grayscale arrays. 0..1. */
export function ssim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i] ?? 0;
    meanB += b[i] ?? 0;
  }
  meanA /= n;
  meanB /= n;

  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }
  varA /= n - 1 || 1;
  varB /= n - 1 || 1;
  cov /= n - 1 || 1;

  const L = 255;
  const C1 = (0.01 * L) ** 2;
  const C2 = (0.03 * L) ** 2;
  const value =
    ((2 * meanA * meanB + C1) * (2 * cov + C2)) /
    ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
  return Math.max(0, Math.min(1, value));
}

/** Edge-map similarity from 32x32 grayscale. 0..1 (1 = identical silhouettes). */
export function edgeSimilarityGray32(a: number[], b: number[]): number {
  const ea = edgeMap32(a);
  const eb = edgeMap32(b);
  let same = 0;
  for (let i = 0; i < ea.length; i++) {
    if (ea[i] === eb[i]) same++;
  }
  return ea.length ? same / ea.length : 0;
}

/** Binary edge map via gradient magnitude thresholded at the mean. */
function edgeMap32(gray: number[]): number[] {
  const N = 32;
  const mags: number[] = new Array(N * N).fill(0);
  let mean = 0;
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      const i = x * N + y;
      const right = y < N - 1 ? gray[i + 1] ?? 0 : gray[i] ?? 0;
      const down = x < N - 1 ? gray[i + N] ?? 0 : gray[i] ?? 0;
      const gx = (right - (gray[i] ?? 0)) || 0;
      const gy = (down - (gray[i] ?? 0)) || 0;
      const m = Math.sqrt(gx * gx + gy * gy);
      mags[i] = m;
      mean += m;
    }
  }
  mean /= N * N;
  return mags.map((m) => (m > mean ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Selection / grouping (steps 1-5)
// ---------------------------------------------------------------------------

export interface SelectionInput {
  candidates: CandidateImage[];
  /** How many discovered images failed to download/process. */
  processingFailures: number;
  /** How many images were attempted (download stage). */
  totalAttempted: number;
}

export interface SelectionResult {
  kept: Array<{ candidate: CandidateImage; groupId: string; reason: string }>;
  skipped: SkippedImage[];
  strategy: ImageSelectionStrategyReport;
}

interface Group {
  id: string;
  rep: CandidateImage;
  members: CandidateImage[];
  reason: string;
}

export function selectImages(
  input: SelectionInput,
  config: SitesConfig["images"],
): SelectionResult {
  const skipped: SkippedImage[] = [];

  // --- Step 1: exact byte duplicates ---------------------------------------
  const seenSha = new Map<string, CandidateImage>();
  const afterExact: CandidateImage[] = [];
  for (const c of input.candidates) {
    const prior = seenSha.get(c.features.sha256);
    if (prior) {
      skipped.push({
        originalUrl: c.originalUrl,
        reason: "Exact byte-duplicate (identical SHA-256).",
        similarTo: prior.originalUrl,
        confidence: 1,
      });
    } else {
      seenSha.set(c.features.sha256, c);
      afterExact.push(c);
    }
  }

  // --- Step 2: conservative quality filter ---------------------------------
  const usable: CandidateImage[] = [];
  for (const c of afterExact) {
    const { width, height, aspectRatio } = c.features;
    if (width < config.minWidth || height < config.minHeight) {
      skipped.push({
        originalUrl: c.originalUrl,
        reason: `Below minimum dimensions (${width}x${height} < ${config.minWidth}x${config.minHeight}).`,
      });
      continue;
    }
    if (aspectRatio > config.maxAspectRatio) {
      skipped.push({
        originalUrl: c.originalUrl,
        reason: `Extreme aspect ratio (${aspectRatio.toFixed(2)} > ${config.maxAspectRatio}); likely a banner/sprite.`,
      });
      continue;
    }
    usable.push(c);
  }

  // --- Step 5 (early): failure-based fallback ------------------------------
  const failureRatio =
    input.totalAttempted > 0 ? input.processingFailures / input.totalAttempted : 0;

  if (config.fallbackToDownloadAllOnLowConfidence) {
    if (usable.length < 2) {
      return downloadAll(
        usable,
        skipped,
        usable.length === 0
          ? "No usable images after filtering."
          : "Fewer than 2 usable images; keeping all to avoid missing product views.",
      );
    }
    if (failureRatio > config.maxProcessingFailureRatio) {
      return downloadAll(
        usable,
        skipped,
        `Too many images failed processing (${input.processingFailures}/${input.totalAttempted}); keeping all usable images.`,
      );
    }
  }

  // --- Steps 3 & 4: perceptual grouping + layout comparison ----------------
  const groups: Group[] = [];
  let ambiguous = false;

  for (const c of usable) {
    let assigned: Group | null = null;

    for (const g of groups) {
      const dist = hexHammingDistance(c.features.dhash, g.rep.features.dhash);

      // Step 3: near-identical perceptual hash → same image (compression/size).
      if (dist <= config.perceptualHashMaxDistance) {
        assigned = g;
        break;
      }

      // Step 4: hashes differ — is it the same view (color-only) or different?
      const structural = ssim(c.features.gray32, g.rep.features.gray32);
      const edges = edgeSimilarityGray32(c.features.gray32, g.rep.features.gray32);

      const sameView =
        structural >= config.similarityThreshold &&
        edges >= config.edgeSimilarityThreshold;

      // Borderline structural similarity = we cannot tell confidently.
      const borderlineStruct = Math.abs(structural - config.similarityThreshold) <= 0.08;
      const borderlineEdge = Math.abs(edges - config.edgeSimilarityThreshold) <= 0.08;
      if (!sameView && borderlineStruct && borderlineEdge) ambiguous = true;

      if (sameView) {
        assigned = g;
        break;
      }
    }

    if (assigned) {
      assigned.members.push(c);
    } else {
      groups.push({
        id: `g${groups.length + 1}`,
        rep: c,
        members: [c],
        reason: "Distinct view (different pose/detail/crop/silhouette).",
      });
    }
  }

  // --- Step 5 (late): ambiguity fallback -----------------------------------
  if (ambiguous && config.fallbackToDownloadAllOnLowConfidence) {
    return downloadAll(
      usable,
      skipped,
      "Similarity scores were inconclusive for one or more pairs; keeping all usable images.",
    );
  }

  // Build selective result: keep one representative per group; skip members.
  const kept: SelectionResult["kept"] = [];
  for (const g of groups) {
    kept.push({ candidate: g.rep, groupId: g.id, reason: g.reason });
    for (const m of g.members) {
      if (m === g.rep) continue;
      skipped.push({
        originalUrl: m.originalUrl,
        reason: "Near-duplicate of group representative (same view).",
        similarTo: g.rep.originalUrl,
      });
    }
  }

  log.info("selective grouping complete", {
    groups: groups.length,
    kept: kept.length,
    skipped: skipped.length,
  });

  return {
    kept,
    skipped,
    strategy: {
      mode: "selective",
      reason: `Grouped ${usable.length} usable images into ${groups.length} distinct view(s).`,
      groups: groups.map((g) => ({
        groupId: g.id,
        representativeImage: g.rep.originalUrl,
        imageCount: g.members.length,
        reason: g.reason,
      })),
    },
  };
}

/** Fallback: keep every usable image, each as its own group. */
function downloadAll(
  usable: CandidateImage[],
  skipped: SkippedImage[],
  reason: string,
): SelectionResult {
  log.warn("download_all_fallback", { reason, kept: usable.length });
  const kept = usable.map((c, i) => ({
    candidate: c,
    groupId: `g${i + 1}`,
    reason: "Kept under download-all fallback.",
  }));
  return {
    kept,
    skipped,
    strategy: {
      mode: "download_all_fallback",
      reason,
      groups: kept.map((k) => ({
        groupId: k.groupId,
        representativeImage: k.candidate.originalUrl,
        imageCount: 1,
        reason: "Fallback: every valid image kept.",
      })),
    },
  };
}
