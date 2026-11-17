import { api } from './api';
import type { NativeRevisionTarget } from './nativeHistory';
import { isWorkflowPackageHarness, type WorkflowPackageHarness } from './workflowSources';

export interface NativeWorkflowDefinition {
  protocol: 'aidlc-2.9-content-v1';
  harness: 'codex';
  packageId: string;
  sourceCommit: string;
  stages: {
    id: string;
    name: string;
    phase: string;
    execution: 'ALWAYS' | 'CONDITIONAL';
    condition: string;
    reviewer: string | null;
    reviewClass: 'advisory' | 'adversarial' | null;
    sensors: { id: string; severity: string; fireOn: string }[];
  }[];
  plans: {
    id: string;
    stages: Record<string, 'EXECUTE' | 'SKIP'>;
    reviewCap: 'none' | 'advisory' | 'adversarial' | null;
  }[];
}
export interface NativeCompletionEvidence extends NativeRevisionTarget {
  workflowCompletion: 'complete' | 'failed' | 'not_verified';
  requiredChecks: 'not_recorded' | 'not_required' | 'passed' | 'failed' | 'incomplete';
  finalReview: 'not_recorded' | 'not_required' | 'ready' | 'concerns' | 'incomplete';
  humanApproval: 'not_recorded' | 'not_required' | 'applied' | 'incomplete';
  context: {
    projectId: string;
    executionId: string;
    attemptId: string;
    epoch: number;
    configurationSha256: string;
    packageId: string;
    harness: WorkflowPackageHarness;
  };
  policyStatus: 'definition_recognized' | 'unsupported' | 'protected_engine';
  effectivePlan:
    | 'not_recorded'
    | {
        scope: string;
        name: string | null;
        sha256: string;
        stages: { id: string; phase: string; action: 'EXECUTE' | 'SKIP'; state: string }[];
      };
  engineApplication:
    | 'not_recorded'
    | {
        commandId: string;
        interactionId: string;
        actorId: string;
        stage: string | null;
        sequence: number;
        application: 'pending' | 'applied';
        effect: string | null;
      }[];
  producer?: { profileId: string; imageSha256: string; functionVersion: string };
  filesSha256?: string;
  checks?: {
    stage: string;
    unit: string | null;
    sensor: string;
    status: string;
    buildId: string | null;
  }[];
  reviews?: {
    stage: string;
    unit: string | null;
    reviewer: string;
    status: string;
    class: string;
    buildId: string | null;
  }[];
  gates?: { stage: string; unit: string | null; status: string; commandId: string | null }[];
  /** Accepted replies that named no question the engine recorded. Not decisions. */
  unappliedReplies?: {
    commandId: string;
    interactionId: string;
    actorId: string;
    sequence: number;
    reason: 'no_recorded_question';
  }[];
  definition: NativeWorkflowDefinition | null;
  memberDecision: {
    commandId: string;
    interactionId: string;
    contentSha256: string;
    sequence: number;
    epoch: number;
    actorId: string;
    acceptedAt: string;
    membershipRecorded: boolean;
    presentedStage: string;
    label: string;
    additionalText: boolean;
  } | null;
  decisionDelivery: 'delivered' | 'uncertain' | 'unknown' | null;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2000;
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const reviewClasses = [null, 'none', 'advisory', 'adversarial'];
function invalid(): never {
  throw new Error('Completion evidence is unavailable or could not be verified.');
}
function protectedEvidence(value: Record<string, unknown>): boolean {
  if (value.policyStatus !== 'protected_engine') return false;
  if (
    !record(value.producer) ||
    value.producer.profileId !== 'aidlc-2.11.1-native-1' ||
    !sha(value.producer.imageSha256) ||
    typeof value.producer.functionVersion !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.producer.functionVersion) ||
    !sha(value.filesSha256) ||
    !['complete', 'failed', 'not_verified'].includes(String(value.workflowCompletion)) ||
    !['captured', 'unknown'].includes(String(value.requirementsStatus)) ||
    !['not_required', 'passed', 'failed', 'incomplete'].includes(String(value.requiredChecks)) ||
    !['not_required', 'ready', 'concerns', 'incomplete'].includes(String(value.finalReview)) ||
    !['not_required', 'applied', 'incomplete'].includes(String(value.humanApproval)) ||
    ![
      'result_files_changed',
      'protected_engine_completed',
      'protected_engine_failed',
      'required_evidence_incomplete',
      'workflow_not_terminal',
    ].includes(String(value.reason))
  )
    invalid();
  const plan = value.effectivePlan;
  if (plan !== 'not_recorded') {
    if (
      !record(plan) ||
      !text(plan.scope) ||
      !(plan.name === null || text(plan.name)) ||
      !sha(plan.sha256) ||
      !Array.isArray(plan.stages) ||
      !plan.stages.length ||
      plan.stages.length > 64 ||
      plan.stages.some(
        (stage) =>
          !record(stage) ||
          !text(stage.id) ||
          !text(stage.phase) ||
          !['EXECUTE', 'SKIP'].includes(String(stage.action)) ||
          ![
            'pending',
            'in-progress',
            'awaiting-approval',
            'revising',
            'completed',
            'skipped',
          ].includes(String(stage.state)),
      ) ||
      new Set(plan.stages.map((stage) => stage.id)).size !== plan.stages.length
    )
      invalid();
  }
  if (
    !Array.isArray(value.engineApplication) ||
    value.engineApplication.length > 2000 ||
    value.engineApplication.some(
      (decision) =>
        !record(decision) ||
        !uuid(decision.commandId) ||
        !sha(decision.interactionId) ||
        !text(decision.actorId) ||
        !(decision.stage === null || text(decision.stage)) ||
        !positive(decision.sequence) ||
        !['pending', 'applied'].includes(String(decision.application)) ||
        !(decision.effect === null || text(decision.effect)),
    )
  )
    invalid();
  for (const [key, statuses] of [
    ['checks', ['passed', 'failed', 'unavailable', 'budget_exceeded', 'stale', 'not_recorded']],
    ['reviews', ['ready', 'concerns', 'stale', 'not_recorded']],
    ['gates', ['applied', 'not_recorded']],
  ] as const) {
    const rows = value[key];
    if (
      !Array.isArray(rows) ||
      rows.length > 2000 ||
      rows.some(
        (row) =>
          !record(row) ||
          !text(row.stage) ||
          !(row.unit === null || text(row.unit)) ||
          !(statuses as readonly string[]).includes(String(row.status)) ||
          (key === 'checks' && !text(row.sensor)) ||
          (key === 'reviews' &&
            (!text(row.reviewer) || !['advisory', 'adversarial'].includes(String(row.class)))),
      )
    )
      invalid();
  }
  // Absent in evidence written before the engine recorded such replies.
  const unapplied = value.unappliedReplies;
  if (
    unapplied !== undefined &&
    (!Array.isArray(unapplied) ||
      unapplied.length > 2000 ||
      unapplied.some(
        (reply) =>
          !record(reply) ||
          !uuid(reply.commandId) ||
          !sha(reply.interactionId) ||
          !text(reply.actorId) ||
          !positive(reply.sequence) ||
          reply.reason !== 'no_recorded_question',
      ))
  )
    invalid();
  const terminal = value.terminalOutcome;
  if (
    terminal !== 'not_recorded' &&
    (!record(terminal) ||
      !text(terminal.event) ||
      !text(terminal.status) ||
      !sha(terminal.auditSha256) ||
      !sha(terminal.stateSha256))
  )
    invalid();
  if (
    value.workflowCompletion === 'complete' &&
    (plan === 'not_recorded' ||
      !record(terminal) ||
      terminal.event !== 'WORKFLOW_COMPLETED' ||
      terminal.status !== 'Completed' ||
      value.reason !== 'protected_engine_completed')
  )
    invalid();
  if (
    value.workflowCompletion === 'failed' &&
    (!record(terminal) || terminal.event !== 'WORKFLOW_FAILED' || terminal.status !== 'Failed')
  )
    invalid();
  return true;
}
function decodeDefinition(
  value: unknown,
  packageId: unknown,
  harness: unknown,
): NativeWorkflowDefinition | null {
  if (value === null) return null;
  if (
    !record(value) ||
    value.protocol !== 'aidlc-2.9-content-v1' ||
    value.harness !== 'codex' ||
    value.harness !== harness ||
    value.packageId !== packageId ||
    typeof value.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    !Array.isArray(value.stages) ||
    !value.stages.length ||
    value.stages.length > 64 ||
    !Array.isArray(value.plans) ||
    !value.plans.length ||
    value.plans.length > 32
  )
    invalid();
  for (const s of value.stages) {
    if (
      !record(s) ||
      ![s.id, s.name, s.phase, s.condition].every(text) ||
      !['ALWAYS', 'CONDITIONAL'].includes(String(s.execution)) ||
      !(s.reviewer === null || text(s.reviewer)) ||
      !reviewClasses.includes(s.reviewClass as string | null) ||
      !Array.isArray(s.sensors) ||
      s.sensors.length > 64 ||
      !s.sensors.every((c) => record(c) && [c.id, c.severity, c.fireOn].every(text))
    )
      invalid();
  }
  const ids = value.stages.map((s) => s.id);
  if (new Set(ids).size !== ids.length) invalid();
  for (const p of value.plans) {
    if (
      !record(p) ||
      !text(p.id) ||
      !reviewClasses.includes(p.reviewCap as string | null) ||
      !record(p.stages) ||
      Object.keys(p.stages).length !== ids.length ||
      !ids.every((id) =>
        ['EXECUTE', 'SKIP'].includes(String((p.stages as Record<string, unknown>)[id])),
      )
    )
      invalid();
  }
  return value as unknown as NativeWorkflowDefinition;
}

export const nativeCompletionService = {
  async read(
    projectId: string,
    executionId: string,
    attemptId: string,
    target: NativeRevisionTarget,
  ): Promise<NativeCompletionEvidence> {
    if (!sha(target.publicationId) || !positive(target.publicationSequence) || !uuid(attemptId))
      invalid();
    const query = new URLSearchParams({
      publicationId: target.publicationId,
      publicationSequence: String(target.publicationSequence),
      evidence: '1',
    });
    const value = await api.get<unknown>(
      `/projects/${encodeURIComponent(projectId)}/native-intents/${encodeURIComponent(executionId)}/publication?${query}`,
    );
    if (
      !record(value) ||
      value.schemaVersion !== 1 ||
      !record(value.context) ||
      value.context.projectId !== projectId ||
      value.context.executionId !== executionId ||
      value.context.attemptId !== attemptId ||
      !positive(value.context.epoch) ||
      !sha(value.context.configurationSha256) ||
      typeof value.context.packageId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(value.context.packageId) ||
      !isWorkflowPackageHarness(value.context.harness) ||
      value.publicationId !== target.publicationId ||
      value.publicationSequence !== target.publicationSequence ||
      value.policy !== 'pinned_workflow'
    )
      invalid();
    const protectedResult = protectedEvidence(value);
    if (
      !protectedResult &&
      (value.workflowCompletion !== 'not_verified' ||
        value.requirementsStatus !== 'unknown' ||
        ![
          'requiredChecks',
          'finalReview',
          'humanApproval',
          'effectivePlan',
          'engineApplication',
          'terminalOutcome',
        ].every((key) => value[key] === 'not_recorded'))
    )
      invalid();
    const definition = decodeDefinition(
      value.definition,
      value.context.packageId,
      value.context.harness,
    );
    if (
      !protectedResult &&
      (value.policyStatus !== (definition ? 'definition_recognized' : 'unsupported') ||
        value.reason !==
          (definition
            ? 'protected_effective_plan_and_outcomes_unavailable'
            : 'unsupported_package_protocol'))
    )
      invalid();
    const d = value.memberDecision;
    if (d !== null) {
      if (
        !record(d) ||
        d.status !== 'recorded' ||
        d.origin !== 'protected_member_selection' ||
        !uuid(d.commandId) ||
        !sha(d.interactionId) ||
        !sha(d.contentSha256) ||
        d.sequence !== target.publicationSequence + 1 ||
        d.epoch !== value.context.epoch ||
        ![d.actorId, d.presentedStage, d.label].every(text) ||
        typeof d.acceptedAt !== 'string' ||
        !Number.isFinite(Date.parse(d.acceptedAt)) ||
        typeof d.additionalText !== 'boolean' ||
        typeof d.membershipRecorded !== 'boolean' ||
        d.applicationStatus !== 'not_recorded' ||
        !['delivered', 'uncertain', 'unknown'].includes(String(value.decisionDelivery))
      )
        invalid();
    } else if (value.decisionDelivery !== null) invalid();
    return { ...value, definition } as unknown as NativeCompletionEvidence;
  },
};
