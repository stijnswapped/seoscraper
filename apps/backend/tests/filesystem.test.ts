import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  sanitizeDomain,
  sanitizeSegment,
  extFromContentType,
  allocateRunDir,
} from "../src/utils/filesystem.js";

const TEST_BASE_DIR = path.resolve("output/.tmp/test-filesystem-runs");

describe("sanitizeDomain", () => {
  it("lowercases and keeps allowed chars", () => {
    expect(sanitizeDomain("SHOP.example.COM")).toBe("shop.example.com");
    expect(sanitizeDomain("my-shop123.com")).toBe("my-shop123.com");
  });

  it("replaces invalid chars with hyphens", () => {
    expect(sanitizeDomain("shop$example#com")).toBe("shop-example-com");
    expect(sanitizeDomain("sub_domain.com")).toBe("sub-domain.com");
  });

  it("collapses multiple hyphens and trims edges", () => {
    expect(sanitizeDomain("---shop.com---")).toBe("shop.com");
    expect(sanitizeDomain("..shop.com..")).toBe("shop.com");
    expect(sanitizeDomain("-.-shop.com.-.-")).toBe("shop.com");
  });

  it("defaults to unknown-domain when empty or invalid", () => {
    expect(sanitizeDomain("")).toBe("unknown-domain");
    expect(sanitizeDomain("!@#$")).toBe("unknown-domain");
  });
});

describe("sanitizeSegment", () => {
  it("sanitizes filenames", () => {
    expect(sanitizeSegment("Red Dress")).toBe("red-dress");
    expect(sanitizeSegment("Product_123_Extra!")).toBe("product_123_extra");
  });

  it("limits length to 40 characters", () => {
    const long = "a".repeat(100);
    expect(sanitizeSegment(long)).toBe("a".repeat(40));
  });

  it("uses fallback if empty", () => {
    expect(sanitizeSegment("", "fallback-val")).toBe("fallback-val");
    expect(sanitizeSegment("!!!", "default")).toBe("default");
  });
});

describe("extFromContentType", () => {
  it("resolves basic image types", () => {
    expect(extFromContentType("image/jpeg")).toBe("jpg");
    expect(extFromContentType("IMAGE/PNG")).toBe("png");
    expect(extFromContentType("image/webp")).toBe("webp");
    expect(extFromContentType("image/gif")).toBe("gif");
    expect(extFromContentType("image/avif")).toBe("avif");
    expect(extFromContentType("image/svg+xml")).toBe("svg");
  });

  it("defaults to jpg for unknown or empty", () => {
    expect(extFromContentType(undefined)).toBe("jpg");
    expect(extFromContentType("application/pdf")).toBe("jpg");
  });
});

describe("allocateRunDir", () => {
  beforeAll(async () => {
    await rm(TEST_BASE_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(TEST_BASE_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_BASE_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it("allocates a unique run folder under runs", async () => {
    const res = await allocateRunDir(TEST_BASE_DIR, "test-domain");
    expect(res.runId).toContain("test-domain");
    expect(res.runDir).toBe(path.join(TEST_BASE_DIR, "runs", res.runId));
  });

  it("allocates a new folder for every run on the same domain", async () => {
    const first = await allocateRunDir(TEST_BASE_DIR, "test-domain");
    const second = await allocateRunDir(TEST_BASE_DIR, "test-domain");
    expect(first.runId).not.toBe(second.runId);
    expect(first.runDir).not.toBe(second.runDir);
    expect(first.runDir).toContain(path.join("runs", ""));
    expect(second.runDir).toContain(path.join("runs", ""));
  });

  it("keeps the domain readable inside the run id", async () => {
    await mkdir(path.join(TEST_BASE_DIR, "runs"), { recursive: true });
    const res = await allocateRunDir(TEST_BASE_DIR, "shop.example.com");
    expect(res.runId).toMatch(/^\d{8}t\d{6}z-shop\.example\.com-[a-f0-9-]{8}$/);
  });
});
