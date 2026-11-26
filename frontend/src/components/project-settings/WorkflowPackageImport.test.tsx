import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  workflowPackageImportRecovery,
  type WorkflowPackageJob,
  type WorkflowSource,
} from '@/services/workflowSources';
import { WorkflowPackageImport } from './WorkflowPackageImport';
import { WorkflowSourcesSection } from './WorkflowSourcesSection';

const auth = vi.hoisted(() => ({
  userId: 'member-one',
  isAuthenticated: true,
  isLoading: false,
}));
vi.mock('@/hooks/useAuthSession', () => ({ useAuthSession: () => auth }));

const mocks = vi.hoisted(() => ({
  createPackageImport: vi.fn(),
  getPackageImport: vi.fn(),
  listWithCapabilities: vi.fn(),
  configure: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@/services/workflowSources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/workflowSources')>()),
  workflowSourcesService: mocks,
}));

const jobId = '22222222-2222-4222-8222-222222222222';
const nextJobId = '33333333-3333-4333-8333-333333333333';
const source: WorkflowSource = {
  sourceId: 'a'.repeat(64),
  provider: 'github',
  repository: 'team/workflows',
  revision: '11111111-1111-4111-8111-111111111111',
  status: 'active',
  authType: 'public',
  access: 'read',
};
const original = { jobId, expectedRevision: source.revision, requestedRelease: 'latest' };
const context = {
  userId: 'member-one',
  projectId: 'p1',
  sourceId: source.sourceId,
  revision: source.revision,
};
const queued: WorkflowPackageJob = {
  jobId,
  sourceId: source.sourceId,
  requestedRelease: 'latest',
  state: 'QUEUED',
  createdAt: 10,
  updatedAt: 20,
};
const succeeded: WorkflowPackageJob = {
  ...queued,
  state: 'SUCCEEDED',
  package: {
    packageId: `sha256:${'b'.repeat(64)}`,
    materializationId: `sha256:${'c'.repeat(64)}`,
    version: '2.9.0',
    release: 'v2.9.0',
    commit: 'd'.repeat(40),
    harnesses: ['claude', 'codex', 'kiro', 'opencode'],
    integrity: 'verified',
    signature: 'not_checked',
    execution: 'not_qualified',
  },
};
const privateError = Object.assign(new Error('/tmp/private-files token=private-token'), {
  status: 503,
  body: { error: 'private-token', localPath: '/tmp/private-files' },
});
const disabledError = { status: 503, body: { code: 'NATIVE_PACKAGE_JOBS_DISABLED' } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  auth.userId = 'member-one';
  auth.isAuthenticated = true;
  auth.isLoading = false;
  vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(jobId).mockReturnValue(nextJobId);
  mocks.createPackageImport.mockResolvedValue(queued);
  mocks.getPackageImport.mockResolvedValue(succeeded);
  mocks.listWithCapabilities.mockResolvedValue({
    sources: [source],
    capabilities: { packageImportsEnabled: true },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('workflow package imports', () => {
  it.each([
    ['github', 'public'],
    ['github', 'github-oauth'],
    ['gitlab', 'public'],
    ['gitlab', 'gitlab-oauth'],
    ['bitbucket', 'public'],
    ['bitbucket', 'bitbucket-oauth'],
    ['github', 'github-app'],
  ] as const)(
    'defaults to this active %s source’s latest stable release with %s access',
    async (provider, authType) => {
      render(<WorkflowPackageImport projectId="p1" source={{ ...source, provider, authType }} />);
      expect(screen.getByLabelText('Package release')).toHaveValue('latest');
      expect(screen.getByText(/highest stable release from this source/)).toBeInTheDocument();
      expect(mocks.createPackageImport).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
      expect(mocks.createPackageImport).toHaveBeenCalledExactlyOnceWith(
        'p1',
        source.sourceId,
        original,
      );
      expect(screen.getByRole('status')).toHaveTextContent('Import queued');
      expect(screen.getByLabelText('Package release')).toBeDisabled();
    },
  );

  it.each(['v2.9.0', 'v2.10.0-preview.20260918.1'])(
    'imports the explicit version %s',
    async (requestedRelease) => {
      mocks.createPackageImport.mockResolvedValue({ ...queued, requestedRelease });
      render(<WorkflowPackageImport projectId="p1" source={source} />);
      await userEvent.selectOptions(screen.getByLabelText('Package release'), 'version');
      await userEvent.type(screen.getByLabelText('Release version'), requestedRelease);
      await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
      expect(mocks.createPackageImport).toHaveBeenCalledExactlyOnceWith('p1', source.sourceId, {
        ...original,
        requestedRelease,
      });
      expect(screen.getByLabelText('Release version')).toBeDisabled();
    },
  );

  it.each(['main', 'latest', 'v01.2.3'])(
    'rejects unsupported explicit input %s before allocating a UUID',
    async (version) => {
      render(<WorkflowPackageImport projectId="p1" source={source} />);
      await userEvent.selectOptions(screen.getByLabelText('Package release'), 'version');
      await userEvent.type(screen.getByLabelText('Release version'), version);
      await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a release such as');
      expect(mocks.createPackageImport).not.toHaveBeenCalled();
      expect(crypto.randomUUID).not.toHaveBeenCalled();
    },
  );

  it('recovers a lost POST response by reading the original job ID', async () => {
    mocks.createPackageImport.mockRejectedValue(privateError);
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    expect(await screen.findByText('Download verified')).toBeInTheDocument();
    expect(mocks.getPackageImport).toHaveBeenCalledExactlyOnceWith('p1', source.sourceId, jobId);
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/private-token|private-files/)).not.toBeInTheDocument();
  });

  it('keeps the original UUID, revision and version for an explicit same-import retry', async () => {
    const requestedRelease = 'v2.9.0';
    mocks.createPackageImport
      .mockRejectedValueOnce(privateError)
      .mockResolvedValueOnce({ ...queued, requestedRelease });
    mocks.getPackageImport.mockRejectedValue({
      status: 404,
      body: { code: 'native_package_job_not_found' },
    });
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.selectOptions(screen.getByLabelText('Package release'), 'version');
    await userEvent.type(screen.getByLabelText('Release version'), requestedRelease);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Import not found');
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Release version')).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Choose another release' }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry same import' }));
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(2);
    expect(mocks.createPackageImport.mock.calls[0]).toEqual(
      mocks.createPackageImport.mock.calls[1],
    );
    expect(mocks.createPackageImport.mock.calls[1][2]).toEqual({ ...original, requestedRelease });
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('keeps latest fixed and permits repeated GET recovery after both responses are lost', async () => {
    mocks.createPackageImport.mockRejectedValue(privateError);
    mocks.getPackageImport.mockRejectedValueOnce(privateError).mockResolvedValueOnce(succeeded);
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Import status could not be confirmed',
    );
    expect(screen.queryByText(/private-token|private-files/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Package release')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Download verified')).toBeInTheDocument();
    expect(mocks.getPackageImport.mock.calls).toEqual([
      ['p1', source.sourceId, jobId],
      ['p1', source.sourceId, jobId],
    ]);
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('saves the request before POST and restores it by GET after an unacknowledged import remounts', async () => {
    mocks.createPackageImport.mockImplementation(() => {
      expect(workflowPackageImportRecovery.read(context)).toEqual(original);
      return Promise.reject(privateError);
    });
    mocks.getPackageImport.mockRejectedValueOnce(privateError).mockResolvedValueOnce(succeeded);
    const first = render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    await screen.findByRole('alert');
    first.unmount();
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    expect(await screen.findByText('Download verified')).toBeInTheDocument();
    expect(mocks.getPackageImport.mock.calls).toEqual([
      ['p1', source.sourceId, jobId],
      ['p1', source.sourceId, jobId],
    ]);
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('does not automatically resubmit a restored latest request that is not found', async () => {
    workflowPackageImportRecovery.save(context, original);
    mocks.getPackageImport.mockRejectedValue({ status: 404 });
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Import not found');
    expect(mocks.getPackageImport).toHaveBeenCalledExactlyOnceWith('p1', source.sourceId, jobId);
    expect(mocks.createPackageImport).not.toHaveBeenCalled();
    expect(crypto.randomUUID).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Package release')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Retry same import' }));
    expect(mocks.createPackageImport).toHaveBeenCalledExactlyOnceWith(
      'p1',
      source.sourceId,
      original,
    );
    expect(crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('restores the explicit release without replacing it with latest', async () => {
    const requestedRelease = 'v2.9.0';
    workflowPackageImportRecovery.save(context, { ...original, requestedRelease });
    mocks.getPackageImport.mockResolvedValue({ ...queued, requestedRelease });
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await screen.findByText('Import queued');
    expect(screen.getByLabelText('Package release')).toHaveValue('version');
    expect(screen.getByLabelText('Release version')).toHaveValue(requestedRelease);
    expect(screen.getByLabelText('Release version')).toBeDisabled();
    expect(mocks.createPackageImport).not.toHaveBeenCalled();
  });

  it('does not restore another user’s saved import and discards their in-flight response', async () => {
    const pending = deferred<WorkflowPackageJob>();
    mocks.createPackageImport.mockReturnValue(pending.promise);
    const { rerender } = render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    auth.userId = 'other-member';
    rerender(<WorkflowPackageImport projectId="p1" source={source} />);
    await act(async () => pending.resolve(succeeded));
    expect(screen.queryByText('Download verified')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import package' })).toBeEnabled();
    expect(mocks.getPackageImport).not.toHaveBeenCalled();
  });

  it('does not use session data before authentication finishes', () => {
    workflowPackageImportRecovery.save(context, original);
    auth.isLoading = true;
    const { container } = render(<WorkflowPackageImport projectId="p1" source={source} />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.getPackageImport).not.toHaveBeenCalled();
  });

  it('does not submit when the UUID cannot be retained across remounts', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw privateError;
    });
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not retain the import request',
    );
    expect(screen.queryByText(/private-token|private-files/)).not.toBeInTheDocument();
    expect(mocks.createPackageImport).not.toHaveBeenCalled();
  });

  it('polls nonterminal jobs only through GET and stops after success', async () => {
    vi.useFakeTimers();
    mocks.getPackageImport
      .mockResolvedValueOnce({ ...queued, state: 'RUNNING' })
      .mockResolvedValueOnce(succeeded);
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Import package' })));
    expect(screen.getByRole('status')).toHaveTextContent('Import queued');
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('status')).toHaveTextContent('Importing package');
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('status')).toHaveTextContent('Download verified');
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(mocks.getPackageImport).toHaveBeenCalledTimes(2);
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
  });

  it('stops automatic recovery on a status error without creating another latest import', async () => {
    vi.useFakeTimers();
    mocks.getPackageImport.mockRejectedValue(privateError);
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Import package' })));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('alert')).toHaveTextContent('Import status could not be confirmed');
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(mocks.getPackageImport).toHaveBeenCalledTimes(1);
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
  });

  it('shows only a package preview and does not imply signature or harness qualification', async () => {
    mocks.createPackageImport.mockResolvedValue({
      ...succeeded,
      error: 'private-token',
      candidate: { localPath: '/tmp/private-files' },
      archiveReceipt: 'private-token',
    });
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    expect(await screen.findByText('Download verified')).toBeInTheDocument();
    expect(screen.getByText('Package preview')).toBeInTheDocument();
    expect(screen.getByText('v2.9.0')).toBeInTheDocument();
    expect(screen.getByText('Claude, Codex, Kiro, OpenCode')).toBeInTheDocument();
    expect(
      screen.getByText(/Signature not checked. Harness execution not qualified./),
    ).toBeInTheDocument();
    expect(screen.getByText(/it does not run a coding agent/)).toBeInTheDocument();
    expect(screen.queryByText(/private-token|private-files/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /run|execute|start native/i }),
    ).not.toBeInTheDocument();
  });

  it('makes terminal failure safe and requires a deliberate new import with a new UUID', async () => {
    mocks.createPackageImport
      .mockResolvedValueOnce({
        ...queued,
        state: 'FAILED',
        error: 'private-token /tmp/private-files',
      })
      .mockResolvedValueOnce({ ...queued, jobId: nextJobId });
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    expect(screen.getByRole('status')).toHaveTextContent('Package import failed');
    expect(screen.queryByText(/private-token|private-files/)).not.toBeInTheDocument();
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry same import' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Choose another release' }));
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    expect(mocks.createPackageImport.mock.calls[1][2]).toEqual({ ...original, jobId: nextJobId });
  });

  it.each([400, 401, 403, 409])(
    'does not automatically recover or retry a rejected HTTP %s submission',
    async (status) => {
      mocks.createPackageImport.mockRejectedValue({ status, message: 'private-token' });
      render(<WorkflowPackageImport projectId="p1" source={source} />);
      await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
      expect(await screen.findByRole('alert')).not.toHaveTextContent('private-token');
      expect(mocks.getPackageImport).not.toHaveBeenCalled();
      expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Retry same import' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Package release')).toBeDisabled();
      expect(workflowPackageImportRecovery.read(context)).toEqual(original);
    },
  );

  it.each([400, 403, 409])(
    'lets the user explicitly clear a saved HTTP %s request without canceling or resubmitting it',
    async (status) => {
      mocks.createPackageImport.mockRejectedValueOnce({ status }).mockResolvedValueOnce({
        ...queued,
        jobId: nextJobId,
      });
      render(<WorkflowPackageImport projectId="p1" source={source} />);
      await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
      await screen.findByRole('alert');
      await userEvent.click(screen.getByRole('button', { name: 'Clear saved request' }));
      expect(
        screen.getByText(/An existing import may continue; this does not cancel it/),
      ).toBeInTheDocument();
      expect(workflowPackageImportRecovery.read(context)).toEqual(original);
      await userEvent.click(screen.getByRole('button', { name: 'Keep saved request' }));
      expect(workflowPackageImportRecovery.read(context)).toEqual(original);
      expect(screen.getByLabelText('Package release')).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Clear saved request' }));
      await userEvent.click(screen.getByRole('button', { name: 'Clear and choose release' }));
      expect(workflowPackageImportRecovery.read(context)).toBeNull();
      expect(screen.getByLabelText('Package release')).toBeEnabled();
      expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
      expect(mocks.getPackageImport).not.toHaveBeenCalled();
      expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
      expect(mocks.createPackageImport).toHaveBeenCalledTimes(2);
      expect(mocks.createPackageImport.mock.calls[1][2]).toEqual({ ...original, jobId: nextJobId });
    },
  );

  it('can still recover a committed import after a post-authorization 403 response', async () => {
    mocks.createPackageImport.mockRejectedValue({ status: 403 });
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    await screen.findByRole('alert');
    expect(workflowPackageImportRecovery.read(context)).toEqual(original);
    await userEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Download verified')).toBeInTheDocument();
    expect(mocks.getPackageImport).toHaveBeenCalledExactlyOnceWith('p1', source.sourceId, jobId);
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
  });

  it('ignores a queued poll callback after the user clears the same source request', async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(window, 'setTimeout');
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Import package' }));
    });
    const poll = timers.mock.calls.find(([, delay]) => delay === 3000)?.[0];
    expect(typeof poll).toBe('function');
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear and choose release' }));
    expect(workflowPackageImportRecovery.read(context)).toBeNull();
    await act(async () => {
      if (typeof poll === 'function') poll();
    });
    expect(mocks.getPackageImport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Import package' })).toBeEnabled();
    expect(screen.queryByText('Download verified')).not.toBeInTheDocument();
  });

  it('rejects status from another request without showing its preview', async () => {
    mocks.getPackageImport.mockResolvedValue({ ...succeeded, requestedRelease: 'v2.9.0' });
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    await userEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Import status could not be confirmed',
    );
    expect(screen.queryByText('Package preview')).not.toBeInTheDocument();
  });

  it.each(['submit', 'status'] as const)(
    'disables import controls independently on the %s route',
    async (route) => {
      if (route === 'submit') mocks.createPackageImport.mockRejectedValue(disabledError);
      else mocks.getPackageImport.mockRejectedValue(disabledError);
      render(<WorkflowSourcesSection projectId="p1" canEdit />);
      await userEvent.click(await screen.findByRole('button', { name: 'Import package' }));
      if (route === 'status')
        await userEvent.click(screen.getByRole('button', { name: 'Check status' }));
      expect(await screen.findByText('Package imports are disabled.')).toBeInTheDocument();
      expect(screen.queryByLabelText('Package release')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry same import' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save and verify' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Verify access to team/workflows' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Remove team/workflows' })).toBeEnabled();
      expect(mocks.configure).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    },
  );

  it('allows members to select and import releases while source bindings remain admin-only', async () => {
    render(<WorkflowSourcesSection projectId="p1" canEdit={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Import package' }));
    expect(mocks.createPackageImport).toHaveBeenCalledWith('p1', source.sourceId, original);
    expect(screen.queryByRole('button', { name: 'Save and verify' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Verify access|^Remove/ }),
    ).not.toBeInTheDocument();
  });

  it('hides import controls for an invalid source', () => {
    const { container } = render(
      <WorkflowPackageImport projectId="p1" source={{ ...source, status: 'invalid' }} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(mocks.createPackageImport).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions while a response is pending', async () => {
    const pending = deferred<WorkflowPackageJob>();
    mocks.createPackageImport.mockReturnValue(pending.promise);
    render(<WorkflowPackageImport projectId="p1" source={source} />);
    const form = screen.getByRole('button', { name: 'Import package' }).closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(mocks.createPackageImport).toHaveBeenCalledTimes(1);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(queued));
  });

  it('does not submit when the parent is refreshing or changing a source', () => {
    render(<WorkflowPackageImport projectId="p1" source={source} suspended />);
    expect(screen.getByRole('button', { name: 'Import package' })).toBeDisabled();
    expect(screen.getByLabelText('Package release')).toBeDisabled();
    expect(mocks.createPackageImport).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'project', projectId: 'p2', nextSource: source },
    { name: 'source', projectId: 'p1', nextSource: { ...source, sourceId: 'b'.repeat(64) } },
    {
      name: 'revision',
      projectId: 'p1',
      nextSource: { ...source, revision: '44444444-4444-4444-8444-444444444444' },
    },
  ])(
    'ignores late POST success after a $name change, even after returning',
    async ({ projectId, nextSource }) => {
      const old = deferred<WorkflowPackageJob>();
      mocks.createPackageImport.mockReturnValue(old.promise);
      mocks.getPackageImport.mockResolvedValue(queued);
      const { rerender } = render(<WorkflowPackageImport projectId="p1" source={source} />);
      await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
      rerender(<WorkflowPackageImport projectId={projectId} source={nextSource} />);
      expect(screen.getByLabelText('Package release')).toBeEnabled();
      rerender(<WorkflowPackageImport projectId="p1" source={source} />);
      await screen.findByText('Import queued');
      await act(async () => old.resolve(succeeded));
      expect(screen.queryByText('Download verified')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Import queued');
      expect(mocks.getPackageImport).toHaveBeenCalledExactlyOnceWith('p1', source.sourceId, jobId);
    },
  );

  it('ignores a late GET success after source revision changes', async () => {
    const old = deferred<WorkflowPackageJob>();
    mocks.getPackageImport.mockReturnValue(old.promise);
    const { rerender } = render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    await userEvent.click(screen.getByRole('button', { name: 'Check status' }));
    rerender(
      <WorkflowPackageImport projectId="p1" source={{ ...source, revision: 'new-revision' }} />,
    );
    await act(async () => old.resolve(succeeded));
    expect(screen.queryByText('Download verified')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import package' })).toBeEnabled();
  });

  it('ignores a stale disabled response after switching projects', async () => {
    const old = deferred<WorkflowPackageJob>();
    mocks.createPackageImport.mockReturnValue(old.promise);
    const { rerender } = render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    rerender(<WorkflowPackageImport projectId="p2" source={source} />);
    await act(async () => old.reject(disabledError));
    expect(screen.queryByText('Package imports are disabled.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import package' })).toBeEnabled();
    expect(mocks.getPackageImport).not.toHaveBeenCalled();
  });

  it('does not recover a lost POST response after unmount', async () => {
    const pending = deferred<WorkflowPackageJob>();
    mocks.createPackageImport.mockReturnValue(pending.promise);
    const { unmount } = render(<WorkflowPackageImport projectId="p1" source={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    unmount();
    await act(async () => pending.reject(privateError));
    expect(mocks.getPackageImport).not.toHaveBeenCalled();
  });

  it('cancels polling on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<WorkflowPackageImport projectId="p1" source={source} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Import package' })));
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(mocks.getPackageImport).not.toHaveBeenCalled();
  });

  it('discards a pending response when a source becomes invalid', async () => {
    const pending = deferred<WorkflowPackageJob>();
    mocks.createPackageImport.mockReturnValue(pending.promise);
    const { rerender, container } = render(
      <WorkflowPackageImport projectId="p1" source={source} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import package' }));
    rerender(<WorkflowPackageImport projectId="p1" source={{ ...source, status: 'invalid' }} />);
    await act(async () => pending.resolve(succeeded));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
