export const DEFAULT_READ_CONCURRENCY = 4;

export interface MapWithConcurrencyOptions {
  readonly concurrency?: number;
}

export async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<TResult>,
  options: MapWithConcurrencyOptions = {},
): Promise<TResult[]> {
  const concurrency = options.concurrency ?? DEFAULT_READ_CONCURRENCY;
  validateConcurrency(concurrency);

  if (items.length === 0) {
    return [];
  }

  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      if (!(index in items)) {
        throw new Error(`Missing concurrency input at index ${index}`);
      }

      results[index] = await mapper(items[index] as T, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () =>
      worker(),
    ),
  );

  return results;
}

export function validateConcurrency(concurrency: number): void {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("concurrency must be a positive integer");
  }
}
