import { useState } from "react";

/** One page of a list loaded by cursor. */
export interface ListPage<Item> {
  shares: Item[];
  /** Undefined on the last page. */
  nextCursor: string | undefined;
}

/** A page a fetcher loaded, with the cursor it was asked for. */
export interface CursorPage<Item> {
  cursor: string;
  page: ListPage<Item>;
}

interface AppendedPages<Item> {
  firstPage: ListPage<Item>;
  shares: Item[];
  nextCursor: string | undefined;
}

function startPages<Item>(firstPage: ListPage<Item>): AppendedPages<Item> {
  return { firstPage, shares: firstPage.shares, nextCursor: firstPage.nextCursor };
}

/**
 * A list loaded by pages: the loader's first page, then each next page appended
 *
 * A new `firstPage`, such as a loader run for other filters, starts the list over. `nextPage` is appended once, and
 * only when it was loaded for the list's current cursor, so a page loaded for an earlier list is ignored. An item listed
 * again between two pages keeps its first place.
 */
export function useAppendedPages<Item extends { id: string }>(
  firstPage: ListPage<Item>,
  nextPage: CursorPage<Item> | undefined,
): { shares: Item[]; nextCursor: string | undefined } {
  const [pages, setPages] = useState(() => startPages(firstPage));

  if (pages.firstPage !== firstPage) {
    const restarted = startPages(firstPage);

    setPages(restarted);

    return restarted;
  }

  if (nextPage !== undefined && nextPage.cursor === pages.nextCursor) {
    const seen = new Set(pages.shares.map((item) => item.id));
    const appended = {
      firstPage,
      shares: [...pages.shares, ...nextPage.page.shares.filter((item) => !seen.has(item.id))],
      nextCursor: nextPage.page.nextCursor,
    };

    setPages(appended);

    return appended;
  }

  return pages;
}
