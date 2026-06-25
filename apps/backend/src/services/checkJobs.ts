import { randomUUID } from "node:crypto";
import type { ApiResult } from "../routes/checkProduct.js";

/**
 * In-memory registry for detached /api/check-product runs.
 *
 * Railway's edge proxy hard-closes any HTTP request at 300s, so a check that
 * takes longer cannot be served on a single connection. Instead we run the work
 * detached, keyed by a `jobId`, and let the caller poll for the result. The
 * initiating POST awaits the job for {@link JOB_AWAIT_MS} (safely under 300s);
 * if it is still running it returns `202 pending` and the client polls
 * `GET /api/check-product/:runId`.
 *
 * Notes:
 *  - State lives in the backend process. With multiple replicas a poll can land
 *    on an instance that never saw the job; pin check traffic to one replica or
 *    move this map to Redis if you scale horizontally.
 *  - Jobs are deduped by `jobId`: a second submit with the same id attaches to
 *    the in-flight run instead of starting a new scrape (and is billed once, by
 *    the original submitter's `onSettle`).
 */

/** How long the initiating POST blocks before returning `202 pending`. */
export const JOB_AWAIT_MS = 250_000;

/** How long a finished job is retained so late polls can still read it. */
const RETENTION_MS = 10 * 60_000;

export type JobState =
  | { status: "running" }
  | { status: "done"; result: ApiResult }
  | { status: "error"; error: unknown };

interface JobRecord {
  jobId: string;
  ownerUserId: string | null;
  responseMode: "full" | "url" | undefined;
  startedAt: number;
  finishedAt?: number;
  settled: boolean;
  state: JobState;
  promise: Promise<unknown>;
  evictTimer?: ReturnType<typeof setTimeout>;
}

const jobs = new Map<string, JobRecord>();

export function generateJobId(): string {
  return `job_${randomUUID()}`;
}

export function getJob(jobId: string): JobRecord | undefined {
  return jobs.get(jobId);
}

export interface StartJobInput {
  jobId: string;
  ownerUserId: string | null;
  responseMode: "full" | "url" | undefined;
  /** The actual work. Wrap proxy context here so it stays active while detached. */
  run: () => Promise<ApiResult>;
  /** Invoked exactly once when the job settles (success or failure). */
  onSettle: (state: JobState) => void | Promise<void>;
}

/**
 * Returns the existing record for `jobId` if one is in flight or recently
 * finished, otherwise starts a new detached run. `onSettle` only fires for the
 * run this call actually started, guaranteeing single-charge semantics.
 */
export function startJob(input: StartJobInput): JobRecord {
  const existing = jobs.get(input.jobId);
  if (existing) return existing;

  const record: JobRecord = {
    jobId: input.jobId,
    ownerUserId: input.ownerUserId,
    responseMode: input.responseMode,
    startedAt: Date.now(),
    settled: false,
    state: { status: "running" },
    promise: Promise.resolve(),
  };

  record.promise = input
    .run()
    .then((result) => {
      record.state = { status: "done", result };
    })
    .catch((error) => {
      record.state = { status: "error", error };
    })
    .finally(() => {
      record.finishedAt = Date.now();
      scheduleEvict(record);
      if (!record.settled) {
        record.settled = true;
        void Promise.resolve(input.onSettle(record.state)).catch(() => {});
      }
    });

  jobs.set(input.jobId, record);
  return record;
}

/**
 * Resolves `{ done: true }` once the job settles, or `{ done: false }` after
 * `ms`. The timer is cleared on settle so it never lingers.
 */
export function awaitJob(record: JobRecord, ms: number): Promise<{ done: boolean }> {
  if (record.state.status !== "running") return Promise.resolve({ done: true });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ done: false }), ms);
    record.promise.then(
      () => {
        clearTimeout(timer);
        resolve({ done: true });
      },
      () => {
        clearTimeout(timer);
        resolve({ done: true });
      },
    );
  });
}

function scheduleEvict(record: JobRecord): void {
  if (record.evictTimer) clearTimeout(record.evictTimer);
  record.evictTimer = setTimeout(() => {
    jobs.delete(record.jobId);
  }, RETENTION_MS);
  // Don't keep the event loop alive solely for cleanup.
  record.evictTimer.unref?.();
}
