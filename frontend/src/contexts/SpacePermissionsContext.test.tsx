import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SpacePermissionsProvider,
  SpacePermissionsNotice,
  useSpacePermissions,
} from './SpacePermissionsContext';
import { projectsService } from '@/services/projects';
import { ApiError } from '@/services/api';
import { useAutoSave } from '@/hooks/useAutoSave';

vi.mock('@/services/projects', () => ({ projectsService: { get: vi.fn() } }));
const get = vi.mocked(projectsService.get);
const member = { userRole: 'member', permissions: { read: true, write: true, manage: false } };
const viewer = { userRole: 'viewer', permissions: { read: true, write: false, manage: false } };

function Controls({ save = async () => {} }: { save?: () => Promise<void> }) {
  const { readOnly, canManage, denyWrites } = useSpacePermissions();
  const { flushLatest } = useAutoSave(() => ({ content: 'draft' }), save, [], {
    skipInitial: true,
  });
  return (
    <>
      <SpacePermissionsNotice />
      <p>Readable questions and documents</p>
      <button disabled={!canManage}>Manage members</button>
      <button disabled={readOnly} onClick={flushLatest}>
        Change content
      </button>
      <button onClick={denyWrites}>Server denied write</button>
      <button onClick={flushLatest}>Flush queued content</button>
    </>
  );
}

describe('current space permissions', () => {
  beforeEach(() => {
    get.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it('backs off initial failures, retries immediately online, and cancels retries on unmount', async () => {
    vi.useFakeTimers();
    get.mockRejectedValue(new TypeError('Offline'));
    const { unmount } = render(
      <SpacePermissionsProvider projectId="s">
        <Controls />
      </SpacePermissionsProvider>,
    );
    await act(async () => await vi.advanceTimersByTimeAsync(1_000));
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => await vi.advanceTimersByTimeAsync(1_999));
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => await vi.advanceTimersByTimeAsync(1));
    expect(get).toHaveBeenCalledTimes(3);
    get.mockResolvedValue(member as Awaited<ReturnType<typeof projectsService.get>>);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(get).toHaveBeenCalledTimes(4);
    expect(screen.getByText('Change content')).toBeEnabled();
    await act(async () => await vi.advanceTimersByTimeAsync(4_000));
    expect(get).toHaveBeenCalledTimes(4);
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    window.dispatchEvent(new Event('online'));
    expect(get).toHaveBeenCalledTimes(4);
  });

  it.each([403, 404])('does not rapidly retry an initial HTTP %s denial', async (status) => {
    vi.useFakeTimers();
    get.mockRejectedValue(new ApiError(status, 'No access'));
    const { unmount } = render(
      <SpacePermissionsProvider projectId="s">
        <Controls />
      </SpacePermissionsProvider>,
    );
    await act(async () => await vi.advanceTimersByTimeAsync(14_999));
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Change content')).toBeDisabled();
    unmount();
  });

  it('keeps content readable and prevents explicit or retirement saves for a Viewer', async () => {
    get.mockResolvedValue(viewer as Awaited<ReturnType<typeof projectsService.get>>);
    const save = vi.fn();
    const { unmount } = render(
      <SpacePermissionsProvider projectId="s">
        <Controls save={save} />
      </SpacePermissionsProvider>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'You have view-only access to this space.',
    );
    expect(screen.getByText('Readable questions and documents')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Change content' })).toBeDisabled();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Flush queued content' })),
    );
    unmount();
    expect(save).not.toHaveBeenCalled();
  });

  it('revokes controls on focus and immediately when Yjs denies a write', async () => {
    get.mockResolvedValue(member as Awaited<ReturnType<typeof projectsService.get>>);
    render(
      <SpacePermissionsProvider projectId="s">
        <Controls />
      </SpacePermissionsProvider>,
    );
    const button = screen.getByRole('button', { name: 'Change content' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Server denied write' }));
    expect(button).toBeDisabled();
    fireEvent.focus(window);
    await waitFor(() => expect(button).toBeEnabled());
    get.mockResolvedValue(viewer as Awaited<ReturnType<typeof projectsService.get>>);
    fireEvent.focus(window);
    await waitFor(() => expect(button).toBeDisabled());
  });

  it('never carries permissions into a different space while its initial request fails', async () => {
    get.mockResolvedValue(member as Awaited<ReturnType<typeof projectsService.get>>);
    const { rerender } = render(
      <SpacePermissionsProvider projectId="a">
        <Controls />
      </SpacePermissionsProvider>,
    );
    await waitFor(() => expect(screen.getByText('Change content')).toBeEnabled());
    get.mockRejectedValue(new Error('Unavailable'));
    rerender(
      <SpacePermissionsProvider projectId="b">
        <Controls />
      </SpacePermissionsProvider>,
    );
    expect(screen.getByText('Change content')).toBeDisabled();
    await waitFor(() => expect(get).toHaveBeenCalledWith('b'));
    expect(screen.getByText('Change content')).toBeDisabled();
  });

  it('updates management controls on promotion and demotion without stale page roles', async () => {
    get.mockResolvedValue(member as Awaited<ReturnType<typeof projectsService.get>>);
    render(
      <SpacePermissionsProvider projectId="s">
        <Controls />
      </SpacePermissionsProvider>,
    );
    await waitFor(() => expect(screen.getByText('Change content')).toBeEnabled());
    expect(screen.getByText('Manage members')).toBeDisabled();
    get.mockResolvedValue({
      ...member,
      userRole: 'owner',
      permissions: { read: true, write: true, manage: true },
    } as Awaited<ReturnType<typeof projectsService.get>>);
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByText('Manage members')).toBeEnabled());
    get.mockResolvedValue(viewer as Awaited<ReturnType<typeof projectsService.get>>);
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByText('Manage members')).toBeDisabled());
    expect(screen.getByText('Change content')).toBeDisabled();
  });
});

it.each([403, 404])('revokes the last known grant on confirmed HTTP %s', async (status) => {
  get.mockResolvedValue(member as Awaited<ReturnType<typeof projectsService.get>>);
  render(
    <SpacePermissionsProvider projectId="s">
      <Controls />
    </SpacePermissionsProvider>,
  );
  await waitFor(() => expect(screen.getByText('Change content')).toBeEnabled());
  get.mockRejectedValue(new ApiError(status, 'No access'));
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getByText('Change content')).toBeDisabled());
});

// The platform's native-execution flag rides on the space response this
// provider already polls, so a page learns it without a request of its own.
describe('the native-execution flag of the current space', () => {
  function Flag() {
    const { nativeExecution } = useSpacePermissions();
    return <p>native: {String(nativeExecution)}</p>;
  }
  const space = (flag?: string) =>
    ({ ...member, ...(flag ? { nativeExecution: flag } : {}) }) as Awaited<
      ReturnType<typeof projectsService.get>
    >;
  const renderFlag = () =>
    render(
      <SpacePermissionsProvider projectId="s">
        <Flag />
      </SpacePermissionsProvider>,
    );
  const refocus = () =>
    act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

  beforeEach(() => {
    get.mockReset();
  });

  it('is off outside a space and until the space has loaded', () => {
    get.mockReturnValue(new Promise(() => {}));
    render(<Flag />);
    expect(screen.getByText('native: false')).toBeInTheDocument();
    renderFlag();
    expect(screen.getAllByText('native: false')).toHaveLength(2);
  });

  it.each([
    ['enabled', true],
    ['disabled', false],
    ['Enabled', false],
    [undefined, false],
  ])('reads %s as %s', async (flag, expected) => {
    get.mockResolvedValue(space(flag));
    renderFlag();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(await screen.findByText(`native: ${expected}`)).toBeInTheDocument();
  });

  it('follows a switch of the flag on the next poll', async () => {
    get.mockResolvedValue(space('enabled'));
    renderFlag();
    expect(await screen.findByText('native: true')).toBeInTheDocument();
    get.mockResolvedValue(space('disabled'));
    await refocus();
    expect(await screen.findByText('native: false')).toBeInTheDocument();
  });

  it('keeps the last answer through a transport failure and drops it with the access', async () => {
    get.mockResolvedValue(space('enabled'));
    renderFlag();
    expect(await screen.findByText('native: true')).toBeInTheDocument();
    get.mockRejectedValue(new TypeError('Offline'));
    await refocus();
    expect(screen.getByText('native: true')).toBeInTheDocument();
    get.mockRejectedValue(new ApiError(403, 'No access'));
    await refocus();
    expect(await screen.findByText('native: false')).toBeInTheDocument();
  });
});
