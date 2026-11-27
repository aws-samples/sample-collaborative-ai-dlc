// The single route table of the authenticated shell. App.tsx renders its
// <Route>s from APP_ROUTES, so a route cannot exist without its page chunk
// entry. Login, the auth and OAuth callbacks, and redirects are deliberately
// not registered: callbacks have side effects and a redirect resolves to its
// target.

import type { ComponentType, LazyExoticComponent } from 'react';
import { matchPath } from 'react-router';
import * as pages from './pages';

export type RoutePage = LazyExoticComponent<ComponentType<object>> & {
  preload: () => Promise<unknown>;
};

export interface RouteEntry {
  /** React Router pattern. Listed specific first: the resolver takes the first match. */
  path: string;
  page: RoutePage;
  /** Rendered behind ProtectedRoute. */
  requires?: 'platformAdmin';
  /** Pages rendered in this page's Outlet; `path` relative, '' for the index. Chunk only. */
  children?: readonly { path: string; page: RoutePage }[];
}

export const APP_ROUTES: readonly RouteEntry[] = [
  {
    path: '/dashboard',
    page: pages.Dashboard,
  },
  {
    path: '/browse-spaces',
    page: pages.BrowseSpaces,
  },
  {
    path: '/account/settings',
    page: pages.AccountSettings,
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
  },
  {
    path: '/space/:projectId/intent/:intentId/graph',
    page: pages.IntentGraphPage,
  },
  {
    path: '/space/:projectId/intent/:intentId/observability',
    page: pages.IntentObservabilityPage,
  },
  {
    path: '/space/:projectId/intent/:intentId/audit',
    page: pages.IntentAuditPage,
  },
  {
    path: '/space/:projectId/intent/:intentId/review/:humanTaskId',
    page: pages.IntentView,
  },
  {
    path: '/space/:projectId/intent/:intentId',
    page: pages.IntentView,
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

// A child resolves to an entry of its own; preloading it loads the layout too.
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
      if (match) {
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
