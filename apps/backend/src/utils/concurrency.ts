/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 * Resolves when all items are processed. The worker handles its own errors.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index] as T, index);
    }
  });
  await Promise.all(workers);
}
