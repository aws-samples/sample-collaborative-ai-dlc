// Real session lifecycle and query client; only the Cognito service is mocked.
import { act, render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  isAuthenticated: vi.fn(),
  getCurrentUser: vi.fn(),
  logout: vi.fn(),
  login: vi.fn(),
}));

vi.mock('../services/auth', () => ({ authService: auth }));

import { AuthProvider, useAuth } from './AuthContext';
import { queryClient, querySessionOpen } from '@/lib/queryClient';
import { CancelledError, useQuery } from '@tanstack/react-query';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session isolation: user A → logout → user B', () => {
  it('never shows or stores A’s late responses and refuses work until a fresh document', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    let resolveA!: (value: string) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveA = resolve;
        }),
    );
    auth.isAuthenticated.mockResolvedValue(true);
    auth.getCurrentUser.mockResolvedValue({
      userId: 'user-a',
      username: 'a@example.com',
      groups: [],
      identitySource: 'cognito',
    });
    auth.logout.mockResolvedValue(undefined);
    auth.login.mockResolvedValue({
      user: { userId: 'user-b', username: 'b@example.com', groups: [], identitySource: 'cognito' },
    });

    function Screen() {
      const { user, logout, login } = useAuth();
      const query = useQuery({
        queryKey: ['intent', 'p', 'i', 'detail'],
        queryFn: fetcher,
        enabled: !!user,
        placeholderData: user ? 'summary of A' : undefined,
      });
      return (
        <>
          <span>user:{user?.username ?? 'none'}</span>
          <span>data:{String(query.data)}</span>
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
          <button type="button" onClick={() => void login('b', 'pw')}>
            Sign in B
          </button>
        </>
      );
    }

    render(
      <AuthProvider>
        <Screen />
      </AuthProvider>,
    );
    expect(await screen.findByText('user:a@example.com')).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText('data:summary of A')).toBeInTheDocument();
    let finishWrite!: (value: string) => void;
    const oldRead = queryClient
      .fetchQuery({
        queryKey: ['projects'],
        queryFn: () =>
          new Promise<string>((resolve) => {
            finishWrite = resolve;
          }),
      })
      .then((value) => {
        queryClient.setQueryData(['intent', 'p', 'i', 'detail'], 'late continuation of A');
        return value;
      });
    const cancelled = expect(oldRead).rejects.toBeInstanceOf(CancelledError);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('user:none')).toBeInTheDocument();
    expect(querySessionOpen).toBe(false);

    await act(async () => resolveA('private detail of A'));
    expect(screen.getByText('data:undefined')).toBeInTheDocument();
    expect(queryClient.getQueryState(['intent', 'p', 'i', 'detail'])?.data).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in B' }));
    expect(reload).toHaveBeenCalledOnce();
    expect(querySessionOpen).toBe(false);
    await act(async () => finishWrite('A'));
    expect(queryClient.getQueryState(['intent', 'p', 'i', 'detail'])?.data).toBeUndefined();
    await cancelled;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText('data:undefined')).toBeInTheDocument();
  });
});
