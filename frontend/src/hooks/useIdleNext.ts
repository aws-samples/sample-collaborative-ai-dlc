// Idle "next likely page" (site-prefetch §5): once per route visit, after the
// page's own critical reads have settled, warm the registry's `idleNext`
// targets and then the shell's offered rows. Code for up to three targets,
// data for at most two at idle priority. Skipped at more
// than 50 % of the inactive cache budget, under Save-Data / 2g, on low-memory
// devices and while the tab is hidden (canPrefetchAtIdle, checked at fire time).

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import {
  idleCandidates,
  offerIdleCandidates,
  onIdleCandidates,
  type IdleSource,
} from '@/lib/idleCandidates';
import { afterQueriesSettle, runAtIdle } from '@/lib/prefetch';
import { queryClient, type QueryOptions } from '@/lib/queryClient';
import { hrefWantsData, prefetchHref, preloadHref } from '@/lib/routePrefetch';
import { resolveRoute, type RouteCtx } from '@/routes/registry';

const DATA_CAP = 2;
const MAX_TARGETS = 3;

const noop = () => {};

/** Starts the idle-next pass for the visit to `href`; returns its cancel. */
export function startIdleNext(href: string, user: RouteCtx['user']): () => void {
  const route = resolveRoute(href);
  if (!route || (route.entry.requires === 'platformAdmin' && !user.isPlatformAdmin)) return noop;
  const ctx: RouteCtx = {
    params: route.params,
    search: route.search,
    user,
    peek: <T>(key: Parameters<RouteCtx['peek']>[0]) => queryClient.getQueryState<T>(key)?.data,
  };
  const seen = new Set<string>();
  let dataTargets = 0;
  let settled = false;
  let cancelIdle: (() => void) | undefined;

  const pass = () => {
    let hrefs: string[] = [];
    try {
      hrefs = [...(route.entry.idleNext?.(ctx) ?? []), ...idleCandidates('shell')];
    } catch {
      /* a malformed cached value must not break the page */
    }
    for (const next of hrefs) {
      if (seen.size >= MAX_TARGETS) break;
      if (seen.has(next) || next === href) continue;
      seen.add(next);
      if (dataTargets < DATA_CAP && hrefWantsData(next, user)) {
        dataTargets += 1;
        prefetchHref(next, { trigger: 'idle', user, currentHref: href });
      } else preloadHref(next, user);
    }
  };
  const schedule = () => {
    if (!settled || seen.size >= MAX_TARGETS) return;
    cancelIdle?.();
    cancelIdle = runAtIdle(pass);
  };

  let critical: QueryOptions<unknown>[] = [];
  try {
    critical = route.entry.critical?.(ctx) ?? [];
  } catch {
    /* no critical reads to wait for */
  }
  const cancelSettle = afterQueriesSettle(
    critical.map((query) => query.queryKey),
    () => {
      settled = true;
      schedule();
    },
  );
  // Rows that appear later (a list that renders after its data) join the
  // same visit until the target cap is reached; repeated offers are no-ops.
  const unsubscribe = onIdleCandidates(schedule);
  return () => {
    cancelSettle();
    unsubscribe();
    cancelIdle?.();
  };
}

/** Runs the idle-next pass once per pathname while a user is signed in. */
export function useIdleNext(signedIn: boolean, isPlatformAdmin: boolean): void {
  const location = useLocation();
  const href = useRef('');
  href.current = location.pathname + location.search;
  useEffect(() => {
    if (!signedIn) return;
    return startIdleNext(href.current, { isPlatformAdmin });
  }, [location.pathname, signedIn, isPlatformAdmin]);
}

/** Offers on-screen rows as idle-next candidates while mounted. */
export function useOfferIdleCandidates(source: IdleSource, hrefs: readonly string[]): void {
  const key = hrefs.join('\n');
  useEffect(() => (key ? offerIdleCandidates(source, key.split('\n')) : undefined), [source, key]);
}
