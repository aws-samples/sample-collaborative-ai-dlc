import { resolveRoute, type RouteCtx } from '@/routes/registry';
import {
  hashKey as queryKeyHash,
  type FetchQueryOptions as QueryOptions,
} from '@tanstack/react-query';
import { queryClient, querySessionOpen } from './queryClient';
import { onUserCacheEnded } from './persistentCache';
import { cancelPrefetch, canPreloadOnHover, foregroundNavigation, prefetchQuery } from './prefetch';

export type IntentTrigger = 'hover' | 'focus' | 'pointerdown' | 'touchstart' | 'idle';
export interface RoutePrefetchContext {
  user: RouteCtx['user'];
  currentHref: string;
}
export interface PrefetchHrefOptions {
  trigger?: IntentTrigger;
  user?: RouteCtx['user'];
  currentHref?: string;
}

let context: (() => RoutePrefetchContext) | undefined;
let navigation = 0;
let foregroundHref = '';

export function setRoutePrefetchContext(getContext: () => RoutePrefetchContext): () => void {
  foregroundNavigation(undefined, 0);
  navigation++;
  foregroundHref = '';
  context = getContext;
  return () => {
    if (context === getContext) context = undefined;
  };
}

// Search is significant (settings tabs); hash never changes the data being read.
const hrefKey = (href: string) => href.split('#')[0].replace(/\/(?=\?|$)/, '');

function resolve(href: string, user: RouteCtx['user']) {
  const route = resolveRoute(href);
  if (!route || (route.entry.requires === 'platformAdmin' && !user.isPlatformAdmin)) return;
  const ctx: RouteCtx = {
    params: route.params,
    search: route.search,
    user,
    peek: <T>(key: Parameters<RouteCtx['peek']>[0]) => queryClient.getQueryState<T>(key)?.data,
  };
  return { route, ctx };
}

function queryHashes(href: string, user: RouteCtx['user']): Set<string> {
  const target = resolve(href, user);
  if (!target) return new Set();
  const critical = target.route.entry.critical?.(target.ctx) ?? [];
  const data = critical.map((query) => target.ctx.peek(query.queryKey));
  const dependent = target.route.entry.dependent?.(target.ctx, data) ?? [];
  return new Set([...critical, ...dependent].map((query) => queryKeyHash(query.queryKey)));
}

/** Called before pointerdown warming and again on a committed router location. */
export function notifyNavigation(href: string, user: RouteCtx['user']): void {
  navigation += 1;
  foregroundHref = hrefKey(href);
  let keep = new Set<string>();
  try {
    keep = queryHashes(href, user);
  } catch {
    /* navigation must survive malformed cached data */
  }
  foregroundNavigation(keep);
}

export function cancelHrefPrefetch(href: string): void {
  const user = context?.().user ?? { isPlatformAdmin: false };
  for (const hash of queryHashes(href, user)) cancelPrefetch(hash);
}

/** Programmatic entry point for cmdk and non-DOM navigation affordances. */
export function prefetchHref(href: string, options: PrefetchHrefOptions = {}): void {
  try {
    executePrefetch(href, options);
  } catch {
    /* speculative descriptors must not break navigation */
  }
}

function preloadCode(route: NonNullable<ReturnType<typeof resolve>>['route']) {
  try {
    void route.preload().catch(() => undefined);
  } catch {
    /* optional code warming */
  }
}

function executePrefetch(href: string, options: PrefetchHrefOptions): void {
  if (!querySessionOpen) return;
  const active = context?.();
  const user = options.user ?? active?.user ?? { isPlatformAdmin: false };
  const current = options.currentHref ?? active?.currentHref ?? '';
  const trigger = options.trigger ?? 'hover';
  const imminent = trigger === 'pointerdown' || trigger === 'touchstart';
  const target = resolve(href, user);
  if (!target || hrefKey(href) === hrefKey(current)) return;
  if (!imminent && !canPreloadOnHover()) return;
  // Query freshness and in-flight sharing decide what is requested again.
  const key = hrefKey(href);
  const { route, ctx } = target;
  preloadCode(route);
  const heavy =
    typeof route.entry.heavy === 'function' ? route.entry.heavy(ctx) : route.entry.heavy;
  if (!canPreloadOnHover() || (heavy && !imminent)) return;
  const priority = trigger === 'idle' ? 'idle' : 'intent';
  const critical = route.entry.critical?.(ctx) ?? [];
  const visit = navigation;
  const dependencies = new Set<string>();
  const stillRelevant = () => querySessionOpen && (visit === navigation || key === foregroundHref);
  const dependent = () => {
    if (priority === 'idle' || !stillRelevant()) return;
    const data = critical.map((query) => {
      return queryClient.getQueryData(query.queryKey);
    });
    for (const query of route.entry.dependent?.(ctx, data) ?? []) {
      const hash = queryKeyHash(query.queryKey);
      if (dependencies.has(hash)) continue;
      dependencies.add(hash);
      prefetchQuery(query, { priority: 'intent' });
    }
  };
  const enqueue = (query: QueryOptions<any, any, any, any>) => {
    // Graph/audit/compiled are never idle, even if a future registry entry
    // accidentally includes one in an otherwise light target.
    if (
      priority === 'idle' &&
      (query.queryKey.includes('graph') ||
        query.queryKey.includes('audit') ||
        query.queryKey.includes('compiled'))
    )
      return;
    if (
      queryClient
        .getQueryCache()
        .find({ queryKey: query.queryKey })
        ?.isStaleByTime(typeof query.staleTime === 'number' ? query.staleTime : 30_000) === false
    ) {
      dependent();
      return;
    }
    prefetchQuery(query, { priority, onData: dependent });
  };
  for (const query of critical) enqueue(query);
  dependent();
}

onUserCacheEnded(() => {
  navigation += 1;
  foregroundHref = '';
});
