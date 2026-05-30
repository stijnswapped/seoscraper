/**
 * A minimal FIFO async semaphore: at most `max` holders run concurrently;
 * extra callers wait in arrival order until a permit is released.
 *
 * Used to cap how many headless Chromium processes can be alive at once across
 * all in-flight requests (one runaway browser per request OOM-kills the box).
 */
export class Semaphore {
  private readonly max: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
  }

  /** Acquire a permit, waiting if all are in use. */
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  /** Release a permit and hand it to the next waiter (if any). */
  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Run `fn` while holding a permit, releasing it even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
