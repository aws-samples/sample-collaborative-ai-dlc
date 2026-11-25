import { useState } from 'react';
import { render, screen, waitFor } from '@/test/query';
import userEvent from '@testing-library/user-event';
import {
  createMemoryRouter,
  Link,
  Route,
  Routes,
  RouterProvider,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { describe, expect, it } from 'vitest';
import { UnsavedChangesGuard, useUnsavedChangesGuard } from './UnsavedChangesGuard';

function Editor() {
  const [draft, setDraft] = useState('');
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  useUnsavedChangesGuard(draft.length > 0);

  return (
    <main>
      <h1>Workflow editor</h1>
      <label>
        Workflow name
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <button type="button" onClick={() => setSearchParams({ view: 'scopes' })}>
        Change editor view
      </button>
      <Link to="/dashboard">Dashboard</Link>
      <button type="button" onClick={() => navigate(-1)}>
        Browser back
      </button>
    </main>
  );
}

function renderGuardedRoutes(initialEntries: string[]) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <UnsavedChangesGuard>
            <Routes>
              <Route path="/workflows/demo" element={<Editor />} />
              <Route path="/dashboard" element={<h1>Spaces</h1>} />
            </Routes>
          </UnsavedChangesGuard>
        ),
      },
    ],
    { initialEntries },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('UnsavedChangesGuard', () => {
  it('blocks sidebar-style navigation until the user discards or keeps the draft', async () => {
    const user = userEvent.setup();
    renderGuardedRoutes(['/workflows/demo']);
    await user.type(screen.getByRole('textbox', { name: 'Workflow name' }), 'New name');

    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveValue('New name');

    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('heading', { name: 'Spaces' })).toBeInTheDocument();
  });

  it('blocks browser Back and restores the previous entry when the user keeps editing', async () => {
    const user = userEvent.setup();
    const router = renderGuardedRoutes(['/dashboard', '/workflows/demo']);
    await user.type(screen.getByRole('textbox', { name: 'Workflow name' }), 'Unsaved');

    await user.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Workflow editor' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveValue('Unsaved');

    await user.click(screen.getByRole('button', { name: 'Browser back' }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'));
    expect(screen.getByRole('heading', { name: 'Spaces' })).toBeInTheDocument();
  });

  it('does not interrupt internal view changes on the same editor route', async () => {
    const user = userEvent.setup();
    const router = renderGuardedRoutes(['/workflows/demo']);
    await user.type(screen.getByRole('textbox', { name: 'Workflow name' }), 'Unsaved');
    await user.click(screen.getByRole('button', { name: 'Change editor view' }));
    await waitFor(() => expect(router.state.location.search).toBe('?view=scopes'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveValue('Unsaved');
    expect(screen.getByRole('heading', { name: 'Workflow editor' })).toBeInTheDocument();
  });
});

function SettingsForm({ guardTab }: { guardTab: boolean }) {
  const [secret, setSecret] = useState('');
  const [note, setNote] = useState('');
  const [, setSearchParams] = useSearchParams();
  useUnsavedChangesGuard(secret.length > 0, guardTab ? { guardSearchParams: ['tab'] } : undefined);
  useUnsavedChangesGuard(note.length > 0);

  return (
    <main>
      <h1>Settings</h1>
      <label>
        Client secret
        <input value={secret} onChange={(event) => setSecret(event.target.value)} />
      </label>
      <label>
        Note
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button type="button" onClick={() => setSearchParams({ tab: 'members' })}>
        Members tab
      </button>
      <button
        type="button"
        onClick={() =>
          setSearchParams((prev) => {
            prev.set('view', 'advanced');
            return prev;
          })
        }
      >
        Advanced view
      </button>
      <Link to="/dashboard">Dashboard</Link>
    </main>
  );
}

function renderSettingsRoutes(guardTab: boolean) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <UnsavedChangesGuard>
            <Routes>
              <Route path="/settings" element={<SettingsForm guardTab={guardTab} />} />
              <Route path="/dashboard" element={<h1>Spaces</h1>} />
            </Routes>
          </UnsavedChangesGuard>
        ),
      },
    ],
    { initialEntries: ['/settings?tab=general'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('useUnsavedChangesGuard with guardSearchParams', () => {
  it('asks before a ?tab= switch discards a dirty form that guards tabs', async () => {
    const user = userEvent.setup();
    const router = renderSettingsRoutes(true);
    await user.type(screen.getByRole('textbox', { name: 'Client secret' }), 'shh');

    await user.click(screen.getByRole('button', { name: 'Members tab' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(router.state.location.search).toBe('?tab=general');
    expect(screen.getByRole('textbox', { name: 'Client secret' })).toHaveValue('shh');

    await user.click(screen.getByRole('button', { name: 'Members tab' }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=members'));
  });

  it('still ignores ?view= changes for a form that only guards ?tab=', async () => {
    const user = userEvent.setup();
    const router = renderSettingsRoutes(true);
    await user.type(screen.getByRole('textbox', { name: 'Client secret' }), 'shh');

    await user.click(screen.getByRole('button', { name: 'Advanced view' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=general&view=advanced'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps the default ?tab= behaviour for forms that do not opt in', async () => {
    const user = userEvent.setup();
    const router = renderSettingsRoutes(false);
    await user.type(screen.getByRole('textbox', { name: 'Client secret' }), 'shh');

    await user.click(screen.getByRole('button', { name: 'Members tab' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=members'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  it('stays dirty while any registered form is dirty', async () => {
    const user = userEvent.setup();
    const router = renderSettingsRoutes(true);
    await user.type(screen.getByRole('textbox', { name: 'Client secret' }), 'shh');
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'memo');
    await user.clear(screen.getByRole('textbox', { name: 'Note' }));

    await user.click(screen.getByRole('button', { name: 'Members tab' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    await user.clear(screen.getByRole('textbox', { name: 'Client secret' }));
    await user.click(screen.getByRole('button', { name: 'Members tab' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=members'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
