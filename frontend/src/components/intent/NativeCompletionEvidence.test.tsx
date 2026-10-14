import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeCompletionEvidence } from './NativeCompletionEvidence';
import { resetSessionExpiry, notifySessionExpired } from '@/services/sessionExpiry';
import definition from '../../../../lambda/shared/native-workflow-policy-data.json';

const mocks = vi.hoisted(() => ({ read: vi.fn(), userId: 'one', access: 0 }));
vi.mock('@/services/nativeCompletion', () => ({ nativeCompletionService: { read: mocks.read } }));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { userId: mocks.userId } }),
}));
vi.mock('@/hooks/useNativeIntents', () => ({
  getNativeListing: () => ({ accessRevision: mocks.access }),
  useNativeListingVersion: () => {},
  nativeAccessDenied: (e: { status: number }) => e?.status === 403,
}));
const props = {
  projectId: 'p',
  executionId: 'e',
  attemptId: '11111111-1111-4111-8111-111111111111',
  target: { publicationId: 'a'.repeat(64), publicationSequence: 1 },
  onAccessFailure: vi.fn(),
};
const value = (label: string | null = null) => ({
  ...props.target,
  definition,
  policyStatus: 'definition_recognized',
  decisionDelivery: 'delivered',
  memberDecision: label
    ? {
        label,
        presentedStage: 'requirements-analysis',
        actorId: 'member-one',
        acceptedAt: '2026-10-14T12:00:00Z',
        commandId: 'command',
        interactionId: 'proposal',
        additionalText: false,
      }
    : null,
});
const pending = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.resetAllMocks();
  resetSessionExpiry();
  mocks.userId = 'one';
  mocks.access = 0;
});
afterEach(cleanup);
it('shows the recorded choice without a final approval button or an application claim', async () => {
  mocks.read.mockResolvedValue(value('Request Changes'));
  render(<NativeCompletionEvidence {...props} />);
  await screen.findByText(/Request Changes · requirements-analysis/);
  expect(screen.getByText(/Engine application: not recorded/)).toBeInTheDocument();
  expect(screen.getByText(/does not approve later changed bytes/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
  expect(screen.getByText('Workflow completion: not verified')).toBeInTheDocument();
});
it('inspects pinned no-gate initialization, conditional and skipped stages without applying a plan', async () => {
  mocks.read.mockResolvedValue(value());
  render(<NativeCompletionEvidence {...props} />);
  await screen.findByText('Inspect pinned package defaults');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'express' } });
  expect(screen.getByText(/Declared review cap: none/)).toBeInTheDocument();
  expect(screen.getAllByText(/Human gate: not required/)).toHaveLength(3);
  expect(screen.getAllByText(/skipped by this default plan/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/conditional inclusion/).length).toBeGreaterThan(0);
  expect(mocks.read).toHaveBeenCalledTimes(1); // Preview cannot dispatch or change a plan.
});
it('keeps unknown policy separate from a workflow with no required approval', async () => {
  mocks.read.mockResolvedValue({ ...value(), definition: null, policyStatus: 'unsupported' });
  render(<NativeCompletionEvidence {...props} />);
  await screen.findByText(/no supported definition profile/);
  expect(
    screen.getByText(/Missing policy evidence does not mean approval is unnecessary/),
  ).toBeInTheDocument();
});
it.each(['project', 'run', 'attempt', 'publication', 'account', 'access'])(
  'discards late %s evidence after identity changes',
  async (kind) => {
    const old = pending();
    mocks.read.mockReturnValueOnce(old.promise).mockResolvedValue(value('Request Changes'));
    const rendered = render(<NativeCompletionEvidence {...props} />);
    const next = { ...props };
    if (kind === 'project') next.projectId = 'other';
    if (kind === 'run') next.executionId = 'other';
    if (kind === 'attempt') next.attemptId = '22222222-2222-4222-8222-222222222222';
    if (kind === 'publication')
      next.target = { publicationId: 'b'.repeat(64), publicationSequence: 2 };
    if (kind === 'account') mocks.userId = 'two';
    if (kind === 'access') mocks.access++;
    rendered.rerender(<NativeCompletionEvidence {...next} />);
    await screen.findByText(/Request Changes ·/);
    await act(async () => old.resolve(value('Old decision')));
    expect(screen.queryByText(/Old decision/)).not.toBeInTheDocument();
  },
);
it('clears evidence on expiry and ignores late responses', async () => {
  const old = pending();
  mocks.read.mockReturnValue(old.promise);
  render(<NativeCompletionEvidence {...props} />);
  act(() => notifySessionExpired());
  await act(async () => old.resolve(value('Old decision')));
  expect(screen.queryByLabelText('Workflow completion evidence')).not.toBeInTheDocument();
});
it('isolates evidence failure, supports retry, and propagates revoked access', async () => {
  mocks.read.mockRejectedValueOnce(new Error('unavailable')).mockRejectedValueOnce({ status: 403 });
  render(
    <>
      <p>Exact files</p>
      <NativeCompletionEvidence {...props} />
    </>,
  );
  await screen.findByText(/Completion evidence is unavailable/);
  expect(screen.getByText('Exact files')).toBeInTheDocument();
  expect(props.onAccessFailure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry evidence' }));
  await vi.waitFor(() => expect(props.onAccessFailure).toHaveBeenCalledWith({ status: 403 }));
});
