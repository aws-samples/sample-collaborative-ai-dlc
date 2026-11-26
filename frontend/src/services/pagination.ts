// Lists the server answers one provider page at a time (`?page=N` →
// `{ <rows>, nextPage }`), so no request waits on a whole list behind the API
// Gateway timeout. The browser asks for each page in turn.

export interface ListPage<T> {
  rows: T[];
  // Absent from a server that predates paging: treated as the last page.
  nextPage?: number | null;
}

// 1,000 rows at the provider's 100 per page.
export const MAX_LIST_PAGES = 10;
export const MAX_LIST_ROWS = MAX_LIST_PAGES * 100;

/**
 * Yields each page in order until the server reports no next page or
 * `maxPages` pages were read. `done` is true on the last page of the list;
 * when the cap stops the reading, the final page has `done: false`.
 */
export async function* readListPages<T>(
  fetchPage: (page: number) => Promise<ListPage<T>>,
  maxPages = MAX_LIST_PAGES,
): AsyncGenerator<{ rows: T[]; done: boolean }> {
  let page: number | null = 1;
  for (let read = 0; page !== null && read < maxPages; read += 1) {
    const result: ListPage<T> = await fetchPage(page);
    page = result.nextPage ?? null;
    yield { rows: result.rows, done: page === null };
  }
}

/**
 * Every page, read one request at a time. A failure on page 1 is thrown; a
 * failure on a later page keeps the rows already read, with `complete: false`,
 * as does stopping at the cap.
 */
export async function collectListPages<T>(
  fetchPage: (page: number) => Promise<ListPage<T>>,
  maxPages = MAX_LIST_PAGES,
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  let complete = false;
  let pagesRead = 0;
  try {
    for await (const page of readListPages(fetchPage, maxPages)) {
      pagesRead += 1;
      rows.push(...page.rows);
      complete = page.done;
    }
  } catch (error) {
    if (pagesRead === 0) throw error;
    complete = false;
  }
  return { rows, complete };
}
