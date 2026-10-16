import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { trackersService } from '@/services/trackers';
import JiraCallback from './JiraCallback';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/services/trackers', () => ({
  trackersService: { finalizeJiraConnection: vi.fn() },
}));

const returnPath = '/space/project-1/settings?tab=trackers&addJiraProject=1';

beforeEach(() => {
  vi.useFakeTimers();
  navigate.mockReset();
  sessionStorage.clear();
  vi.mocked(trackersService.finalizeJiraConnection)
    .mockReset()
    .mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function showCallback(response: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => response }));
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/trackers/callback/jira-cloud?code=example&state=example']}>
        <JiraCallback />
      </MemoryRouter>,
    );
  });
}

describe('Jira authorization return', () => {
  it('resumes adding a project after single-site authorization', async () => {
    sessionStorage.setItem('oauth_return_to', returnPath);
    await showCallback({ success: true });
    await act(async () => vi.advanceTimersByTime(1200));
    expect(navigate).toHaveBeenCalledWith(returnPath, { replace: true });
    expect(sessionStorage.getItem('oauth_return_to')).toBeNull();
  });

  it('resumes adding a project after choosing an Atlassian site', async () => {
    sessionStorage.setItem('oauth_return_to', returnPath);
    await showCallback({
      pendingChoice: {
        ticket: 'example-ticket',
        resources: [{ cloudId: 'site-1', name: 'Career Compass', host: 'example.atlassian.net' }],
      },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect' })));
    expect(trackersService.finalizeJiraConnection).toHaveBeenCalledWith('example-ticket', 'site-1');
    await act(async () => vi.advanceTimersByTime(1200));
    expect(navigate).toHaveBeenCalledWith(returnPath, { replace: true });
    expect(sessionStorage.getItem('oauth_return_to')).toBeNull();
  });

  it.each([null, '//example.com', 'https://example.com'])(
    'uses the dashboard for a missing or external return path: %s',
    async (path) => {
      if (path) sessionStorage.setItem('oauth_return_to', path);
      await showCallback({ success: true });
      await act(async () => vi.advanceTimersByTime(1200));
      expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true });
    },
  );

  it('keeps authorization errors visible without returning to restart the flow', async () => {
    sessionStorage.setItem('oauth_return_to', returnPath);
    await showCallback({ error: 'Authorization failed' });
    expect(screen.getByText('Authorization failed')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(navigate).not.toHaveBeenCalled();
  });
});
