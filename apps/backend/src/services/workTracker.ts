/**
 * Counts scrape work that is running right now and that a process exit would
 * cut off halfway (currently /api/listings/track runs; check-product jobs are
 * tracked by the job registry). The browser self-restart uses it to wait for a
 * quiet moment instead of killing requests mid-flight.
 */
let active = 0;

/** Run `fn` while it counts as in-flight work. */
export async function trackWork<T>(fn: () => Promise<T>): Promise<T> {
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
  }
}

export function activeWorkCount(): number {
  return active;
}
