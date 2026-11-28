// Likely next hrefs offered by what is on screen: a page's visible list rows
// ('page') and the shell's sidebar ('shell'). Registry `idleNext` entries and
// useIdleNext read them; nothing here fetches.

export type IdleSource = 'page' | 'shell';

const offers = new Map<symbol, { source: IdleSource; hrefs: readonly string[] }>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** Publishes `hrefs` until the returned function withdraws them. */
export function offerIdleCandidates(source: IdleSource, hrefs: readonly string[]): () => void {
  const id = Symbol(source);
  offers.set(id, { source, hrefs });
  notify();
  return () => {
    if (offers.delete(id)) notify();
  };
}

/** Offered hrefs of one source, first offer first, without duplicates. */
export function idleCandidates(source: IdleSource): string[] {
  const hrefs = new Set<string>();
  for (const offer of offers.values())
    if (offer.source === source) for (const href of offer.hrefs) hrefs.add(href);
  return [...hrefs];
}

export function onIdleCandidates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
