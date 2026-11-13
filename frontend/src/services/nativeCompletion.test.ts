import { beforeEach, expect, it, vi } from 'vitest';
import definition from '../../../lambda/shared/native-workflow-policy-data.json';
import { nativeCompletionService } from './nativeCompletion';
const get = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api: { get } }));
const target = { publicationId: 'a'.repeat(64), publicationSequence: 2 };
const attemptId = '11111111-1111-4111-8111-111111111111';
const view = () => ({
  schemaVersion: 1,
  ...target,
  context: {
    projectId: 'p',
    executionId: 'e',
    attemptId,
    epoch: 1,
    configurationSha256: 'b'.repeat(64),
    packageId: definition.packageId,
    harness: 'codex',
  },
  workflowCompletion: 'not_verified',
  requiredChecks: 'not_recorded',
  finalReview: 'not_recorded',
  humanApproval: 'not_recorded',
  policy: 'pinned_workflow',
  requirementsStatus: 'unknown',
  policyStatus: 'definition_recognized',
  reason: 'protected_effective_plan_and_outcomes_unavailable',
  definition: structuredClone(definition),
  effectivePlan: 'not_recorded',
  engineApplication: 'not_recorded',
  terminalOutcome: 'not_recorded',
  memberDecision: null as Record<string, unknown> | null,
  decisionDelivery: null as string | null,
});
const decision = () => ({
  status: 'recorded',
  origin: 'protected_member_selection',
  commandId: attemptId,
  interactionId: 'c'.repeat(64),
  contentSha256: 'd'.repeat(64),
  sequence: 3,
  epoch: 1,
  actorId: 'member-one',
  acceptedAt: '2026-10-14T12:00:00Z',
  membershipRecorded: true,
  presentedStage: 'requirements-analysis',
  label: 'Approve',
  additionalText: false,
  applicationStatus: 'not_recorded',
});
const read = () => nativeCompletionService.read('p', 'e', attemptId, target);
beforeEach(() => get.mockReset());
it('decodes exact pinned definition data without selecting a plan, using a scoped protected GET', async () => {
  get.mockResolvedValue(view());
  const evidence = await read();
  expect(evidence.definition?.plans).toHaveLength(11);
  expect(get).toHaveBeenCalledWith(
    expect.stringContaining(
      `/projects/p/native-intents/e/publication?publicationId=${target.publicationId}&publicationSequence=2&evidence=1`,
    ),
  );
});
it('accepts unsupported retained policy as unknown rather than not-required', async () => {
  get.mockResolvedValue({
    ...view(),
    definition: null,
    policyStatus: 'unsupported',
    reason: 'unsupported_package_protocol',
  });
  expect((await read()).definition).toBeNull();
});
it('keeps a protected selection distinct from engine application and delivery', async () => {
  get.mockResolvedValue({ ...view(), memberDecision: decision(), decisionDelivery: 'uncertain' });
  expect((await read()).memberDecision?.label).toBe('Approve');
});
it.each(['claude', 'codex', 'kiro', 'opencode'])(
  'preserves protected decisions for supported harness %s with an unknown definition',
  async (harness) => {
    get.mockResolvedValue({
      ...view(),
      context: { ...view().context, harness },
      definition: null,
      policyStatus: 'unsupported',
      reason: 'unsupported_package_protocol',
      memberDecision: decision(),
      decisionDelivery: 'delivered',
    });
    const evidence = await read();
    expect(evidence.context.harness).toBe(harness);
    expect(evidence.memberDecision?.label).toBe('Approve');
    expect(evidence.decisionDelivery).toBe('delivered');
    expect(evidence.definition).toBeNull();
  },
);
it.each(['future-harness', 'OpenCode', null, 1])(
  'rejects unknown harness %j even when no definition is recognized',
  async (harness) => {
    get.mockResolvedValue({
      ...view(),
      context: { ...view().context, harness },
      definition: null,
      policyStatus: 'unsupported',
      reason: 'unsupported_package_protocol',
    });
    await expect(read()).rejects.toThrow(/could not be verified/);
  },
);
it.each([
  { publicationId: 'f'.repeat(64) },
  { publicationSequence: 3 },
  { schemaVersion: 2 },
  { workflowCompletion: 'verified' },
  { requirementsStatus: 'not_required' },
  { humanApproval: 'approved' },
  { engineApplication: 'applied' },
  { terminalOutcome: 'complete' },
  { policyStatus: 'unsupported' },
  { definition: null },
  { reason: 'approved_by_human' },
])('rejects wrong result identities or unsupported completion claims %j', async (patch) => {
  get.mockResolvedValue({ ...view(), ...patch });
  await expect(read()).rejects.toThrow(/could not be verified/);
});
it.each([
  { projectId: 'other' },
  { executionId: 'other' },
  { attemptId: '22222222-2222-4222-8222-222222222222' },
  { configurationSha256: 'invalid' },
  { packageId: 'sha256:' + 'f'.repeat(64) },
  { epoch: 0 },
  { harness: 'claude' },
])('rejects foreign or invalid evidence scope %j', async (patch) => {
  const value = view();
  get.mockResolvedValue({ ...value, context: { ...value.context, ...patch } });
  await expect(read()).rejects.toThrow();
});
it.each([
  { epoch: 2 },
  { sequence: 2 },
  { contentSha256: 'bad' },
  { applicationStatus: 'applied' },
  { origin: 'agent_report' },
  { acceptedAt: 'never' },
  { membershipRecorded: 'yes' },
])('rejects stale or unprotected member decisions %j', async (patch) => {
  get.mockResolvedValue({
    ...view(),
    memberDecision: { ...decision(), ...patch },
    decisionDelivery: 'delivered',
  });
  await expect(read()).rejects.toThrow();
});
it('rejects malformed and unknown definition protocols and incomplete plan inventories', async () => {
  for (const patch of [
    { protocol: 'future' },
    { stages: [] },
    { plans: [{ ...definition.plans[0], stages: {} }] },
  ]) {
    get.mockResolvedValue({ ...view(), definition: { ...definition, ...patch } });
    await expect(read()).rejects.toThrow();
  }
});

// Protected workflow-engine evidence (NE-11). The fixture carries every field
// the engine evidence view emits, including ones this boundary does not read.
const hex = (digit: string) => digit.repeat(64);
const enginePackageId = 'sha256:577eced0d4425aba7cd4fdaec100315363e104d28fa47f1aec141aac606dfb56';
const stage = (id: string, phase: string, action: string, state: string) => ({
  id,
  phase,
  action,
  state,
  review: { role: null, class: 'none' },
  sensors: [],
});
const plan = () => ({
  scope: 'feature',
  name: null as string | null,
  sha256: hex('3'),
  ceremony: { sensors: { key: 'sensors', value: 'on', source: 'default' } },
  stages: [
    stage('workspace-detection', 'initialization', 'EXECUTE', 'completed'),
    stage('requirements-analysis', 'inception', 'EXECUTE', 'completed'),
    stage('user-stories', 'inception', 'SKIP', 'skipped'),
  ],
});
const terminal = () => ({
  event: 'WORKFLOW_COMPLETED',
  auditSha256: hex('4'),
  status: 'Completed',
  stateSha256: hex('5'),
});
const applied = () => ({
  commandId: attemptId,
  interactionId: hex('c'),
  contentSha256: hex('d'),
  textSha256: hex('e'),
  actorId: 'member-one',
  sequence: 3,
  stage: 'requirements-analysis' as string | null,
  unit: null,
  presentationSha256: hex('6'),
  application: 'applied',
  effect: 'GATE_APPROVED' as string | null,
  auditSha256: hex('7') as string | null,
});
const check = () => ({
  stage: 'requirements-analysis',
  unit: null as string | null,
  sensor: 'required-sections',
  status: 'passed',
  fireId: 'fire-1',
  auditSha256: hex('8'),
  inspectedFilesSha256: hex('2'),
  checkedPath: 'aidlc-docs/inception/requirements',
  checkedSha256: hex('9'),
  sourceSha256: null,
  buildId: 'build-1',
  note: null,
});
const review = () => ({
  stage: 'requirements-analysis',
  unit: null as string | null,
  reviewer: 'aidlc-product-lead-agent',
  class: 'adversarial',
  status: 'ready',
  verdict: 'READY',
  requestId: 'review-1',
  auditSha256: hex('0'),
  buildId: 'build-2',
  inspectedFilesSha256: hex('2'),
  reviewSha256: hex('1'),
  acceptedChanges: [],
});
const gate = () => ({
  stage: 'requirements-analysis',
  unit: null as string | null,
  status: 'applied',
  commandId: attemptId as string | null,
  auditSha256: hex('7') as string | null,
});
const producer = () => ({
  profileId: 'aidlc-2.11.1-native-1',
  imageSha256: hex('1'),
  functionVersion: '7',
});
const engine = (patch: Record<string, unknown> = {}) => ({
  ...view(),
  context: { ...view().context, packageId: enginePackageId },
  definition: null,
  workflowCompletion: 'complete',
  requiredChecks: 'passed',
  finalReview: 'ready',
  humanApproval: 'applied',
  requirementsStatus: 'captured',
  policyStatus: 'protected_engine',
  reason: 'protected_engine_completed',
  producer: producer(),
  filesSha256: hex('2'),
  effectivePlan: plan(),
  engineApplication: [applied()],
  terminalOutcome: terminal(),
  checks: [check()],
  reviews: [review()],
  gates: [gate()],
  ...patch,
});
type Patch = Record<string, unknown>;
const failure = (patch: Patch = {}) =>
  engine({
    workflowCompletion: 'failed',
    reason: 'protected_engine_failed',
    terminalOutcome: { ...terminal(), event: 'WORKFLOW_FAILED', status: 'Failed' },
    ...patch,
  });
const withPlan = (patch: Patch) => ({ effectivePlan: { ...plan(), ...patch } });
const withStage = (patch: Patch) =>
  withPlan({ stages: [{ ...plan().stages[0], ...patch }, ...plan().stages.slice(1)] });
const withTerminal = (patch: Patch) => ({ terminalOutcome: { ...terminal(), ...patch } });
const withProducer = (patch: Patch) => ({ producer: { ...producer(), ...patch } });
const withDecision = (patch: Patch) => ({ engineApplication: [{ ...applied(), ...patch }] });
const withCheck = (patch: Patch) => ({ checks: [{ ...check(), ...patch }] });
const withReview = (patch: Patch) => ({ reviews: [{ ...review(), ...patch }] });
const withGate = (patch: Patch) => ({ gates: [{ ...gate(), ...patch }] });
const openGate = () => ({
  workflowCompletion: 'not_verified',
  reason: 'required_evidence_incomplete',
  humanApproval: 'incomplete',
  terminalOutcome: 'not_recorded',
  ...withPlan({
    stages: plan().stages.map((item) =>
      item.id === 'requirements-analysis' ? { ...item, state: 'awaiting-approval' } : item,
    ),
  }),
  ...withDecision({ application: 'pending', effect: null, auditSha256: null }),
  ...withGate({ status: 'not_recorded', commandId: null, auditSha256: null }),
});

it('accepts protected-engine completion bound to the requested publication', async () => {
  get.mockResolvedValue(engine());
  const evidence = await read();
  expect(evidence).toEqual(engine());
  expect(evidence.workflowCompletion).toBe('complete');
  expect(evidence.policyStatus).toBe('protected_engine');
  expect(evidence.definition).toBeNull();
});
it('accepts a protected failed outcome as failed, not as complete', async () => {
  get.mockResolvedValue(
    failure({ requiredChecks: 'failed', ...withCheck({ status: 'failed', note: 'exit 1' }) }),
  );
  const evidence = await read();
  expect(evidence.workflowCompletion).toBe('failed');
  expect(evidence.requiredChecks).toBe('failed');
});
it.each<[string, Patch]>([
  [
    'a stopped turn with no terminal event',
    { reason: 'workflow_not_terminal', terminalOutcome: 'not_recorded' },
  ],
  ['an open gate whose member selection is only pending', openGate()],
  [
    'an accepted member selection that the engine has not applied',
    { ...openGate(), memberDecision: decision(), decisionDelivery: 'delivered' },
  ],
  [
    'an engine that has not recorded a plan',
    {
      reason: 'required_evidence_incomplete',
      requirementsStatus: 'unknown',
      requiredChecks: 'not_required',
      finalReview: 'not_required',
      humanApproval: 'not_required',
      effectivePlan: 'not_recorded',
      terminalOutcome: 'not_recorded',
      engineApplication: [],
      checks: [],
      reviews: [],
      gates: [],
    },
  ],
  ['result files changed after a completed terminal event', { reason: 'result_files_changed' }],
  [
    'a completed terminal event with stale review and unavailable check evidence',
    {
      reason: 'required_evidence_incomplete',
      requiredChecks: 'incomplete',
      finalReview: 'incomplete',
      ...withCheck({ status: 'unavailable', note: 'tool missing' }),
      ...withReview({ status: 'stale' }),
    },
  ],
])('accepts protected evidence for %s only as not verified', async (_case, patch) => {
  get.mockResolvedValue(engine({ workflowCompletion: 'not_verified', ...patch }));
  expect((await read()).workflowCompletion).toBe('not_verified');
});
it('accepts every stage state and row outcome the protected engine reports', async () => {
  const states = [
    'pending',
    'in-progress',
    'awaiting-approval',
    'revising',
    'completed',
    'skipped',
  ];
  const checks = ['passed', 'failed', 'unavailable', 'budget_exceeded', 'stale', 'not_recorded'];
  const reviews = ['ready', 'concerns', 'stale', 'not_recorded'];
  get.mockResolvedValue(
    engine({
      workflowCompletion: 'not_verified',
      reason: 'required_evidence_incomplete',
      requiredChecks: 'failed',
      finalReview: 'incomplete',
      humanApproval: 'incomplete',
      terminalOutcome: 'not_recorded',
      effectivePlan: {
        ...plan(),
        name: 'tailored plan',
        stages: states.map((state, index) =>
          stage(`stage-${index}`, 'construction', index % 2 ? 'SKIP' : 'EXECUTE', state),
        ),
      },
      engineApplication: [
        { ...applied(), stage: null, effect: 'PLAN_PROPOSAL_APPLIED' },
        {
          ...applied(),
          commandId: '22222222-2222-4222-8222-222222222222',
          sequence: 5,
          application: 'pending',
          effect: null,
          auditSha256: null,
        },
      ],
      checks: checks.map((status, index) => ({
        ...check(),
        status,
        unit: index % 2 ? 'unit-a' : null,
      })),
      reviews: reviews.map((status, index) => ({
        ...review(),
        status,
        class: index % 2 ? 'advisory' : 'adversarial',
        unit: index % 2 ? 'unit-a' : null,
      })),
      gates: [gate(), { ...gate(), unit: 'unit-a', status: 'not_recorded', commandId: null }],
    }),
  );
  const evidence = await read();
  expect(evidence.checks?.map((row) => row.status)).toEqual(checks);
  expect(evidence.reviews?.map((row) => row.status)).toEqual(reviews);
  expect(evidence.gates?.map((row) => row.status)).toEqual(['applied', 'not_recorded']);
  expect(evidence.engineApplication).toHaveLength(2);
  expect(evidence.effectivePlan).toMatchObject({ name: 'tailored plan' });
});
it.each<[string, Patch]>([
  ['no terminal outcome', { terminalOutcome: 'not_recorded' }],
  ['a failed terminal outcome', withTerminal({ event: 'WORKFLOW_FAILED', status: 'Failed' })],
  ['a failed terminal event', withTerminal({ event: 'WORKFLOW_FAILED' })],
  ['a terminal status of Failed', withTerminal({ status: 'Failed' })],
  ['a workflow status that is still active', withTerminal({ status: 'In Progress' })],
  ['no effective plan', { effectivePlan: 'not_recorded' }],
  ['reason protected_engine_failed', { reason: 'protected_engine_failed' }],
  ['reason required_evidence_incomplete', { reason: 'required_evidence_incomplete' }],
  ['reason workflow_not_terminal', { reason: 'workflow_not_terminal' }],
  ['reason result_files_changed', { reason: 'result_files_changed' }],
])('rejects a completion claim with %s', async (_case, patch) => {
  get.mockResolvedValue(engine(patch));
  await expect(read()).rejects.toThrow(/could not be verified/);
});
it.each<[string, Patch]>([
  ['no terminal outcome', { terminalOutcome: 'not_recorded' }],
  ['a completed terminal outcome', { terminalOutcome: terminal() }],
  ['a failed event whose status is Completed', withTerminal({ event: 'WORKFLOW_FAILED' })],
  ['a completed event whose status is Failed', withTerminal({ status: 'Failed' })],
])('rejects a failed claim with %s', async (_case, patch) => {
  get.mockResolvedValue(failure(patch));
  await expect(read()).rejects.toThrow(/could not be verified/);
});
it.each(['complete', 'failed'])(
  'rejects a %s claim that the protected engine did not produce',
  async (workflowCompletion) => {
    const unsupported = {
      definition: null,
      policyStatus: 'unsupported',
      reason: 'unsupported_package_protocol',
    };
    const proof = workflowCompletion === 'complete' ? engine() : failure();
    for (const value of [
      { ...view(), workflowCompletion },
      { ...view(), ...unsupported, workflowCompletion },
      { ...view(), workflowCompletion, memberDecision: decision(), decisionDelivery: 'delivered' },
      // Full engine proof cannot be relabelled onto the legacy policy path.
      { ...proof, policyStatus: 'definition_recognized' },
      { ...proof, policyStatus: 'unsupported' },
      { ...proof, policyStatus: 'future_engine' },
      { ...proof, policyStatus: undefined },
      {
        ...proof,
        context: view().context,
        definition: structuredClone(definition),
        policyStatus: 'definition_recognized',
        reason: 'protected_effective_plan_and_outcomes_unavailable',
      },
    ]) {
      get.mockResolvedValue(value);
      await expect(read()).rejects.toThrow(/could not be verified/);
    }
  },
);
it.each<[string, Patch]>([
  ['a missing producer', { producer: undefined }],
  ['an unknown producer profile', withProducer({ profileId: 'aidlc-2.11.0-native-1' })],
  ['a non-hex producer image digest', withProducer({ imageSha256: 'A'.repeat(64) })],
  ['a prefixed producer image digest', withProducer({ imageSha256: `sha256:${hex('1')}` })],
  ['an unpublished function version', withProducer({ functionVersion: '$LATEST' })],
  ['a zero function version', withProducer({ functionVersion: '0' })],
  ['a numeric function version', withProducer({ functionVersion: 7 })],
  ['a missing files digest', { filesSha256: undefined }],
  ['a short files digest', { filesSha256: 'f'.repeat(63) }],
  ['a non-hex plan digest', withPlan({ sha256: 'z'.repeat(64) })],
  ['a non-hex terminal audit digest', withTerminal({ auditSha256: 'audit' })],
  ['a non-hex terminal state digest', withTerminal({ stateSha256: null })],
  ['a terminal outcome without an event', withTerminal({ event: '' })],
  ['an absent terminal outcome', { terminalOutcome: null }],
  ['an unknown completion verdict', { workflowCompletion: 'verified' }],
  ['an unknown requirements status', { requirementsStatus: 'not_required' }],
  ['an unknown check summary', { requiredChecks: 'skipped' }],
  ['an unrecorded check summary', { requiredChecks: 'not_recorded' }],
  ['an unknown review summary', { finalReview: 'approved' }],
  ['an unrecorded review summary', { finalReview: 'not_recorded' }],
  ['an unknown gate summary', { humanApproval: 'approved' }],
  ['an unrecorded gate summary', { humanApproval: 'not_recorded' }],
  ['an unknown reason', { reason: 'approved_by_human' }],
  ['the legacy reason', { reason: 'protected_effective_plan_and_outcomes_unavailable' }],
  ['an absent plan', { effectivePlan: null }],
  ['a plan without a scope', withPlan({ scope: '' })],
  ['a plan with an empty name', withPlan({ name: '' })],
  ['a plan without stages', withPlan({ stages: [] })],
  [
    'a plan with duplicate stage IDs',
    withPlan({ stages: [plan().stages[0], { ...plan().stages[1], id: plan().stages[0].id }] }),
  ],
  [
    'a plan with more stages than a workflow can define',
    withPlan({
      stages: Array.from({ length: 65 }, (_, index) =>
        stage(`stage-${index}`, 'construction', 'EXECUTE', 'completed'),
      ),
    }),
  ],
  ['a stage without an ID', withStage({ id: '' })],
  ['a stage without a phase', withStage({ phase: null })],
  ['an unknown stage action', withStage({ action: 'RUN' })],
  ['an unresolved stage action', withStage({ action: null })],
  ['an unknown stage state', withStage({ state: 'done' })],
  ['an unresolved stage state', withStage({ state: null })],
  ['unrecorded member decisions', { engineApplication: 'not_recorded' }],
  ['a decision with a non-UUID command ID', withDecision({ commandId: 'command' })],
  ['a decision with a non-hex proposal ID', withDecision({ interactionId: 'proposal' })],
  ['a decision without an actor', withDecision({ actorId: '' })],
  ['a decision with a zero sequence', withDecision({ sequence: 0 })],
  ['a decision with an empty stage', withDecision({ stage: '' })],
  ['a decision with an unknown application', withDecision({ application: 'approved' })],
  ['a decision reported as rejected', withDecision({ application: 'rejected' })],
  ['a decision with an empty effect', withDecision({ effect: '' })],
  ['unrecorded checks', { checks: 'not_recorded' }],
  ['missing checks', { checks: undefined }],
  ['a check with an unknown status', withCheck({ status: 'skipped' })],
  ['a check with a review status', withCheck({ status: 'ready' })],
  ['a check without a sensor', withCheck({ sensor: undefined })],
  ['a check without a stage', withCheck({ stage: '' })],
  ['a check with an empty unit', withCheck({ unit: '' })],
  ['missing reviews', { reviews: undefined }],
  ['a review with an unknown status', withReview({ status: 'approved' })],
  ['a review with a check status', withReview({ status: 'passed' })],
  ['a review without a reviewer', withReview({ reviewer: null })],
  ['a review with class none', withReview({ class: 'none' })],
  ['a review with an unknown class', withReview({ class: 'peer' })],
  ['a review without a class', withReview({ class: null })],
  ['missing gates', { gates: undefined }],
  ['a gate with an unknown status', withGate({ status: 'approved' })],
  ['a gate reported as pending', withGate({ status: 'pending' })],
  ['a gate without a stage', withGate({ stage: null })],
])('rejects malformed protected evidence: %s', async (_case, patch) => {
  get.mockResolvedValue(engine(patch));
  await expect(read()).rejects.toThrow(/could not be verified/);
});
it('keeps the legacy not-verified response unchanged, with and without a recognized definition', async () => {
  get.mockResolvedValue(view());
  const recognized = await read();
  expect(recognized).toEqual(view());
  expect(recognized.workflowCompletion).toBe('not_verified');
  const unsupported = {
    ...view(),
    definition: null,
    policyStatus: 'unsupported',
    reason: 'unsupported_package_protocol',
    memberDecision: decision(),
    decisionDelivery: 'delivered',
  };
  get.mockResolvedValue(unsupported);
  expect(await read()).toEqual(unsupported);
});
it.each<[string, Patch]>([
  ['passed checks', { requiredChecks: 'passed' }],
  ['checks that are not required', { requiredChecks: 'not_required' }],
  ['a ready review', { finalReview: 'ready' }],
  ['an applied human gate', { humanApproval: 'applied' }],
  ['a human gate that is not required', { humanApproval: 'not_required' }],
  ['an effective plan', { effectivePlan: plan() }],
  ['applied member decisions', { engineApplication: [applied()] }],
  ['no member decisions', { engineApplication: [] }],
  ['a completed terminal outcome', { terminalOutcome: terminal() }],
  ['captured requirements', { requirementsStatus: 'captured' }],
  ['a protected-engine reason', { reason: 'workflow_not_terminal' }],
])('rejects a legacy-shaped response carrying %s', async (_case, patch) => {
  get.mockResolvedValue({ ...view(), ...patch });
  await expect(read()).rejects.toThrow(/could not be verified/);
  get.mockResolvedValue({
    ...view(),
    definition: null,
    policyStatus: 'unsupported',
    reason: 'unsupported_package_protocol',
    ...patch,
  });
  await expect(read()).rejects.toThrow(/could not be verified/);
});
it.each<[string, Patch]>([
  ['another publication ID', { publicationId: hex('f') }],
  ['another publication sequence', { publicationSequence: 3 }],
  ['no publication ID', { publicationId: undefined }],
  ['another attempt', { context: { ...engine().context, attemptId: hex('1').slice(0, 36) } }],
  ['another run', { context: { ...engine().context, executionId: 'other' } }],
  ['an unsupported schema version', { schemaVersion: 2 }],
  ['another completion policy', { policy: 'platform_approval' }],
  [
    'a member decision for another publication',
    { memberDecision: { ...decision(), sequence: 2 }, decisionDelivery: 'delivered' },
  ],
  [
    'a member decision claiming engine application',
    {
      memberDecision: { ...decision(), applicationStatus: 'applied' },
      decisionDelivery: 'delivered',
    },
  ],
])('rejects protected evidence bound to %s', async (_case, patch) => {
  get.mockResolvedValue(engine(patch));
  await expect(read()).rejects.toThrow(/could not be verified/);
});
it('rejects protected evidence returned for a publication other than the requested one', async () => {
  get.mockResolvedValue(engine());
  const other = { publicationId: hex('f'), publicationSequence: 2 };
  await expect(nativeCompletionService.read('p', 'e', attemptId, other)).rejects.toThrow(
    /could not be verified/,
  );
  await expect(
    nativeCompletionService.read('p', 'e', attemptId, { ...target, publicationSequence: 1 }),
  ).rejects.toThrow(/could not be verified/);
});
