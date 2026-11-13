import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import {
  engineDigest,
  nativeEngineFileDigest,
  nativeEngineAuthoredPath,
  NATIVE_ENGINE_PROFILE,
} from '../../shared/native-workflow-protocol.js';

const latest = (items, predicate) => items.findLast(predicate);
const sameUnit = (a, b) => (a ?? null) === (b ?? null);
const sensorStatus = (event) => {
  if (!event) return 'not_recorded';
  if (event.event === 'SENSOR_BUDGET_OVERRIDE') return 'budget_exceeded';
  if (event.event === 'SENSOR_FAILED') return 'failed';
  return event.note ? 'unavailable' : 'passed';
};

// This is an evidence projection, never a scheduler or a replacement for the
// engine's terminal guards. Applicability comes from the actual directives;
// review freshness and the effective amended plan come from pinned readers.
export const nativeEngineCompletionEvidence = ({
  identity,
  row,
  publication,
  manifest,
  workspace,
  observed,
}) => {
  const state = workspace.state;
  const audit = observed.audit ?? [];
  const requirements = [
    ...new Map(
      state.requirements.map((item) => [canonicalJson([item.stage, item.unit]), item]),
    ).values(),
  ];
  const checks = requirements.flatMap((requirement) =>
    requirement.sensors.map((sensor) => {
      const event = latest(
        audit,
        (event) =>
          event.sensor === sensor &&
          event.stage === requirement.stage &&
          sameUnit(event.unit, requirement.unit) &&
          ['SENSOR_PASSED', 'SENSOR_FAILED', 'SENSOR_BUDGET_OVERRIDE'].includes(event.event),
      );
      const invocation = latest(
        state.observations,
        (item) =>
          item.kind === 'check' &&
          item.stage === requirement.stage &&
          item.sensor === sensor &&
          sameUnit(item.unit, requirement.unit) &&
          item.fireId === event?.fireId &&
          item.auditSha256 === event?.sha256,
      );
      const fresh =
        invocation &&
        invocation.checkedSha256 ===
          nativeEngineFileDigest(
            workspace.files.filter(
              (file) =>
                file.path === invocation.checkedPath ||
                file.path.startsWith(`${invocation.checkedPath}/`),
            ),
          ) &&
        (!invocation.sourceSha256 ||
          invocation.sourceSha256 ===
            nativeEngineFileDigest(
              workspace.files.filter((file) => nativeEngineAuthoredPath(file.path)),
            ));
      return {
        stage: requirement.stage,
        unit: requirement.unit,
        sensor,
        status: event && invocation ? (fresh ? sensorStatus(event) : 'stale') : 'not_recorded',
        fireId: event?.fireId ?? null,
        auditSha256: event?.sha256 ?? null,
        inspectedFilesSha256: invocation?.filesSha256 ?? null,
        checkedPath: invocation?.checkedPath ?? null,
        checkedSha256: invocation?.checkedSha256 ?? null,
        sourceSha256: invocation?.sourceSha256 ?? null,
        buildId: invocation?.buildId ?? null,
        note: event?.note ?? null,
      };
    }),
  );
  const reviews = requirements
    .filter((item) => item.reviewer && item.reviewClass !== 'none')
    .map((requirement) => {
      const event = latest(
        audit,
        (event) =>
          event.event === 'REVIEW_COMPLETED' &&
          event.stage === requirement.stage &&
          event.reviewer === requirement.reviewer &&
          sameUnit(event.unit, requirement.unit),
      );
      const invocation = latest(
        state.observations,
        (item) =>
          item.kind === 'review' &&
          item.requestId === event?.requestId &&
          item.auditSha256 === event?.sha256,
      );
      const freshness = observed.reviews?.find((item) => item.stage === requirement.stage);
      const unit = requirement.unit
        ? freshness?.units.find((item) => item.unit === requirement.unit)
        : null;
      const stale =
        !freshness ||
        freshness.stale ||
        freshness.pending ||
        freshness.invalid ||
        (requirement.unit && (!unit || unit.stale));
      return {
        stage: requirement.stage,
        unit: requirement.unit,
        reviewer: requirement.reviewer,
        class: requirement.reviewClass,
        status:
          !event || !invocation
            ? 'not_recorded'
            : stale
              ? 'stale'
              : event.verdict === 'READY'
                ? 'ready'
                : 'concerns',
        verdict: event?.verdict ?? null,
        requestId: event?.requestId ?? null,
        auditSha256: event?.sha256 ?? null,
        buildId: invocation?.buildId ?? null,
        inspectedFilesSha256: invocation?.filesSha256 ?? null,
        reviewSha256: invocation?.reviewSha256 ?? null,
        acceptedChanges: freshness?.acceptedChanges ?? [],
      };
    });
  const decisions = state.decisions.map((decision) => ({
    commandId: decision.commandId,
    interactionId: decision.interactionId,
    contentSha256: decision.contentSha256,
    textSha256: decision.textSha256,
    actorId: decision.actorId,
    sequence: decision.sequence,
    stage: decision.stage,
    unit: decision.unit ?? null,
    presentationSha256: decision.presentationSha256,
    application: decision.application,
    effect: decision.effect ?? null,
    auditSha256: decision.auditSha256 ?? null,
  }));
  const gates = requirements
    .filter((item) => item.gate === true)
    .map((requirement) => {
      const event = latest(
        audit,
        (event) =>
          event.event === 'GATE_APPROVED' &&
          event.stage === requirement.stage &&
          sameUnit(event.unit, requirement.unit),
      );
      const decision = decisions.find(
        (decision) =>
          decision.application === 'applied' &&
          decision.effect === 'GATE_APPROVED' &&
          decision.auditSha256 === event?.sha256,
      );
      return {
        stage: requirement.stage,
        unit: requirement.unit,
        status: event && decision ? 'applied' : 'not_recorded',
        commandId: decision?.commandId ?? null,
        auditSha256: event?.sha256 ?? null,
      };
    });
  const plan = observed.effectivePlan;
  const executed = plan?.stages.filter((stage) => stage.action === 'EXECUTE') ?? [];
  const planComplete =
    plan &&
    plan.stages.length > 0 &&
    plan.stages.every(
      (stage) =>
        stage.action === 'SKIP' || stage.state === 'completed' || stage.state === 'skipped',
    );
  const applicabilityComplete = executed.every(
    (stage) =>
      stage.phase === 'initialization' ||
      stage.state === 'skipped' ||
      requirements.some((requirement) => requirement.stage === stage.id),
  );
  const terminal = latest(audit, (event) =>
    ['WORKFLOW_COMPLETED', 'WORKFLOW_FAILED'].includes(event.event),
  );
  const terminalStatus = observed.workflow?.status;
  const completed = terminal?.event === 'WORKFLOW_COMPLETED' && terminalStatus === 'Completed';
  const failed = terminal?.event === 'WORKFLOW_FAILED' && terminalStatus === 'Failed';
  const fileMatch =
    nativeEngineFileDigest(workspace.files) === nativeEngineFileDigest(manifest.files);
  const terminalMatch =
    state.terminalResult?.auditSha256 === terminal?.sha256 &&
    state.terminalResult?.stateSha256 === observed.workflow?.stateSha256 &&
    state.terminalResult?.filesSha256 === nativeEngineFileDigest(manifest.files);
  const missing =
    !planComplete ||
    !applicabilityComplete ||
    checks.some((check) =>
      ['not_recorded', 'unavailable', 'budget_exceeded', 'stale'].includes(check.status),
    ) ||
    reviews.some((review) => ['not_recorded', 'stale'].includes(review.status)) ||
    gates.some((gate) => gate.status !== 'applied') ||
    Boolean(state.uncertain);
  const verdict =
    !fileMatch || !terminalMatch
      ? 'not_verified'
      : failed
        ? 'failed'
        : completed && !missing
          ? 'complete'
          : 'not_verified';
  return {
    schemaVersion: 1,
    producer: {
      profileId: NATIVE_ENGINE_PROFILE.id,
      imageSha256: row.configuration.workflowEngine.producerSha256,
      functionVersion: row.configuration.workflowEngine.version,
    },
    identity,
    publicationId: publication.id,
    publicationSequence: manifest.sequence,
    publicationManifestSha256: publication.manifest.sha256,
    filesSha256: nativeEngineFileDigest(manifest.files),
    configurationSha256: identity.configurationSha256,
    packageId: row.configuration.packageId,
    harness: row.configuration.harness,
    inputsSha256: engineDigest(canonicalJson(row.configuration.inputs)),
    sourceCommit: row.configuration.repository.commit,
    methodologySettings: state.sourceSettings ?? null,
    workflowCompletion: verdict,
    reason:
      !fileMatch || (terminal && !terminalMatch)
        ? 'result_files_changed'
        : verdict === 'complete'
          ? 'protected_engine_completed'
          : verdict === 'failed'
            ? 'protected_engine_failed'
            : missing
              ? 'required_evidence_incomplete'
              : 'workflow_not_terminal',
    requiredChecks: checks.some((check) => check.status === 'failed')
      ? 'failed'
      : checks.some((check) => check.status !== 'passed')
        ? 'incomplete'
        : checks.length
          ? 'passed'
          : 'not_required',
    finalReview: reviews.some((review) => ['not_recorded', 'stale'].includes(review.status))
      ? 'incomplete'
      : reviews.some((review) => review.status === 'concerns')
        ? 'concerns'
        : reviews.length
          ? 'ready'
          : 'not_required',
    humanApproval: gates.some((gate) => gate.status !== 'applied')
      ? 'incomplete'
      : gates.length
        ? 'applied'
        : 'not_required',
    policy: 'pinned_workflow',
    requirementsStatus: plan ? 'captured' : 'unknown',
    policyStatus: 'protected_engine',
    effectivePlan: plan ? { ...plan, sha256: engineDigest(canonicalJson(plan)) } : null,
    engineApplication: decisions,
    terminalOutcome: terminal
      ? {
          event: terminal.event,
          auditSha256: terminal.sha256,
          status: terminalStatus,
          stateSha256: observed.workflow.stateSha256,
        }
      : null,
    checks,
    reviews,
    gates,
    requirements,
  };
};
