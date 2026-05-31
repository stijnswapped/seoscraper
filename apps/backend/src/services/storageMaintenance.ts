import { readdir, stat, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { sitesConfig } from "../../../../config/sites.config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("storageMaintenance");

let timer: NodeJS.Timeout | null = null;

/** Read-only snapshot of disk usage: run-folder count + volume free/total bytes. */
export async function getStorageStats(
  baseDir: string,
): Promise<{ runs: number; freeBytes: number | null; totalBytes: number | null; usedPct: number | null }> {
  let runs = 0;
  try {
    runs = (await readdir(path.join(baseDir, "runs"))).length;
  } catch {
    /* runs dir not created yet */
  }
  let freeBytes: number | null = null;
  let totalBytes: number | null = null;
  try {
    const fs = await statfs(baseDir);
    freeBytes = fs.bsize * fs.bavail;
    totalBytes = fs.bsize * fs.blocks;
  } catch {
    /* statfs unavailable */
  }
  const usedPct =
    totalBytes && freeBytes != null ? Math.round((1 - freeBytes / totalBytes) * 100) : null;
  return { runs, freeBytes, totalBytes, usedPct };
}

/**
 * Delete on-disk research runs (rendered HTML + images + JSON) older than
 * `maxAgeDays`. Best-seller rank tracking writes nothing to disk, so this only
 * affects the heavy, low-volume research output. Returns the number of run
 * folders removed.
 */
export async function cleanupOldRuns(baseDir: string, maxAgeDays: number): Promise<number> {
  if (!(maxAgeDays > 0)) return 0;
  const runsDir = path.join(baseDir, "runs");
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return 0; // runs dir doesn't exist yet — nothing to clean
  }

  let removed = 0;
  for (const name of entries) {
    const dir = path.join(runsDir, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn("could not clean run", { dir, message: (err as Error).message });
    }
  }

  if (removed > 0) log.info("cleaned old runs", { removed, maxAgeDays });
  return removed;
}

/**
 * Hard cap on the number of retained run folders: keep the newest `maxRuns` and
 * delete the oldest beyond that. This bounds disk regardless of age — the
 * age-based TTL can't keep up with a burst of research scrapes, but this can.
 * Returns the number removed.
 */
export async function enforceMaxRuns(baseDir: string, maxRuns: number): Promise<number> {
  if (!(maxRuns > 0)) return 0;
  const runsDir = path.join(baseDir, "runs");
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return 0;
  }
  if (entries.length <= maxRuns) return 0;

  const withTime: Array<{ name: string; t: number }> = [];
  for (const name of entries) {
    try {
      const info = await stat(path.join(runsDir, name));
      if (info.isDirectory()) withTime.push({ name, t: info.mtimeMs });
    } catch {
      /* ignore */
    }
  }
  withTime.sort((a, b) => a.t - b.t); // oldest first
  const doomed = withTime.slice(0, Math.max(0, withTime.length - maxRuns));
  let removed = 0;
  for (const d of doomed) {
    try {
      await rm(path.join(runsDir, d.name), { recursive: true, force: true });
      removed++;
    } catch {
      /* ignore */
    }
  }
  if (removed > 0) log.info("enforced max run count", { removed, maxRuns });
  return removed;
}

/**
 * Delete ALL research run folders under `output/runs` regardless of age. For
 * one-off recovery (e.g. the volume filled up). Returns the number removed.
 */
export async function purgeAllRuns(baseDir: string): Promise<number> {
  const runsDir = path.join(baseDir, "runs");
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    try {
      await rm(path.join(runsDir, name), { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn("could not purge run", { name, message: (err as Error).message });
    }
  }
  log.info("purged all runs", { removed });
  return removed;
}

/**
 * Run the cleanup once now and then on a repeating interval. Safe to call at
 * startup; the interval is unref'd so it never keeps the process alive.
 */
export function startStorageCleanup(): void {
  if (timer) return;
  const { baseDir, retentionDays, cleanupIntervalMs, maxRuns } = sitesConfig.output;
  const sweep = async () => {
    try {
      await cleanupOldRuns(baseDir, retentionDays);
      await enforceMaxRuns(baseDir, maxRuns);
    } catch (err) {
      log.warn("cleanup sweep failed", { message: (err as Error).message });
    }
  };
  void sweep();
  timer = setInterval(() => void sweep(), cleanupIntervalMs);
  timer.unref?.();
}
