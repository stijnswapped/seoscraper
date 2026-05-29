import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Turn a hostname into a safe single path segment.
 * Keeps it readable: lowercased, only [a-z0-9.-], collapses the rest to "-".
 */
export function sanitizeDomain(hostname: string): string {
  const cleaned = hostname
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "unknown-domain";
}

/** Sanitize an arbitrary string into a safe filename segment (no extension dot logic). */
export function sanitizeSegment(input: string, fallback = "item"): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || fallback;
}

/**
 * Allocate a globally unique run folder under output/runs.
 * The run id includes timestamp + domain for readability and a short UUID
 * suffix for collision safety.
 */
export async function allocateRunDir(
  baseDir: string,
  domainSegment: string,
): Promise<{ runId: string; runDir: string; runsDir: string }> {
  const runsDir = path.join(baseDir, "runs");
  await mkdir(runsDir, { recursive: true });

  for (let attempt = 0; attempt < 100; attempt++) {
    const runId = createRunId(domainSegment);
    const runDir = path.join(runsDir, runId);
    try {
      await mkdir(runDir, { recursive: false });
      return { runId, runDir, runsDir };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not allocate a run directory after 100 attempts.");
}

function createRunId(domainSegment: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .toLowerCase();
  const suffix = randomUUID().slice(0, 8);
  return `${timestamp}-${domainSegment}-${suffix}`;
}

/** Pick a file extension from a content-type, defaulting to jpg. */
export function extFromContentType(contentType: string | undefined): string {
  if (!contentType) return "jpg";
  const ct = contentType.toLowerCase();
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("avif")) return "avif";
  if (ct.includes("svg")) return "svg";
  return "jpg";
}
