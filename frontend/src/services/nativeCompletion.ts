import { api } from './api';
import type { NativeRevisionTarget } from './nativeHistory';

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
  context: {
    projectId: string;
    executionId: string;
    attemptId: string;
    epoch: number;
    configurationSha256: string;
    packageId: string;
    harness: 'codex' | 'claude' | 'kiro';
  };
  policyStatus: 'definition_recognized' | 'unsupported';
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
      !['codex', 'claude', 'kiro'].includes(String(value.context.harness)) ||
      value.publicationId !== target.publicationId ||
      value.publicationSequence !== target.publicationSequence ||
      value.policy !== 'pinned_workflow' ||
      value.workflowCompletion !== 'not_verified' ||
      value.requirementsStatus !== 'unknown' ||
      ![
        'requiredChecks',
        'finalReview',
        'humanApproval',
        'effectivePlan',
        'engineApplication',
        'terminalOutcome',
      ].every((key) => value[key] === 'not_recorded')
    )
      invalid();
    const definition = decodeDefinition(
      value.definition,
      value.context.packageId,
      value.context.harness,
    );
    if (
      value.policyStatus !== (definition ? 'definition_recognized' : 'unsupported') ||
      value.reason !==
        (definition
          ? 'protected_effective_plan_and_outcomes_unavailable'
          : 'unsupported_package_protocol')
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
