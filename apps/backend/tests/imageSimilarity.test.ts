import { describe, it, expect } from "vitest";
import {
  hexHammingDistance,
  ssim,
  edgeSimilarityGray32,
  dHashFromGrayscale,
  pHashFromGray32,
  selectImages,
  type CandidateImage,
} from "../src/services/imageSimilarity.js";
import type { SitesConfig } from "../../../config/sites.config.js";

// Mock configuration helper
const mockImageConfig: SitesConfig["images"] = {
  minWidth: 300,
  minHeight: 300,
  maxImagesToProcess: 10,
  similarityThreshold: 0.88,
  perceptualHashMaxDistance: 8,
  fallbackToDownloadAllOnLowConfidence: true,
  maxBytesPerImage: 1024 * 1024,
  maxAspectRatio: 3.0,
  edgeSimilarityThreshold: 0.9,
  maxProcessingFailureRatio: 0.5,
  downloadConcurrency: 4,
};

let dummyId = 0;
function createDummyCandidate(overrides: Partial<CandidateImage> & { dhash?: string; sha256?: string; width?: number; height?: number; grayValue?: number } = {}): CandidateImage {
  dummyId++;
  const hexSuffix = String(dummyId).padStart(16, "0");
  const grayVal = overrides.grayValue ?? (dummyId * 50) % 255;
  return {
    originalUrl: overrides.originalUrl ?? `https://example.com/img-${dummyId}.jpg`,
    tempPath: overrides.tempPath ?? `/tmp/cand-${dummyId}.jpg`,
    filenameHint: overrides.filenameHint ?? `cand-${dummyId}`,
    bytes: overrides.bytes ?? 1000,
    features: {
      sha256: overrides.sha256 ?? `sha-${dummyId}`,
      width: overrides.width ?? 400,
      height: overrides.height ?? 400,
      aspectRatio: (overrides.width ?? 400) / (overrides.height ?? 400),
      hasAlpha: false,
      dhash: overrides.dhash ?? hexSuffix,
      phash: hexSuffix,
      gray32: overrides.features?.gray32 ?? new Array(1024).fill(grayVal),
      ...overrides.features,
    },
  };
}

describe("hexHammingDistance", () => {
  it("computes exact distance for matching hex strings", () => {
    expect(hexHammingDistance("0000", "0000")).toBe(0);
    expect(hexHammingDistance("ffff", "ffff")).toBe(0);
  });

  it("computes correct bit differences", () => {
    expect(hexHammingDistance("0", "1")).toBe(1);
    expect(hexHammingDistance("f", "0")).toBe(4);
    expect(hexHammingDistance("3", "c")).toBe(4);
    expect(hexHammingDistance("00f0", "0000")).toBe(4);
    expect(hexHammingDistance("ffff", "0000")).toBe(16);
  });

  it("handles length mismatch by returning maximum distance", () => {
    expect(hexHammingDistance("ff", "f")).toBe(8);
  });
});

describe("ssim", () => {
  it("returns 1 for identical arrays", () => {
    const arr = new Array(100).fill(128);
    expect(ssim(arr, arr)).toBeCloseTo(1.0);
  });

  it("returns lower similarity for different arrays", () => {
    const arrA = new Array(100).fill(100);
    const arrB = new Array(100).fill(200);
    expect(ssim(arrA, arrB)).toBeLessThan(1.0);
  });
});

describe("selectImages (Deduplication / Fallback Pipeline)", () => {
  it("filters out exact byte-duplicates by SHA-256", () => {
    const c1 = createDummyCandidate({ originalUrl: "https://x/1.jpg", sha256: "abc", dhash: "0000000000000000" });
    const c2 = createDummyCandidate({ originalUrl: "https://x/2.jpg", sha256: "abc", dhash: "ffffffffffffffff" }); // Dup SHA
    const c3 = createDummyCandidate({ originalUrl: "https://x/3.jpg", sha256: "def", dhash: "ffffffffffffffff" });

    const result = selectImages(
      { candidates: [c1, c2, c3], processingFailures: 0, totalAttempted: 3 },
      mockImageConfig,
    );

    expect(result.kept.map((k) => k.candidate.originalUrl)).toContain("https://x/1.jpg");
    expect(result.kept.map((k) => k.candidate.originalUrl)).toContain("https://x/3.jpg");
    expect(result.skipped.map((s) => s.originalUrl)).toContain("https://x/2.jpg");
    expect(result.skipped.find((s) => s.originalUrl === "https://x/2.jpg")?.reason).toContain("SHA-256");
  });

  it("skips images below minimum dimensions", () => {
    const c1 = createDummyCandidate({ originalUrl: "https://x/1.jpg", width: 400, height: 400, dhash: "0000000000000000" });
    const c2 = createDummyCandidate({ originalUrl: "https://x/2.jpg", width: 100, height: 100, dhash: "ffffffffffffffff" }); // Too small

    const result = selectImages(
      { candidates: [c1, c2], processingFailures: 0, totalAttempted: 2 },
      mockImageConfig,
    );

    expect(result.skipped.map((s) => s.originalUrl)).toContain("https://x/2.jpg");
    expect(result.skipped.find((s) => s.originalUrl === "https://x/2.jpg")?.reason).toContain("dimensions");
  });

  it("skips images with extreme aspect ratios", () => {
    const c1 = createDummyCandidate({ originalUrl: "https://x/1.jpg", width: 400, height: 400, dhash: "0000000000000000" });
    const c2 = createDummyCandidate({ originalUrl: "https://x/2.jpg", width: 1000, height: 310, dhash: "ffffffffffffffff" }); // Aspect ratio 3.22 > 3.0 (and both >= 300)

    const result = selectImages(
      { candidates: [c1, c2], processingFailures: 0, totalAttempted: 2 },
      mockImageConfig,
    );

    expect(result.skipped.map((s) => s.originalUrl)).toContain("https://x/2.jpg");
    expect(result.skipped.find((s) => s.originalUrl === "https://x/2.jpg")?.reason).toContain("aspect ratio");
  });

  it("groups near-identical images via perceptual hash (Hamming distance)", () => {
    const c1 = createDummyCandidate({ originalUrl: "https://x/1.jpg", dhash: "0000000000000000" });
    const c2 = createDummyCandidate({ originalUrl: "https://x/2.jpg", dhash: "0000000000000001" }); // Hamming dist 1 <= 8
    const c3 = createDummyCandidate({ originalUrl: "https://x/3.jpg", dhash: "ffffffffffffffff" }); // Hamming dist 64 > 8

    const result = selectImages(
      { candidates: [c1, c2, c3], processingFailures: 0, totalAttempted: 3 },
      mockImageConfig,
    );

    expect(result.strategy.mode).toBe("selective");
    expect(result.kept.map((k) => k.candidate.originalUrl)).toContain("https://x/1.jpg");
    expect(result.kept.map((k) => k.candidate.originalUrl)).toContain("https://x/3.jpg");
    expect(result.kept.map((k) => k.candidate.originalUrl)).not.toContain("https://x/2.jpg");
    expect(result.skipped.map((s) => s.originalUrl)).toContain("https://x/2.jpg");
  });

  it("triggers download_all_fallback when usable images are less than 2", () => {
    const c1 = createDummyCandidate({ originalUrl: "https://x/1.jpg", dhash: "0000000000000000" });

    const result = selectImages(
      { candidates: [c1], processingFailures: 0, totalAttempted: 1 },
      mockImageConfig,
    );

    expect(result.strategy.mode).toBe("download_all_fallback");
    expect(result.strategy.reason).toContain("usable");
    expect(result.kept).toHaveLength(1);
  });

  it("triggers download_all_fallback when too many downloads failed", () => {
    const c1 = createDummyCandidate({ originalUrl: "https://x/1.jpg", dhash: "0000000000000000" });
    const c2 = createDummyCandidate({ originalUrl: "https://x/2.jpg", dhash: "ffffffffffffffff" });

    // 3 failures out of 5 attempted = 60% failure ratio > 50% max limit
    const result = selectImages(
      { candidates: [c1, c2], processingFailures: 3, totalAttempted: 5 },
      mockImageConfig,
    );

    expect(result.strategy.mode).toBe("download_all_fallback");
    expect(result.strategy.reason).toContain("failed processing");
    expect(result.kept).toHaveLength(2);
  });
});
