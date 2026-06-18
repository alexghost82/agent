// Bounded-concurrency map: runs `worker` over `items` with at most `limit`
// in-flight promises at a time. Keeps result order aligned to input order.
// In-house (no p-limit dependency) to keep the supply chain minimal.

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const max = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;

  async function run(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: max }, () => run()));
  return results;
}
