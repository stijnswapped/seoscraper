/**
 * A minimal FIFO async semaphore: at most `max` holders run concurrently;
 * extra callers wait in arrival order until a permit is released.
 *
 * Used to cap how many headless Chromium processes can be alive at once across
 * all in-flight requests (one runaway browser per request OOM-kills the box).
 *
 * A permit is *transferred* directly to the next waiter on release (rather than
 * decrement-then-reincrement), so the live count can never transiently exceed
 * `max` even if a fresh `acquire()` races a `release()`.
 */

/** Thrown by {@link Semaphore.acquire} when a permit isn't obtained within the timeout. */
export class SemaphoreAcquireTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for a permit.`);
    this.name = "SemaphoreAcquireTimeoutError";
  }
}

export class Semaphore {
  private readonly max: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  /**
   * Acquire a permit, waiting if all are in use. When `timeoutMs` is a positive
   * number and no permit frees up in time, rejects with
   * {@link SemaphoreAcquireTimeoutError} instead of waiting forever — this is
   * what stops a single wedged holder from parking every later caller in
   * permanent "pending". A caller that times out is removed from the queue and
   * never silently consumes a later release.
   */
  async acquire(timeoutMs?: number): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const grant = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        // Permit transferred to us by release(); active count is unchanged.
        resolve();
      };
      const timer =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              const i = this.waiters.indexOf(grant);
              if (i >= 0) this.waiters.splice(i, 1);
              reject(new SemaphoreAcquireTimeoutError(timeoutMs));
            }, timeoutMs)
          : undefined;
      // Cleanup timers must not keep the event loop alive on their own.
      timer?.unref?.();
      this.waiters.push(grant);
    });
  }

  /** Release a permit, handing it to the next waiter (if any) or freeing it. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the permit straight to the waiter — do NOT touch `active`, or the
      // waiter would double-count it.
      next();
    } else {
      this.active -= 1;
    }
  }

  /** Run `fn` while holding a permit, releasing it even if `fn` throws. */
  async run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
