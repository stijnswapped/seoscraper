import { describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile, utimes, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupOldRuns } from "../src/services/storageMaintenance.js";

const bases: string[] = [];

async function makeRun(base: string, name: string, ageDays: number): Promise<void> {
  const dir = path.join(base, "runs", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "data.json"), "{}");
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  await utimes(dir, when, when);
}

afterEach(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
  bases.length = 0;
});

describe("cleanupOldRuns", () => {
  it("removes runs older than the cutoff and keeps fresh ones", async () => {
    const base = path.join(tmpdir(), `seoscrape-${randomUUID()}`);
    bases.push(base);
    await makeRun(base, "old-1", 10);
    await makeRun(base, "old-2", 8);
    await makeRun(base, "fresh", 1);

    const removed = await cleanupOldRuns(base, 7);

    expect(removed).toBe(2);
    expect(await readdir(path.join(base, "runs"))).toEqual(["fresh"]);
  });

  it("is a no-op when retention is disabled (<= 0) or runs dir is missing", async () => {
    const base = path.join(tmpdir(), `seoscrape-${randomUUID()}`);
    bases.push(base);
    await makeRun(base, "old", 100);

    expect(await cleanupOldRuns(base, 0)).toBe(0); // disabled
    expect(await readdir(path.join(base, "runs"))).toEqual(["old"]);
    expect(await cleanupOldRuns(path.join(base, "does-not-exist"), 7)).toBe(0);
  });
});
