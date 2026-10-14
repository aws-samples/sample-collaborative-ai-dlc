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
