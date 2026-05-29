import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProductCheckResult,
  RawMetadata,
  SeoSnapshot,
} from "../types/productCheck.js";
import { CheckError } from "../types/productCheck.js";
import { allocateRunDir, sanitizeDomain } from "../utils/filesystem.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("outputWriter");

export interface RunPaths {
  runId: string;
  runDir: string;
  imagesDir: string;
  tempDir: string;
  rawDir: string;
}

/** Create and reserve the next run folder for a domain. */
export async function createRun(baseDir: string, hostname: string): Promise<RunPaths> {
  const domainSegment = sanitizeDomain(hostname);
  const absBase = path.resolve(baseDir);
  try {
    const { runId, runDir } = await allocateRunDir(absBase, domainSegment);
    const imagesDir = path.join(runDir, "images");
    const rawDir = path.join(runDir, "raw");
    const tempDir = path.join(runDir, ".tmp");
    await mkdir(imagesDir, { recursive: true });
    await mkdir(rawDir, { recursive: true });
    log.info("run allocated", { runDir, runId });
    return { runId, runDir, imagesDir, rawDir, tempDir };
  } catch (err) {
    throw new CheckError(
      "OUTPUT_WRITE_FAILED",
      `Could not allocate output folder: ${(err as Error).message}`,
    );
  }
}

/** Persist raw rendered HTML + raw metadata blob for debugging. */
export async function writeRaw(
  paths: RunPaths,
  html: string,
  rawMetadata: RawMetadata,
): Promise<{ rawHtmlPath: string; rawMetadataPath: string }> {
  try {
    const rawHtmlPath = path.join(paths.rawDir, "page.html");
    const rawMetadataPath = path.join(paths.rawDir, "metadata.json");
    await writeFile(rawHtmlPath, html, "utf8");
    await writeFile(rawMetadataPath, JSON.stringify(rawMetadata, null, 2), "utf8");
    return { rawHtmlPath, rawMetadataPath };
  } catch (err) {
    throw new CheckError(
      "OUTPUT_WRITE_FAILED",
      `Could not write raw files: ${(err as Error).message}`,
    );
  }
}

/** Write the final data.json. */
export async function writeData(
  paths: RunPaths,
  result: ProductCheckResult,
): Promise<string> {
  try {
    const dataJsonPath = path.join(paths.runDir, "data.json");
    await writeFile(dataJsonPath, JSON.stringify(result, null, 2), "utf8");
    return dataJsonPath;
  } catch (err) {
    throw new CheckError(
      "OUTPUT_WRITE_FAILED",
      `Could not write data.json: ${(err as Error).message}`,
    );
  }
}

export async function writeSeoData(
  paths: RunPaths,
  snapshot: SeoSnapshot,
): Promise<string> {
  try {
    const seoJsonPath = path.join(paths.runDir, "seo.json");
    await writeFile(seoJsonPath, JSON.stringify(snapshot, null, 2), "utf8");
    return seoJsonPath;
  } catch (err) {
    throw new CheckError(
      "OUTPUT_WRITE_FAILED",
      `Could not write seo.json: ${(err as Error).message}`,
    );
  }
}
