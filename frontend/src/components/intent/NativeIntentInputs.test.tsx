import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { NativeIntentInputs } from './NativeIntentInputs';
import { type NativeIntent, type NativeInputOperation } from '@/services/nativeIntents';
const ports = vi.hoisted(() => ({ inputs: vi.fn(), transfer: vi.fn(), project: vi.fn() }));
vi.mock('@/hooks/useProjectsCache', () => ({ useProjectCache: ports.project }));
vi.mock('@/services/nativeIntents', () => ({ nativeIntentsService: { inputs: ports.inputs } }));
vi.mock('@/services/attachmentUploads', async (original) => ({
  ...(await original<typeof import('@/services/attachmentUploads')>()),
  uploadAttachmentFile: ports.transfer,
}));
const draft: NativeIntent = {
  id: 'run-1',
  projectId: 'project-1',
  executionBackend: 'native',
  title: 'Input fixture',
  prompt: 'Read the selected files',
  harness: 'codex',
  status: 'READY',
  execution: null,
  createdAt: '2026-11-06T00:00:00Z',
  updatedAt: '2026-11-06T00:00:00Z',
  package: {
    version: '2.11.1',
    source: { provider: 'github', repository: 'awslabs/aidlc-workflows', release: 'v2.11.1' },
  },
  applicationSource: { provider: 'github', repository: 'owner/first' },
  inputRevision: 4,
  inputs: { attachments: [], pendingUploads: [], imports: [], source: null },
};
const show = (intent = draft) => {
  const onBusyChange = vi.fn();
  const onRefresh = vi.fn(async () => {});
  const onAccessFailure = vi.fn();
  return {
    ...render(
      <NativeIntentInputs
        intent={intent}
        disabled={false}
        {...{ onBusyChange, onRefresh, onAccessFailure }}
      />,
    ),
    onBusyChange,
    onRefresh,
    onAccessFailure,
  };
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  ports.project.mockReturnValue({
    project: {
      id: draft.projectId,
      trackers: [],
      repos: [
        { provider: 'github', url: 'owner/first' },
        { provider: 'gitlab', url: 'group/second' },
        { provider: 'codecommit', url: 'unsupported' },
      ],
    },
  });
  ports.inputs.mockImplementation(async (_p, _id, revision, operation: NativeInputOperation) => ({
    intent: { ...draft, inputRevision: revision + 1 },
    ...(operation.operation === 'upload'
      ? {
          upload: {
            attachmentId: operation.attachmentId,
            mimeType: operation.mimeType,
            url: 'https://native-inputs.s3.amazonaws.com/staging',
          },
        }
      : {}),
  }));
  ports.transfer.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('uses the selected repository and current input revision through the native service', async () => {
  const f = show();
  expect(screen.queryByRole('option', { name: /unsupported/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Application repository' }), {
    target: { value: '["gitlab","group/second"]' },
  });
  await waitFor(() => expect(f.onRefresh).toHaveBeenCalled());
  expect(ports.inputs).toHaveBeenCalledWith('project-1', 'run-1', 4, {
    operation: 'source',
    applicationSource: { provider: 'gitlab', repository: 'group/second' },
  });
});
it('hashes and transfers the actual file before confirming the new input revision', async () => {
  const f = show();
  const file = new File(['selected bytes'], 'reference.md', { type: 'text/markdown' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode('selected bytes').buffer,
  });
  fireEvent.change(f.container.querySelector('input[type=file]')!, { target: { files: [file] } });
  await waitFor(() => expect(ports.inputs).toHaveBeenCalledTimes(2));
  const request = ports.inputs.mock.calls[0][3];
  expect(request).toMatchObject({
    operation: 'upload',
    filename: file.name,
    size: file.size,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(ports.transfer).toHaveBeenCalledWith(
    expect.objectContaining({ attachmentId: request.attachmentId }),
    file,
    expect.any(Function),
  );
  expect(ports.inputs).toHaveBeenLastCalledWith('project-1', 'run-1', 5, {
    operation: 'complete',
    attachmentId: request.attachmentId,
  });
  await waitFor(() => expect(f.onBusyChange).toHaveBeenLastCalledWith(false));
});
it('retains uncertainty and refreshes after a transfer fails instead of confirming it', async () => {
  const f = show();
  ports.transfer.mockRejectedValue(new Error('lost upload response'));
  const file = new File(['x'], 'input.txt', { type: 'text/plain' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([120]).buffer });
  fireEvent.change(f.container.querySelector('input[type=file]')!, { target: { files: [file] } });
  await screen.findByRole('alert');
  expect(ports.inputs).toHaveBeenCalledTimes(1);
  expect(f.onRefresh).toHaveBeenCalled();
});
it('requires explicit exclusion of a failed selected import', async () => {
  show({
    ...draft,
    inputs: {
      ...draft.inputs!,
      imports: [{ id: 'a'.repeat(64), status: 'failed', reason: 'Provider unavailable' }],
    },
  });
  expect(screen.getByRole('status')).toHaveTextContent('Start is blocked');
  fireEvent.click(screen.getByRole('button', { name: 'Exclude selected import' }));
  await waitFor(() =>
    expect(ports.inputs).toHaveBeenCalledWith('project-1', 'run-1', 4, {
      operation: 'exclude-import',
      attachmentId: 'a'.repeat(64),
    }),
  );
});
it('shows captured files without loading current project settings or editable controls', () => {
  show({
    ...draft,
    execution: {
      status: 'REQUESTED',
      model: null,
      recoveryMode: 'efs-workspace-v1',
      repository: {
        provider: 'github',
        repository: 'owner/first',
        branch: 'main',
        commit: 'a'.repeat(40),
      },
      publicationId: null,
      projectionStatus: null,
      attemptId: 'attempt',
      epoch: 1,
      startedAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    },
    inputs: {
      ...draft.inputs!,
      attachments: [
        {
          attachmentId: 'file',
          filename: 'reference.md',
          mimeType: 'text/markdown',
          size: 4,
          sha256: 'a'.repeat(64),
        },
      ],
    },
  });
  expect(screen.getByText(/SHA-256/)).toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(ports.project).not.toHaveBeenCalled();
  expect(ports.inputs).not.toHaveBeenCalled();
});
