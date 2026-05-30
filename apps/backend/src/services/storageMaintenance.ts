import { readdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { sitesConfig } from "../../../../config/sites.config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("storageMaintenance");

let timer: NodeJS.Timeout | null = null;

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
  const { baseDir, retentionDays, cleanupIntervalMs } = sitesConfig.output;
  const sweep = () => {
    void cleanupOldRuns(baseDir, retentionDays).catch((err) =>
      log.warn("cleanup sweep failed", { message: (err as Error).message }),
    );
  };
  sweep();
  timer = setInterval(sweep, cleanupIntervalMs);
  timer.unref?.();
}
