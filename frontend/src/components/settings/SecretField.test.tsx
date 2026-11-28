import { useState } from 'react';
import { render, screen, waitFor } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Route, RouterProvider, Routes, useSearchParams } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { SecretField } from './SecretField';

function SecretForm({ onSave }: { onSave?: () => void }) {
  const [value, setValue] = useState('');
  const [, setSearchParams] = useSearchParams();
  return (
    <main>
      <h1>Settings</h1>
      <SecretField
        id="client-secret"
        label="Client secret"
        isSet={false}
        value={value}
        onChange={setValue}
        emptyPlaceholder="Paste the secret"
      />
      <button
        type="button"
        onClick={() => {
          onSave?.();
          setValue('');
        }}
      >
        Save
      </button>
      <button type="button" onClick={() => setSearchParams({ tab: 'members' })}>
        Members tab
      </button>
    </main>
  );
}

function renderGuarded(onSave?: () => void) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <UnsavedChangesGuard>
            <Routes>
              <Route path="/settings" element={<SecretForm onSave={onSave} />} />
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

describe('SecretField', () => {
  it('renders a write-only password input with its status chip', () => {
    render(
      <SecretField
        id="token"
        label="API token"
        isSet
        value=""
        onChange={() => {}}
        emptyPlaceholder="Paste a token"
        onClear={() => {}}
      />,
    );
    const input = screen.getByLabelText(/API token/);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('placeholder', 'Enter new value to rotate, or leave blank');
    expect(screen.getByText('Set')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('reports an entered secret as unsaved so a ?tab= switch asks before discarding it', async () => {
    const user = userEvent.setup();
    const router = renderGuarded();
    await user.type(screen.getByLabelText(/Client secret/), 'shh');

    await user.click(screen.getByRole('button', { name: 'Members tab' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(router.state.location.search).toBe('?tab=general');
    expect(screen.getByLabelText(/Client secret/)).toHaveValue('shh');
  });

  it('is clean again once the secret is saved and the field is emptied', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const router = renderGuarded(onSave);
    await user.type(screen.getByLabelText(/Client secret/), 'shh');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Members tab' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=members'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('works without a route guard around it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SecretField
        id="token"
        label="API token"
        isSet={false}
        value=""
        onChange={onChange}
        emptyPlaceholder="Paste a token"
      />,
    );
    await user.type(screen.getByLabelText(/API token/), 'a');
    expect(onChange).toHaveBeenCalledWith('a');
  });
});
