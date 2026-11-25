// The single route table of the authenticated shell. App.tsx renders its
// <Route>s from APP_ROUTES and the prefetch resolver reads the same array, so
// a route cannot exist without its page chunk entry. Login, the auth and
// OAuth callbacks, and redirects are deliberately not registered: callbacks
// have side effects and a redirect resolves to its target.
//
// Query descriptors here must come from the factories the pages read with
// (lib/intentEntry.ts, …), never from literal keys.

import type { ComponentType, LazyExoticComponent } from 'react';
import { matchPath } from 'react-router';
import type { QueryKey, FetchQueryOptions as QueryOptions } from '@tanstack/react-query';
import { knownQueryBytes, queryClient } from '@/lib/queryClient';
import { intentDetailQuery, intentCompiledQuery } from '@/lib/intentEntry';
import { projectIntentsQuery } from '@/hooks/useProjectsCache';
import { personalCredentialsQuery } from '@/lib/settingsQueries';
import type { IntentDetail } from '@/services/intents';
import { qk } from '@/lib/queryKeys';
import * as pages from './pages';

export interface RouteCtx {
  params: Readonly<Record<string, string | undefined>>;
  search: URLSearchParams;
  /** Cache-only reads (never fetch) for deciding what to warm. */
  peek: <T>(key: QueryKey) => T | undefined;
  user: { isPlatformAdmin: boolean };
}

export type RoutePage = LazyExoticComponent<ComponentType<object>> & {
  preload: () => Promise<unknown>;
};

export interface RouteEntry {
  /** React Router pattern. Listed specific first: the resolver takes the first match. */
  path: string;
  page: RoutePage;
  /** No chunk and no data warming for other users; rendered behind ProtectedRoute. */
  requires?: 'platformAdmin';
  /** Cheap reads needed for first paint, from the page's own factories. */
  critical?: (ctx: RouteCtx) => QueryOptions<any, any, any, any>[];
  /** Reads that need a critical result (e.g. a block body needs the block's hasBody). */
  dependent?: (ctx: RouteCtx, criticalData: unknown[]) => QueryOptions<any, any, any, any>[];
  /** true / predicate: chunk on hover, data only when navigation is imminent. */
  heavy?: boolean | ((ctx: RouteCtx) => boolean);
  /** Likely next hrefs from this page, for idle warming. At most 3. */
  idleNext?: (ctx: RouteCtx) => string[];
  /** Pages rendered in this page's Outlet; `path` relative, '' for the index. Chunk only. */
  children?: readonly { path: string; page: RoutePage }[];
}

const param = (ctx: RouteCtx, name: string): string => ctx.params[name] ?? '';

// The intent detail backs every intent page header, so it is critical for all.
const intentCritical = (ctx: RouteCtx): QueryOptions<any, any, any, any>[] => [
  intentDetailQuery(param(ctx, 'projectId'), param(ctx, 'intentId')),
];

// Also warmed by the detail query itself once a page reads it.
const intentDependent = (_ctx: RouteCtx, [detail]: unknown[]) =>
  (detail as IntentDetail | undefined)?.intent.workflowId
    ? [intentCompiledQuery(detail as IntentDetail)]
    : [];

const heavyIntent = (ctx: RouteCtx) =>
  knownQueryBytes(queryClient, qk.intentDetail(param(ctx, 'projectId'), param(ctx, 'intentId'))) >
  512 * 1024;

const intentSections = (ctx: RouteCtx) => {
  const base = `/space/${param(ctx, 'projectId')}/intent/${param(ctx, 'intentId')}`;
  return { work: base, overview: `${base}/observability`, graph: `${base}/graph` };
};

export const APP_ROUTES: readonly RouteEntry[] = [
  {
    path: '/dashboard',
    page: pages.Dashboard,
    // Portfolio lists are shell-owned and always warm.
  },
  {
    path: '/account/settings',
    page: pages.AccountSettings,
    critical: () => [personalCredentialsQuery()],
  },
  {
    path: '/admin',
    page: pages.PlatformAdmin,
    requires: 'platformAdmin',
  },
  {
    path: '/observability',
    page: pages.ObservabilityLayout,
  },
  {
    path: '/blocks',
    page: pages.BlockLibrary,
    requires: 'platformAdmin',
  },
  {
    path: '/blocks/:type/new',
    page: pages.BlockEditor,
    requires: 'platformAdmin',
  },
  {
    path: '/blocks/:type/:id',
    page: pages.BlockEditor,
    requires: 'platformAdmin',
  },
  {
    path: '/blocks/:type',
    page: pages.BlockLibrary,
    requires: 'platformAdmin',
  },
  {
    path: '/workflows',
    page: pages.WorkflowList,
    requires: 'platformAdmin',
  },
  {
    path: '/workflows/:workflowId',
    page: pages.WorkflowComposer,
    requires: 'platformAdmin',
  },
  {
    path: '/space/:projectId',
    page: pages.Project,
    critical: (ctx) => [projectIntentsQuery(param(ctx, 'projectId'))],
  },
  {
    path: '/space/:projectId/settings',
    page: pages.ProjectSettings,
  },
  {
    path: '/space/:projectId/intent/new',
    page: pages.NewIntentPage,
  },
  {
    path: '/space/:projectId/intent/:intentId/compose',
    page: pages.IntentComposePage,
    critical: intentCritical,
    dependent: intentDependent,
    heavy: heavyIntent,
  },
  {
    path: '/space/:projectId/intent/:intentId/graph',
    page: pages.IntentGraphPage,
    // The graph decodes to up to ~380 KB.
    heavy: true,
    critical: intentCritical,
  },
  {
    path: '/space/:projectId/intent/:intentId/observability',
    page: pages.IntentObservabilityPage,
    critical: intentCritical,
    dependent: intentDependent,
    heavy: heavyIntent,
    idleNext: (ctx) => {
      const { work, graph } = intentSections(ctx);
      return [work, graph];
    },
  },
  {
    path: '/space/:projectId/intent/:intentId/audit',
    page: pages.IntentAuditPage,
    critical: intentCritical,
    heavy: heavyIntent,
  },
  {
    path: '/space/:projectId/intent/:intentId/review/:humanTaskId',
    page: pages.IntentView,
    critical: intentCritical,
    dependent: intentDependent,
    heavy: heavyIntent,
    idleNext: (ctx) => {
      const { overview, graph } = intentSections(ctx);
      return [overview, graph];
    },
  },
  {
    path: '/space/:projectId/intent/:intentId',
    page: pages.IntentView,
    critical: intentCritical,
    dependent: intentDependent,
    heavy: heavyIntent,
    idleNext: (ctx) => {
      const { overview, graph } = intentSections(ctx);
      return [overview, graph];
    },
  },
  {
    // Retired v1 sprint pages: rendered for history, warmed as chunks only.
    path: '/space/:projectId/sprint/:sprintId',
    page: pages.SprintLayout,
    children: [
      { path: '', page: pages.InceptionPage },
      { path: 'construction', page: pages.ConstructionPage },
      { path: 'review', page: pages.ReviewPage },
      { path: 'agent', page: pages.AgentPage },
      { path: 'graph', page: pages.SprintGraph },
    ],
  },
];

export interface ResolvedRoute {
  /** The full pattern that matched (a child's includes its parent's path). */
  pattern: string;
  entry: RouteEntry;
  params: Readonly<Record<string, string | undefined>>;
  search: URLSearchParams;
  /** Loads every chunk the route renders (a child loads its layout too). */
  preload: () => Promise<unknown>;
}

interface FlatRoute {
  pattern: string;
  entry: RouteEntry;
  preload: () => Promise<unknown>;
}

// A child is a chunk-only entry of its own; its parent's descriptors describe
// the layout's index, not every child.
const FLAT_ROUTES: readonly FlatRoute[] = APP_ROUTES.flatMap((entry): FlatRoute[] => {
  if (!entry.children) return [{ pattern: entry.path, entry, preload: entry.page.preload }];
  return entry.children.map((child) => {
    const pattern = child.path ? `${entry.path}/${child.path}` : entry.path;
    return {
      pattern,
      entry: { path: pattern, page: child.page },
      preload: () => Promise.all([entry.page.preload(), child.page.preload()]),
    };
  });
});

// Only pathname matches are memoized: settings search params stay request-local.
const matches = new Map<string, Omit<ResolvedRoute, 'search'> | undefined>();

// Route params are interpolated by the existing services. Never let encoded
// separators/traversal turn an entity GET into a different (possibly mutating)
// endpoint. A real intent cannot use the reserved project-metrics endpoint.
function safeParams(params: Readonly<Record<string, string | undefined>>): boolean {
  try {
    return Object.entries(params).every(([name, value]) => {
      if (value === undefined) return true;
      const decoded = decodeURIComponent(value);
      return (
        !/[\\/?#%]/.test(decoded) &&
        decoded !== '.' &&
        decoded !== '..' &&
        !(name === 'intentId' && decoded === 'metrics')
      );
    });
  } catch {
    return false;
  }
}

/** Matches an app href (query and hash ignored for matching) to its registry entry. */
export function resolveRoute(href: string): ResolvedRoute | undefined {
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return undefined;
  const [pathname] = href.split(/[?#]/);
  const queryStart = href.indexOf('?');
  const search = new URLSearchParams(
    queryStart === -1 ? '' : href.slice(queryStart + 1).split('#')[0],
  );
  let resolved = matches.get(pathname);
  if (!matches.has(pathname)) {
    for (const route of FLAT_ROUTES) {
      const match = matchPath(route.pattern, pathname);
      if (match && safeParams(match.params)) {
        resolved = {
          pattern: route.pattern,
          entry: route.entry,
          params: match.params,
          preload: route.preload,
        };
        break;
      }
    }
  }
  matches.delete(pathname);
  matches.set(pathname, resolved);
  if (matches.size > 200) matches.delete(matches.keys().next().value!);
  return resolved ? { ...resolved, search } : undefined;
}

/** Warms the page chunk for `pathname`; resolves (never rejects) or returns undefined if unmapped. */
export function preloadRoute(pathname: string): Promise<void> | undefined {
  const route = resolveRoute(pathname);
  if (!route) return undefined;
  return route.preload().then(
    () => undefined,
    () => undefined,
  );
}
