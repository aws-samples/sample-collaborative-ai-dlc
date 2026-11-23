import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

// Protected workflow-engine evidence (NE-11), as decoded by the service.
const engine = (patch: Record<string, unknown> = {}) => ({
  ...value(),
  definition: null,
  policyStatus: 'protected_engine',
  workflowCompletion: 'complete',
  requiredChecks: 'passed',
  finalReview: 'ready',
  humanApproval: 'applied',
  decisionDelivery: null,
  filesSha256: 'f'.repeat(64),
  effectivePlan: {
    scope: 'feature',
    name: null,
    sha256: '3'.repeat(64),
    stages: [
      { id: 'workspace-detection', phase: 'initialization', action: 'EXECUTE', state: 'completed' },
      { id: 'requirements-analysis', phase: 'inception', action: 'EXECUTE', state: 'completed' },
      { id: 'user-stories', phase: 'inception', action: 'SKIP', state: 'skipped' },
    ],
  },
  engineApplication: [
    {
      commandId: '22222222-2222-4222-8222-222222222222',
      interactionId: 'b'.repeat(64),
      actorId: 'member-one',
      stage: null,
      sequence: 1,
      application: 'applied',
      effect: 'PLAN_PROPOSAL_APPLIED',
    },
    {
      commandId: '33333333-3333-4333-8333-333333333333',
      interactionId: 'c'.repeat(64),
      actorId: 'member-two',
      stage: 'requirements-analysis',
      sequence: 2,
      application: 'applied',
      effect: 'GATE_APPROVED',
    },
  ],
  checks: [
    {
      stage: 'requirements-analysis',
      unit: null,
      sensor: 'required-sections',
      status: 'passed',
      buildId: 'build-1',
    },
    {
      stage: 'code-generation',
      unit: 'unit-a',
      sensor: 'type-check',
      status: 'budget_exceeded',
      buildId: 'build-2',
    },
  ],
  reviews: [
    {
      stage: 'requirements-analysis',
      unit: null,
      reviewer: 'aidlc-product-lead-agent',
      status: 'ready',
      class: 'adversarial',
      verdict: 'READY',
      buildPhaseMs: 3200,
      buildId: 'build-3',
    },
  ],
  gates: [
    {
      stage: 'requirements-analysis',
      unit: null,
      status: 'applied',
      commandId: '33333333-3333-4333-8333-333333333333',
    },
  ],
  ...patch,
});
const openGate = () => ({
  workflowCompletion: 'not_verified',
  humanApproval: 'incomplete',
  effectivePlan: {
    ...engine().effectivePlan,
    stages: [
      { id: 'workspace-detection', phase: 'initialization', action: 'EXECUTE', state: 'completed' },
      {
        id: 'requirements-analysis',
        phase: 'inception',
        action: 'EXECUTE',
        state: 'awaiting-approval',
      },
    ],
  },
  engineApplication: [
    {
      ...engine().engineApplication[1],
      actorId: 'member-one',
      application: 'pending',
      effect: null,
    },
  ],
  gates: [{ ...engine().gates[0], status: 'not_recorded', commandId: null }],
});
const heading = () => screen.getByRole('heading', { level: 3 });
const completed = /recorded completion with the applied plan and its required evidence/;
const failed = /recorded a failed outcome/;
const unestablished = /Verified workflow completion has not been established for this revision/;

it('reports complete only from protected engine evidence and lets the member inspect it', async () => {
  mocks.read.mockResolvedValue(engine());
  render(<NativeCompletionEvidence {...props} />);
  await screen.findByText(completed);
  expect(heading()).toHaveTextContent(/^Workflow completion: complete$/);
  expect(
    screen.getByText(/Evidence is bound to publication 1 and its exact files/),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Checks: passed. Reviews: ready. Human gates: applied.'),
  ).toBeInTheDocument();
  expect(screen.queryByText(failed)).not.toBeInTheDocument();
  expect(screen.queryByText(unestablished)).not.toBeInTheDocument();
  expect(screen.queryByText(/not independently recorded/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();

  const summary = screen.getByText('Inspect applied plan and outcomes');
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  expect(screen.getByText(`Files: ${'f'.repeat(64)}`)).not.toBeVisible();
  fireEvent.click(summary);
  if (!details.open) details.open = true; // jsdom may not toggle <details> on click.
  const inside = within(details);
  expect(inside.getByText('Selected plan: feature')).toBeVisible();
  expect(inside.getByText('workspace-detection: execute · completed')).toBeVisible();
  expect(inside.getByText('requirements-analysis: execute · completed')).toBeVisible();
  expect(inside.getByText('user-stories: skip · skipped')).toBeVisible();
  const checks = within(inside.getByRole('list', { name: 'Observed checks' }));
  expect(checks.getByText('requirements-analysis · required-sections: passed')).toBeVisible();
  expect(checks.getByText('code-generation / unit-a · type-check: budget exceeded')).toBeVisible();
  const reviews = within(inside.getByRole('list', { name: 'Independent reviews' }));
  expect(
    reviews.getByText(
      /requirements-analysis · aidlc-product-lead-agent: ready \(required adversarial\).*Recorded verdict READY.*BUILD phase: 3200 ms.*Reviewer token usage unavailable/,
    ),
  ).toBeVisible();
  const decisions = within(inside.getByRole('list', { name: 'Applied member decisions' }));
  expect(decisions.getByText('Plan selection · member-one: applied')).toBeVisible();
  expect(decisions.getByText('requirements-analysis · member-two: applied')).toBeVisible();
  expect(inside.getByText(`Files: ${'f'.repeat(64)}`)).toBeVisible();
});
it('names a composed plan and omits empty outcome lists', async () => {
  mocks.read.mockResolvedValue(
    engine({
      requiredChecks: 'not_required',
      finalReview: 'not_required',
      humanApproval: 'not_required',
      effectivePlan: { ...engine().effectivePlan, name: 'tailored plan' },
      engineApplication: [],
      checks: [],
      reviews: [],
      gates: [],
    }),
  );
  render(<NativeCompletionEvidence {...props} />);
  await screen.findByText('Selected plan: tailored plan');
  expect(
    screen.getByText('Checks: not required. Reviews: not required. Human gates: not required.'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Observed checks', hidden: true })).toBeNull();
  expect(screen.queryByRole('list', { name: 'Independent reviews', hidden: true })).toBeNull();
  expect(screen.queryByRole('list', { name: 'Applied member decisions', hidden: true })).toBeNull();
});
it('tells the member that a reply was not applied as a decision', async () => {
  mocks.read.mockResolvedValue(
    engine({
      ...openGate(),
      engineApplication: [],
      unappliedReplies: [
        {
          commandId: '22222222-2222-4222-8222-222222222222',
          interactionId: 'c'.repeat(64),
          actorId: 'member-one',
          sequence: 2,
          reason: 'no_recorded_question',
        },
      ],
    }),
  );
  render(<NativeCompletionEvidence {...props} />);
  const notice = await screen.findByRole('note', { name: 'Replies not applied as decisions' });
  expect(notice).toHaveTextContent(
    'A reply was accepted but not applied as a workflow decision: it did not answer a question the workflow engine had recorded.',
  );
  expect(notice).toHaveTextContent('It answered, approved and selected nothing.');
  expect(notice).toHaveTextContent('Turn 2 · member-one');
  // It is shown without opening the details and is not a member decision.
  expect(notice.closest('details')).toBeNull();
  expect(heading()).toHaveTextContent('Workflow completion: not verified');
  expect(screen.queryByRole('list', { name: 'Applied member decisions', hidden: true })).toBeNull();
});
it('shows no such notice when every accepted reply answered a recorded question', async () => {
  mocks.read.mockResolvedValue(engine({ unappliedReplies: [] }));
  render(<NativeCompletionEvidence {...props} />);
  await screen.findByText(completed);
  expect(screen.queryByRole('note', { name: 'Replies not applied as decisions' })).toBeNull();
});
it('reports a protected failed outcome as failed, never as complete', async () => {
  mocks.read.mockResolvedValue(
    engine({
      workflowCompletion: 'failed',
      requiredChecks: 'failed',
      finalReview: 'concerns',
      checks: [{ ...engine().checks[0], status: 'failed' }],
      reviews: [{ ...engine().reviews[0], status: 'concerns' }],
    }),
  );
  render(<NativeCompletionEvidence {...props} />);
  await screen.findByText(failed);
  expect(heading()).toHaveTextContent(/^Workflow completion: failed$/);
  expect(
    screen.getByText('Checks: failed. Reviews: concerns. Human gates: applied.'),
  ).toBeInTheDocument();
  expect(screen.queryByText(completed)).not.toBeInTheDocument();
  expect(screen.queryByText(unestablished)).not.toBeInTheDocument();
});
it.each<[string, Record<string, unknown>, string]>([
  [
    'a stopped turn with no terminal outcome',
    {
      requiredChecks: 'incomplete',
      effectivePlan: {
        ...engine().effectivePlan,
        stages: [
          {
            id: 'requirements-analysis',
            phase: 'inception',
            action: 'EXECUTE',
            state: 'in-progress',
          },
        ],
      },
      checks: [{ ...engine().checks[0], status: 'not_recorded' }],
    },
    'Checks: incomplete. Reviews: ready. Human gates: applied.',
  ],
  [
    'a human gate that is still open',
    openGate(),
    'Checks: passed. Reviews: ready. Human gates: incomplete.',
  ],
  [
    'result files that changed after the engine finished',
    {},
    'Checks: passed. Reviews: ready. Human gates: applied.',
  ],
  [
    'an engine that has not recorded a plan',
    {
      requiredChecks: 'not_required',
      finalReview: 'not_required',
      humanApproval: 'not_required',
      effectivePlan: 'not_recorded',
      engineApplication: [],
      checks: [],
      reviews: [],
      gates: [],
    },
    'Checks: not required. Reviews: not required. Human gates: not required.',
  ],
])('keeps protected evidence for %s not verified', async (_case, patch, summary) => {
  mocks.read.mockResolvedValue(engine({ workflowCompletion: 'not_verified', ...patch }));
  render(<NativeCompletionEvidence {...props} />);
  await screen.findByText(unestablished);
  expect(heading()).toHaveTextContent(/^Workflow completion: not verified$/);
  expect(screen.getByText(summary)).toBeInTheDocument();
  expect(screen.queryByText(completed)).not.toBeInTheDocument();
  expect(screen.queryByText(failed)).not.toBeInTheDocument();
  if (patch.effectivePlan === 'not_recorded')
    expect(
      screen.getByText('The engine has not recorded an effective plan yet.'),
    ).toBeInTheDocument();
});
it.each(['delivered', 'uncertain'])(
  'does not treat an accepted, %s member selection as engine application or completion',
  async (decisionDelivery) => {
    mocks.read.mockResolvedValue({
      ...engine(openGate()),
      memberDecision: value('Approve').memberDecision,
      decisionDelivery,
    });
    render(<NativeCompletionEvidence {...props} />);
    await screen.findByText(/Approve · requirements-analysis · member-one/);
    expect(heading()).toHaveTextContent(/^Workflow completion: not verified$/);
    expect(screen.getByText(unestablished)).toBeInTheDocument();
    expect(screen.getByText(/Human gates: incomplete\./)).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`Runtime delivery: ${decisionDelivery}\\.`)),
    ).toBeInTheDocument();
    expect(screen.getByText(/does not approve later changed bytes/)).toBeInTheDocument();
    expect(screen.getByText('requirements-analysis · member-one: pending')).toBeInTheDocument();
    expect(
      screen.getByText('requirements-analysis: execute · awaiting-approval'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/: applied$/)).not.toBeInTheDocument();
    expect(screen.queryByText(completed)).not.toBeInTheDocument();
    expect(screen.queryByText(failed)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
  },
);
it.each<[string, Record<string, unknown>]>([
  ['a recognized definition', {}],
  ['an explicit not-verified verdict', { workflowCompletion: 'not_verified' }],
  ['an accepted Approve selection', { memberDecision: value('Approve').memberDecision }],
  ['an unsupported package', { definition: null, policyStatus: 'unsupported' }],
])('keeps legacy evidence with %s not verified and unchanged', async (_case, patch) => {
  mocks.read.mockResolvedValue({ ...value(), ...patch });
  render(<NativeCompletionEvidence {...props} />);
  await screen.findByText(
    /The effective selected plan, amendments and applicable requirements are not independently recorded\./,
  );
  expect(heading()).toHaveTextContent(/^Workflow completion: not verified$/);
  expect(
    screen.getByText(/Missing policy evidence does not mean approval is unnecessary/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      /Required check and review outcomes, engine application of human decisions and a terminal workflow outcome are not independently recorded for these exact result bytes\./,
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/A stopped or cancelled runtime does not prove completion\./),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Evidence is bound to publication/)).not.toBeInTheDocument();
  expect(screen.queryByText('Inspect applied plan and outcomes')).not.toBeInTheDocument();
  expect(screen.queryByText(/Checks: /)).not.toBeInTheDocument();
  expect(screen.queryByText(completed)).not.toBeInTheDocument();
  expect(screen.queryByText(failed)).not.toBeInTheDocument();
});
it.each(['complete', 'failed'])(
  'never shows %s while evidence is loading, reloading or unavailable',
  async (workflowCompletion) => {
    const first = pending();
    const second = pending();
    mocks.read
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce({ status: 403 });
    const settled = workflowCompletion === 'complete' ? completed : failed;
    render(<NativeCompletionEvidence {...props} />);
    expect(screen.getByText(/Loading evidence for publication 1/)).toBeInTheDocument();
    expect(heading()).toHaveTextContent(/^Workflow completion: not verified$/);

    await act(async () => first.resolve(engine({ workflowCompletion })));
    expect(heading()).toHaveTextContent(new RegExp(`^Workflow completion: ${workflowCompletion}$`));
    expect(screen.getByText(settled)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh evidence' }));
    expect(screen.getByText(/Loading evidence for publication 1/)).toBeInTheDocument();
    expect(heading()).toHaveTextContent(/^Workflow completion: not verified$/);
    expect(screen.queryByText(settled)).not.toBeInTheDocument();
    await act(async () => second.resolve(engine({ workflowCompletion })));
    expect(heading()).toHaveTextContent(new RegExp(`^Workflow completion: ${workflowCompletion}$`));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh evidence' }));
    await screen.findByText(/Completion evidence is unavailable/);
    expect(heading()).toHaveTextContent(/^Workflow completion: not verified$/);
    expect(screen.queryByText(settled)).not.toBeInTheDocument();
    expect(screen.queryByText(/Evidence is bound to publication/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry evidence' }));
    await vi.waitFor(() => expect(props.onAccessFailure).toHaveBeenCalledWith({ status: 403 }));
    expect(heading()).toHaveTextContent(/^Workflow completion: not verified$/);
    expect(screen.queryByText(settled)).not.toBeInTheDocument();
  },
);
it('does not carry a completed result over to another publication that is still loading', async () => {
  const next = pending();
  mocks.read.mockResolvedValueOnce(engine()).mockReturnValueOnce(next.promise);
  const rendered = render(<NativeCompletionEvidence {...props} />);
  await screen.findByText(completed);
  rendered.rerender(
    <NativeCompletionEvidence
      {...props}
      target={{ publicationId: 'b'.repeat(64), publicationSequence: 2 }}
    />,
  );
  expect(screen.getByText(/Loading evidence for publication 2/)).toBeInTheDocument();
  expect(heading()).toHaveTextContent(/^Workflow completion: not verified$/);
  expect(screen.queryByText(completed)).not.toBeInTheDocument();
  await act(async () =>
    next.resolve({
      ...engine({ workflowCompletion: 'not_verified' }),
      publicationId: 'b'.repeat(64),
      publicationSequence: 2,
    }),
  );
  expect(heading()).toHaveTextContent(/^Workflow completion: not verified$/);
  expect(screen.getByText(unestablished)).toBeInTheDocument();
  expect(
    screen.getByText(/Evidence is bound to publication 2 and its exact files/),
  ).toBeInTheDocument();
});

it.each([
  [
    'failed checks',
    { requiredChecks: 'failed' },
    'Checks: failed. Reviews: ready. Human gates: applied.',
  ],
  [
    'reviewer concerns',
    { finalReview: 'concerns' },
    'Checks: passed. Reviews: concerns. Human gates: applied.',
  ],
])(
  'does not describe an engine completion with %s as fully evidenced',
  async (_label, patch, line) => {
    mocks.read.mockResolvedValue(engine(patch));
    render(<NativeCompletionEvidence {...props} />);
    await screen.findByText(/with the failed checks or reviewer concerns shown below/);
    expect(heading()).toHaveTextContent(/^Workflow completion: complete$/);
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByText(completed)).not.toBeInTheDocument();
  },
);
