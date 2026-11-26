import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  workflowPackageImportRecovery,
  type WorkflowPackageJob,
  type WorkflowSource,
  type WorkflowSourceList,
} from '@/services/workflowSources';
import { WorkflowSourcesSection } from './WorkflowSourcesSection';

const mocks = vi.hoisted(() => ({
  listWithCapabilities: vi.fn(),
  configure: vi.fn(),
  remove: vi.fn(),
  createPackageImport: vi.fn(),
  getPackageImport: vi.fn(),
}));
vi.mock('@/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ userId: 'member-one', isAuthenticated: true, isLoading: false }),
}));
vi.mock('@/services/workflowSources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/workflowSources')>()),
  workflowSourcesService: mocks,
}));

const source: WorkflowSource = {
  sourceId: 'a'.repeat(64),
  provider: 'github',
  repository: 'team/workflows',
  revision: '11111111-1111-4111-8111-111111111111',
  status: 'active',
  authType: 'public',
  access: 'read',
};

const listing = (
  sources: WorkflowSource[] = [],
  packageImportsEnabled = false,
): WorkflowSourceList => ({
  sources,
  capabilities: { packageImportsEnabled },
});
const importContext = {
  userId: 'member-one',
  projectId: 'p1',
  sourceId: source.sourceId,
  revision: source.revision,
};
const savedImport = {
  jobId: '22222222-2222-4222-8222-222222222222',
  expectedRevision: source.revision,
  requestedRelease: 'latest',
};
const queued: WorkflowPackageJob = {
  jobId: savedImport.jobId,
  sourceId: source.sourceId,
  requestedRelease: 'latest',
  state: 'QUEUED',
  createdAt: 10,
  updatedAt: 10,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  mocks.listWithCapabilities.mockResolvedValue(listing());
  mocks.configure.mockResolvedValue(source);
  mocks.remove.mockResolvedValue(undefined);
  mocks.createPackageImport.mockResolvedValue(queued);
  mocks.getPackageImport.mockResolvedValue(queued);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('workflow source settings', () => {
  it('keeps the section hidden while the API feature is disabled', async () => {
    mocks.listWithCapabilities.mockRejectedValue({
      status: 503,
      body: { code: 'WORKFLOW_SOURCE_API_DISABLED' },
    });
    const { container } = render(<WorkflowSourcesSection projectId="p1" canEdit />);
    await act(async () => {});
    expect(mocks.listWithCapabilities).toHaveBeenCalledWith('p1');
    expect(container).toBeEmptyDOMElement();
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it('shows members the configured sources without mutation controls', async () => {
    mocks.listWithCapabilities.mockResolvedValue(listing([source]));
    render(<WorkflowSourcesSection projectId="p1" canEdit={false} />);
    expect(await screen.findByText('team/workflows')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save and verify' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Verify access/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it.each([false, undefined, 'true', 1])(
    'immediately keeps CRUD usable without import controls or recovery requests for capability %s',
    async (packageImportsEnabled) => {
      vi.useFakeTimers();
      mocks.listWithCapabilities.mockResolvedValue({
        sources: [source],
        ...(packageImportsEnabled === undefined ? {} : { capabilities: { packageImportsEnabled } }),
      });
      expect(workflowPackageImportRecovery.save(importContext, savedImport)).toBe(true);
      await act(async () => {
        render(<WorkflowSourcesSection projectId="p1" canEdit />);
      });
      expect(screen.getByText('team/workflows')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save and verify' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Verify access to team/workflows' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Remove team/workflows' })).toBeEnabled();
      expect(screen.getByText('Package imports are unavailable.')).toBeInTheDocument();
      expect(screen.queryByLabelText('Package release')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Import package' })).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(mocks.createPackageImport).not.toHaveBeenCalled();
      expect(mocks.getPackageImport).not.toHaveBeenCalled();
      expect(workflowPackageImportRecovery.read(importContext)).toEqual(savedImport);
    },
  );

  it.each([true, false])(
    'offers imports only after an explicit enabled capability with canEdit=%s',
    async (canEdit) => {
      const pending = deferred<WorkflowSourceList>();
      mocks.listWithCapabilities.mockReturnValue(pending.promise);
      render(<WorkflowSourcesSection projectId="p1" canEdit={canEdit} />);
      expect(screen.queryByRole('button', { name: 'Import package' })).not.toBeInTheDocument();
      await act(async () => pending.resolve(listing([source], true)));
      expect(screen.getByRole('button', { name: 'Import package' })).toBeEnabled();
      expect(screen.queryByText('Package imports are unavailable.')).not.toBeInTheDocument();
      expect(mocks.createPackageImport).not.toHaveBeenCalled();
      expect(mocks.getPackageImport).not.toHaveBeenCalled();
    },
  );

  it('unmounts imports when a reload disables them and ignores late status responses', async () => {
    vi.useFakeTimers();
    const pending = deferred<WorkflowPackageJob>();
    mocks.listWithCapabilities
      .mockResolvedValueOnce(listing([source], true))
      .mockResolvedValue(listing([source]));
    mocks.getPackageImport.mockReturnValue(pending.promise);
    expect(workflowPackageImportRecovery.save(importContext, savedImport)).toBe(true);
    await act(async () => {
      render(<WorkflowSourcesSection projectId="p1" canEdit />);
    });
    expect(mocks.getPackageImport).toHaveBeenCalledExactlyOnceWith(
      'p1',
      source.sourceId,
      savedImport.jobId,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    });
    expect(screen.queryByLabelText('Package release')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and verify' })).toBeEnabled();
    await act(async () => {
      pending.resolve(queued);
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(mocks.getPackageImport).toHaveBeenCalledTimes(1);
    expect(mocks.createPackageImport).not.toHaveBeenCalled();
  });

  it('does not apply an old project’s enabled capability to the current source list', async () => {
    const old = deferred<WorkflowSourceList>();
    mocks.listWithCapabilities.mockImplementation((projectId: string) =>
      projectId === 'p1' ? old.promise : Promise.resolve(listing([source])),
    );
    expect(
      workflowPackageImportRecovery.save({ ...importContext, projectId: 'p2' }, savedImport),
    ).toBe(true);
    const { rerender } = render(<WorkflowSourcesSection projectId="p1" canEdit />);
    rerender(<WorkflowSourcesSection projectId="p2" canEdit />);
    await screen.findByText('team/workflows');
    await act(async () => old.resolve(listing([source], true)));
    expect(screen.queryByRole('button', { name: 'Import package' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Package release')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and verify' })).toBeEnabled();
    expect(mocks.getPackageImport).not.toHaveBeenCalled();
    expect(mocks.createPackageImport).not.toHaveBeenCalled();
  });

  it.each(['github', 'gitlab', 'bitbucket'] as const)(
    'requires an explicit delegation before saving a private %s source',
    async (provider) => {
      render(<WorkflowSourcesSection projectId="p1" canEdit />);
      await screen.findByRole('button', { name: 'Save and verify' });
      await userEvent.selectOptions(screen.getByLabelText('Git host'), provider);
      await userEvent.clear(screen.getByLabelText('Repository'));
      await userEvent.type(screen.getByLabelText('Repository'), 'team/workflows');
      await userEvent.selectOptions(
        screen.getByLabelText('Repository access'),
        `${provider}-oauth`,
      );
      const save = screen.getByRole('button', { name: 'Save and verify' });
      expect(save).toBeDisabled();
      await userEvent.click(save);
      expect(mocks.configure).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('checkbox', { name: /Allow project members/ }));
      await userEvent.click(save);
      await waitFor(() =>
        expect(mocks.configure).toHaveBeenCalledWith('p1', {
          provider,
          repository: 'team/workflows',
          authType: `${provider}-oauth`,
          confirmDelegation: true,
          expectedRevision: null,
        }),
      );
    },
  );

  it('defaults to the official public source without delegating a personal connection', async () => {
    render(<WorkflowSourcesSection projectId="p1" canEdit />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save and verify' }));
    expect(mocks.configure).toHaveBeenCalledWith('p1', {
      provider: 'github',
      repository: 'awslabs/aidlc-workflows',
      authType: 'public',
      expectedRevision: null,
    });
  });

  it('keeps stale edits conditional and surfaces a conflict without automatic resubmission', async () => {
    mocks.listWithCapabilities.mockResolvedValue(listing([source]));
    mocks.configure.mockRejectedValue(new Error('Source changed; reload before trying again.'));
    render(<WorkflowSourcesSection projectId="p1" canEdit />);
    await userEvent.click(await screen.findByRole('button', { name: /Verify access to team/ }));
    expect(screen.getByLabelText('Git host')).toBeDisabled();
    expect(screen.getByLabelText('Repository')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Source changed; reload');
    expect(mocks.configure).toHaveBeenCalledTimes(1);
    expect(mocks.configure.mock.calls[0][1].expectedRevision).toBe(source.revision);
    expect(mocks.listWithCapabilities).toHaveBeenCalledTimes(1);
  });

  it('removes the observed revision only after the inline confirmation', async () => {
    mocks.listWithCapabilities.mockResolvedValue(listing([source]));
    render(<WorkflowSourcesSection projectId="p1" canEdit />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove team/workflows' }));
    expect(mocks.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
    expect(mocks.remove).toHaveBeenCalledWith('p1', source);
  });

  it('ignores source lists that arrive after switching projects', async () => {
    const old = deferred<WorkflowSourceList>();
    mocks.listWithCapabilities.mockImplementation((id: string) =>
      id === 'p1' ? old.promise : Promise.resolve(listing()),
    );
    const { rerender } = render(<WorkflowSourcesSection projectId="p1" canEdit />);
    rerender(<WorkflowSourcesSection projectId="p2" canEdit />);
    await screen.findByText('No workflow sources configured.');
    await act(async () => old.resolve(listing([source], true)));
    expect(screen.queryByText('team/workflows')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
    expect(mocks.configure.mock.calls[0][0]).toBe('p2');
  });

  it('ignores an old save after leaving and returning to the same project', async () => {
    const old = deferred<WorkflowSource>();
    mocks.configure.mockReturnValueOnce(old.promise);
    const { rerender } = render(<WorkflowSourcesSection projectId="p1" canEdit />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save and verify' }));
    rerender(<WorkflowSourcesSection projectId="p2" canEdit />);
    await screen.findByRole('button', { name: 'Save and verify' });
    rerender(<WorkflowSourcesSection projectId="p1" canEdit />);
    await screen.findByRole('button', { name: 'Save and verify' });
    fireEvent.change(screen.getByLabelText('Repository'), {
      target: { value: 'different/workflows' },
    });
    const reads = mocks.listWithCapabilities.mock.calls.length;
    await act(async () => old.resolve(source));
    expect(screen.getByLabelText('Repository')).toHaveValue('different/workflows');
    expect(mocks.listWithCapabilities).toHaveBeenCalledTimes(reads);
  });

  it('surfaces an unavailable API and disables writes until a list can be read', async () => {
    mocks.listWithCapabilities.mockRejectedValue(new Error('Source service unavailable'));
    render(<WorkflowSourcesSection projectId="p1" canEdit />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Source service unavailable');
    expect(screen.getByRole('button', { name: 'Save and verify' })).toBeDisabled();
    mocks.listWithCapabilities.mockResolvedValue(listing());
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and verify' })).toBeEnabled(),
    );
  });

  it('blocks edits and removes cached source rows after a failed reload', async () => {
    mocks.listWithCapabilities
      .mockResolvedValueOnce(listing([source]))
      .mockRejectedValueOnce(new Error('Reload failed'));
    render(<WorkflowSourcesSection projectId="p1" canEdit />);
    await screen.findByText('team/workflows');
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload failed');
    expect(screen.queryByText('team/workflows')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Verify access/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and verify' })).toBeDisabled();
    mocks.listWithCapabilities.mockResolvedValueOnce(listing());
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and verify' })).toBeEnabled(),
    );
  });

  it('does not redisplay a removed source as configured when the follow-up reload fails', async () => {
    mocks.listWithCapabilities
      .mockResolvedValueOnce(listing([source]))
      .mockRejectedValueOnce(new Error('Reload failed'));
    render(<WorkflowSourcesSection projectId="p1" canEdit />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove team/workflows' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload failed');
    expect(mocks.remove).toHaveBeenCalledWith('p1', source);
    expect(screen.queryByText('team/workflows')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm removal' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and verify' })).toBeDisabled();
  });
});
