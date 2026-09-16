export interface PaginationPage<TItem> {
  readonly items: readonly TItem[];
  readonly nextToken?: string;
}

export interface PaginateByTokenInput<TItem> {
  readonly fetchPage: (
    nextToken: string | undefined,
  ) => Promise<PaginationPage<TItem>>;
}

export async function* paginateByToken<TItem>(
  input: PaginateByTokenInput<TItem>,
): AsyncGenerator<TItem> {
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;

  do {
    const page = await input.fetchPage(nextToken);

    for (const item of page.items) {
      yield item;
    }

    nextToken = normalizeNextToken(page.nextToken);

    if (nextToken) {
      if (seenTokens.has(nextToken)) {
        throw new Error(`Pagination returned a repeated token: ${nextToken}`);
      }

      seenTokens.add(nextToken);
    }
  } while (nextToken);
}

function normalizeNextToken(nextToken: string | undefined): string | undefined {
  return nextToken && nextToken.length > 0 ? nextToken : undefined;
}
