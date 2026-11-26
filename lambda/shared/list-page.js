// `?page=N` asks a list endpoint for one provider page, answered as
// `{ <rows>, nextPage }`. Without it the endpoint answers as before.
//
// Returns undefined when the parameter is absent, null when it is not a
// positive integer, and the page number otherwise.
export const parsePageParam = (value) => {
  if (value === undefined || value === null) return undefined;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 ? page : null;
};

export const INVALID_PAGE_ERROR = 'page must be a positive integer';
