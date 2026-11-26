import { beforeEach, describe, expect, it, vi } from 'vitest';

const pages = vi.hoisted(() => {
  const names = [
    'AppShell',
    'SprintLayout',
    'Dashboard',
    'Project',
    'ProjectSettings',
    'IntentView',
    'InceptionPage',
    'ConstructionPage',
    'ReviewPage',
    'AgentPage',
    'SprintGraph',
    'GitOAuthCallback',
    'JiraCallback',
    'PlatformAdmin',
    'ObservabilityLayout',
    'BlockLibrary',
    'BlockEditor',
    'WorkflowList',
    'WorkflowComposer',
    'NewIntentPage',
    'IntentComposePage',
    'IntentObservabilityPage',
    'IntentGraphPage',
    'IntentAuditPage',
    'AccountSettings',
    'NotFound',
  ] as const;
  return Object.fromEntries(
    names.map((name) => [name, { displayName: name, preload: vi.fn(() => Promise.resolve()) }]),
  ) as Record<(typeof names)[number], { displayName: string; preload: ReturnType<typeof vi.fn> }>;
});
vi.mock('./pages', () => pages);

import { APP_ROUTES, preloadRoute, resolveRoute } from './registry';

const pageName = (href: string) =>
  (resolveRoute(href)?.entry.page as unknown as { displayName: string } | undefined)?.displayName;

beforeEach(() => {
  for (const page of Object.values(pages)) {
    page.preload.mockReset().mockImplementation(() => Promise.resolve());
  }
});

describe('APP_ROUTES', () => {
  it('keeps the shell route table (paths and admin gating) unchanged', () => {
    expect(
      APP_ROUTES.map((entry) => [
        entry.path,
        (entry.page as unknown as { displayName: string }).displayName,
        entry.requires ?? null,
        entry.children?.map((child) => [
          child.path,
          (child.page as unknown as { displayName: string }).displayName,
        ]) ?? null,
      ]),
    ).toEqual([
      ['/dashboard', 'Dashboard', null, null],
      ['/account/settings', 'AccountSettings', null, null],
      ['/admin', 'PlatformAdmin', 'platformAdmin', null],
      ['/observability', 'ObservabilityLayout', null, null],
      ['/blocks', 'BlockLibrary', 'platformAdmin', null],
      ['/blocks/:type/new', 'BlockEditor', 'platformAdmin', null],
      ['/blocks/:type/:id', 'BlockEditor', 'platformAdmin', null],
      ['/blocks/:type', 'BlockLibrary', 'platformAdmin', null],
      ['/workflows', 'WorkflowList', 'platformAdmin', null],
      ['/workflows/:workflowId', 'WorkflowComposer', 'platformAdmin', null],
      ['/space/:projectId', 'Project', null, null],
      ['/space/:projectId/settings', 'ProjectSettings', null, null],
      ['/space/:projectId/intent/new', 'NewIntentPage', null, null],
      ['/space/:projectId/intent/:intentId/compose', 'IntentComposePage', null, null],
      ['/space/:projectId/intent/:intentId/graph', 'IntentGraphPage', null, null],
      ['/space/:projectId/intent/:intentId/observability', 'IntentObservabilityPage', null, null],
      ['/space/:projectId/intent/:intentId/audit', 'IntentAuditPage', null, null],
      ['/space/:projectId/intent/:intentId/review/:humanTaskId', 'IntentView', null, null],
      ['/space/:projectId/intent/:intentId', 'IntentView', null, null],
      [
        '/space/:projectId/sprint/:sprintId',
        'SprintLayout',
        null,
        [
          ['', 'InceptionPage'],
          ['construction', 'ConstructionPage'],
          ['review', 'ReviewPage'],
          ['agent', 'AgentPage'],
          ['graph', 'SprintGraph'],
        ],
      ],
    ]);
  });
});

describe('resolveRoute', () => {
  it.each([
    ['/space/p1/intent/new', '/space/:projectId/intent/new', 'NewIntentPage'],
    ['/space/p1/intent/i1', '/space/:projectId/intent/:intentId', 'IntentView'],
    ['/blocks/stage/new', '/blocks/:type/new', 'BlockEditor'],
    ['/blocks/stage/s1', '/blocks/:type/:id', 'BlockEditor'],
    ['/blocks/agent', '/blocks/:type', 'BlockLibrary'],
    [
      '/space/p1/intent/i1/review/h1',
      '/space/:projectId/intent/:intentId/review/:humanTaskId',
      'IntentView',
    ],
  ])('resolves %s to the specific pattern %s', (href, pattern, page) => {
    expect(resolveRoute(href)?.pattern).toBe(pattern);
    expect(pageName(href)).toBe(page);
  });

  it('ignores the query and hash for matching but keeps the search params', () => {
    const route = resolveRoute('/space/p1/intent/i1/observability?tab=costs#top');
    expect(route?.pattern).toBe('/space/:projectId/intent/:intentId/observability');
    expect(route?.params).toEqual({ projectId: 'p1', intentId: 'i1' });
    expect(route?.search.get('tab')).toBe('costs');
    expect(resolveRoute('/dashboard#inbox')?.pattern).toBe('/dashboard');
  });

  it.each(['/nowhere', '/login', '/auth/callback', '/project/p1', '/', '/space/p1/intent/i1/x'])(
    'returns undefined for an unregistered path (%s)',
    (href) => {
      expect(resolveRoute(href)).toBeUndefined();
    },
  );

  it.each([
    ['/space/p1/sprint/s1', 'InceptionPage'],
    ['/space/p1/sprint/s1/construction', 'ConstructionPage'],
    ['/space/p1/sprint/s1/review', 'ReviewPage'],
    ['/space/p1/sprint/s1/agent', 'AgentPage'],
    ['/space/p1/sprint/s1/graph', 'SprintGraph'],
  ])('resolves the v1 sprint path %s to a chunk-only entry', async (href, page) => {
    const route = resolveRoute(href)!;
    expect(pageName(href)).toBe(page);
    await route.preload();
    expect(pages.SprintLayout.preload).toHaveBeenCalledTimes(1);
    expect(pages[page as keyof typeof pages].preload).toHaveBeenCalledTimes(1);
  });
});

describe('preloadRoute', () => {
  it('warms the matched page chunk only', async () => {
    await preloadRoute('/workflows/w1?libraryRelease=r1');
    expect(pages.WorkflowComposer.preload).toHaveBeenCalledTimes(1);
    expect(pages.WorkflowList.preload).not.toHaveBeenCalled();
  });

  it('never rejects when the chunk fails to load', async () => {
    pages.IntentView.preload.mockImplementation(() => Promise.reject(new Error('chunk')));
    await expect(preloadRoute('/space/p1/intent/i1')).resolves.toBeUndefined();
  });

  it('returns undefined for an unmapped path', () => {
    expect(preloadRoute('/nowhere')).toBeUndefined();
  });
});
