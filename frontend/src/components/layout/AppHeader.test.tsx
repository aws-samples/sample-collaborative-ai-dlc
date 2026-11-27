import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';

const authState = vi.hoisted(() => ({
  user: {
    username: 'hector',
    displayName: 'Hector Sy',
    email: 'hector@example.com',
  },
  isPlatformAdmin: false,
  logout: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

// `insideProvider: false` runs the real hook with no IntentProvider mounted,
// which is how the header renders on /blocks/* and other non-intent routes.
const intentState = vi.hoisted(() => ({
  detail: null as unknown,
  notFound: false,
  insideProvider: true,
}));
vi.mock('@/contexts/IntentContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/IntentContext')>();
  return {
    ...actual,
    useIntentOptional: () =>
      intentState.insideProvider ? intentState : actual.useIntentOptional(),
  };
});

const projectState = vi.hoisted(() => ({ project: null as unknown }));
const cachedSummary = vi.hoisted(() => vi.fn((): unknown => undefined));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => projectState,
  useProjectSprintsCache: () => ({ sprints: [] }),
  getCachedIntentSummary: (...args: unknown[]) => cachedSummary(...(args as [])),
}));

const routePrefetch = vi.hoisted(() => ({
  prefetchHref: vi.fn(),
  preloadHref: vi.fn(),
}));
vi.mock('@/lib/routePrefetch', () => routePrefetch);

vi.mock('@/components/domain/PresenceAvatars', () => ({
  PresenceAvatars: () => null,
}));
vi.mock('@/components/theme/ThemeToggle', () => ({ ThemeToggle: () => null }));

import { AppHeader } from './AppHeader';

function renderHeader(path: string) {
  const header = (
    <AppHeader
      onToggleSidebar={() => {}}
      onToggleActivity={() => {}}
      onOpenCommand={() => {}}
      sidebarCollapsed={false}
      activityPanelOpen={false}
    />
  );
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/dashboard" element={header} />
          <Route path="/spaces" element={header} />
          <Route path="/space/:projectId" element={header} />
          <Route path="/space/:projectId/intent/new" element={header} />
          <Route path="/space/:projectId/intent/:intentId/compose" element={header} />
          <Route path="/observability" element={header} />
          <Route path="*" element={header} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  authState.isPlatformAdmin = false;
  projectState.project = { id: 'p1', name: 'retail-v2' };
  intentState.detail = {
    intent: { title: 'Add a promo code field', status: 'RUNNING' },
  };
  intentState.notFound = false;
  intentState.insideProvider = true;
  cachedSummary.mockReset().mockReturnValue(undefined);
  routePrefetch.prefetchHref.mockReset();
  routePrefetch.preloadHref.mockReset();
});

describe('AppHeader outside an IntentProvider (R3-4)', () => {
  it('renders on /blocks/artifact without an IntentProvider instead of throwing', () => {
    intentState.insideProvider = false;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHeader('/blocks/artifact')).not.toThrow();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'Block Library',
    );
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('AppHeader intent crumb before the detail is known (R3-1, R3-2)', () => {
  it('names a gone intent "Intent not found" in the trail', () => {
    intentState.detail = null;
    intentState.notFound = true;
    renderHeader('/space/p1/intent/i1/compose');
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('list');
    expect(within(trail).getByText('Intent not found')).toBeInTheDocument();
    expect(within(trail).queryByRole('link', { name: 'Intent not found' })).toBeNull();
    expect(trail).not.toHaveTextContent('Compose');
  });

  it('uses the cached list title while the detail loads', () => {
    intentState.detail = null;
    cachedSummary.mockReturnValue({
      id: 'i1',
      title: 'Cached promo title',
      status: 'WAITING',
    });
    renderHeader('/space/p1/intent/i1/compose');
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('list');
    expect(within(trail).getByRole('link', { name: 'Cached promo title' })).toBeInTheDocument();
  });
});

describe('AppHeader activity toggle', () => {
  it('announces whether the activity panel is open and which landmark it controls', () => {
    renderHeader('/space/p1/intent/i1/compose');

    const toggle = screen.getByRole('button', {
      name: 'Toggle activity panel',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'activity-panel');
  });
});

describe('AppHeader breadcrumb', () => {
  it('is a labelled navigation landmark whose last crumb is the current page', () => {
    renderHeader('/space/p1/intent/i1/compose');

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const trail = within(nav).getByRole('list');
    const links = within(trail).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Spaces',
      'retail-v2',
      'Add a promo code field',
    ]);
    expect(within(trail).getByRole('link', { name: 'retail-v2' })).toHaveAttribute(
      'href',
      '/space/p1',
    );
    const current = within(trail).getByText('Compose');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('offers one back link to the space for small screens on intent pages', () => {
    renderHeader('/space/p1/intent/i1/compose');

    const back = screen.getByRole('link', { name: 'Back to retail-v2' });
    expect(back).toHaveAttribute('href', '/space/p1');
    expect(back).toHaveTextContent('retail-v2');
    expect(back.className).toContain('sm:hidden');
  });

  it('falls back to the nearest parent when the page is not inside a space', () => {
    renderHeader('/space/p1');

    const back = screen.getByRole('link', { name: 'Back to Spaces' });
    expect(back).toHaveAttribute('href', '/dashboard');
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Spaces' })).toHaveAttribute('href', '/dashboard');
    within(nav)
      .getAllByText('retail-v2')
      .forEach((crumb) => expect(crumb).toHaveAttribute('aria-current', 'page'));
  });

  it('calls a placeholder-titled draft "Untitled draft", like the page does', () => {
    intentState.detail = { intent: { title: 'Title', status: 'DRAFT' } };
    renderHeader('/space/p1/intent/i1/compose');

    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('list');
    expect(within(trail).getByRole('link', { name: 'Untitled draft' })).toBeInTheDocument();
    expect(within(trail).queryByText('Title')).not.toBeInTheDocument();
  });

  it('names an unknown address instead of pretending to be Spaces', () => {
    renderHeader('/this-does-not-exist');

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getAllByText('Page not found').length).toBeGreaterThan(0);
    expect(within(nav).queryByText('Spaces')).not.toBeInTheDocument();
  });

  it('ends with "New intent" on the intent creation page', () => {
    renderHeader('/space/p1/intent/new');

    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('list');
    expect(
      within(trail)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Spaces', 'retail-v2']);
    expect(within(trail).getByText('New intent')).toHaveAttribute('aria-current', 'page');
    expect(within(trail).queryByText('Work')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to retail-v2' })).toHaveAttribute(
      'href',
      '/space/p1',
    );
  });

  it('shows Observability as a top-level page, not under Spaces', () => {
    renderHeader('/observability');

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
    expect(within(nav).queryByText('Spaces')).not.toBeInTheDocument();
    within(nav)
      .getAllByText('Observability')
      .forEach((crumb) => expect(crumb).toHaveAttribute('aria-current', 'page'));
  });

  it.each([
    ['/dashboard', 'Spaces'],
    ['/spaces', 'Spaces'],
    ['/my-work', 'My work'],
  ])('shows the page name alone when there is no parent: %s', (path, label) => {
    renderHeader(path);

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
    const crumbs = within(nav).getAllByText(label);
    crumbs.forEach((crumb) => expect(crumb).toHaveAttribute('aria-current', 'page'));
    expect(screen.queryByRole('link', { name: /^Back to/ })).not.toBeInTheDocument();
  });
});

describe('AppHeader search and logo', () => {
  it('names the search button by its visible label, with the shortcut hint hidden from AT', () => {
    renderHeader('/dashboard');

    const search = screen.getByRole('button', { name: 'Search' });
    expect(search).not.toHaveAttribute('aria-label');
    expect(search.querySelector('kbd')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Search')).toHaveClass('sr-only', 'sm:not-sr-only');
    expect(screen.queryByText('Search...')).not.toBeInTheDocument();
  });

  it('links the logo to Spaces and leaves the image decorative next to the wordmark text', () => {
    renderHeader('/space/p1');

    const home = screen.getByRole('link', { name: 'AI-DLC' });
    expect(home).toHaveAttribute('href', '/dashboard');
    expect(home.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.queryByRole('button', { name: 'AI-DLC' })).not.toBeInTheDocument();
  });

  it('keeps the small-screen back link at least 24 px tall', () => {
    renderHeader('/space/p1/intent/i1/compose');

    expect(screen.getByRole('link', { name: 'Back to retail-v2' })).toHaveClass('min-h-6');
  });
});

describe('AppHeader user menu', () => {
  it('offers account settings, and the admin panel only to admins', async () => {
    const user = userEvent.setup();
    renderHeader('/dashboard');

    await user.click(screen.getByRole('button', { name: 'User menu' }));

    expect(screen.getByRole('menuitem', { name: 'Account settings' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Admin panel' })).not.toBeInTheDocument();
  });

  it('keeps every shell text at or above the 11 px floor', () => {
    renderHeader('/dashboard');

    expect(document.querySelector('[class*="text-[10px]"]')).toBeNull();
    expect(screen.getByText('HS').className).toContain('text-2xs');
  });

  it('loads the settings chunks on open and marks each settings item for the listener', async () => {
    authState.isPlatformAdmin = true;
    const user = userEvent.setup();
    renderHeader('/dashboard');
    expect(routePrefetch.preloadHref).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'User menu' }));

    expect(routePrefetch.preloadHref.mock.calls.map(([href]) => href)).toEqual([
      '/account/settings',
      '/admin',
    ]);
    expect(screen.getByRole('menuitem', { name: 'Account settings' })).toHaveAttribute(
      'data-prefetch-href',
      '/account/settings',
    );
    expect(screen.getByRole('menuitem', { name: 'Admin panel' })).toHaveAttribute(
      'data-prefetch-href',
      '/admin',
    );
  });

  it('loads no admin chunk for a member', async () => {
    const user = userEvent.setup();
    renderHeader('/dashboard');
    await user.click(screen.getByRole('button', { name: 'User menu' }));
    expect(routePrefetch.preloadHref.mock.calls.map(([href]) => href)).toEqual([
      '/account/settings',
    ]);
  });

  it('starts the page reads before navigating when an item is chosen with the keyboard', async () => {
    authState.isPlatformAdmin = true;
    const user = userEvent.setup();
    renderHeader('/dashboard');
    await user.click(screen.getByRole('button', { name: 'User menu' }));
    screen.getByRole('menuitem', { name: 'Admin panel' }).focus();
    await user.keyboard('{Enter}');
    expect(routePrefetch.prefetchHref).toHaveBeenCalledWith('/admin', {
      trigger: 'pointerdown',
      user: { isPlatformAdmin: true },
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
