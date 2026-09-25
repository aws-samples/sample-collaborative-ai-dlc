// The gate-precondition evaluator — the ONE function that decides whether a
// stage may complete or a human gate may open, and what the human must be told
// if it may not.
//
// It is PURE: every input is data the caller already read (receipts, timeline
// events, sensor verdicts, the reviewer's verdict, ensemble evidence), and the
// output is a verdict plus findings. That is deliberate. The same evaluation runs
// twice — once in the stage runner, to decide proceed / bounded repair / carry
// findings, and once in the orchestrator immediately before the gate opens,
// re-reading the receipts rather than trusting the stage result — and both call
// sites must reach the identical conclusion from the identical rules.
//
// THREE-OUTCOME CONTRACT (the anti-stuck invariant): a finding is either
// advisory (the run proceeds, the human is told), blocking-and-overridable (the
// gate offers `override-and-approve`, which records who overrode what), or
// blocking-and-not-overridable (only `request-changes`, which re-runs the
// stage). No combination can leave a run with nothing to do.
//
// Everything here is inert without a resolved release policy: `policy == null`
// is the 2.3.3/unpinned path and returns `{ ok: true, findings: [] }`, which is
// what keeps the gate prompt byte-identical for those runs.

import { isQuestionChannelOutput } from './aidlc-capabilities.js';
import { eventTypeOf } from './v2-process-keys.js';

// Checked in upstream's own composition order (required outputs → summary
// lineage → contribution evidence → reviewer → sensors), so a human reading the
// findings list sees the most fundamental problem first.
const FINDING_CODES = Object.freeze([
  'required_artifact_missing',
  'summary_confirmation_missing',
  'summary_confirmation_stale',
  'plan_approval_missing',
  'persona_contribution_missing',
  'pipeline_link_incomplete',
  'stage_budget_exhausted',
  'review_advisory_findings',
  'review_dissent_maintained',
  'sensor_gate_blocking',
  'sensor_gate_advisory',
  'change_control_input_changed',
]);

const finding = ({
  code,
  severity,
  title,
  detail = null,
  overridable = false,
  // The receipt kind an override of THIS finding writes — a sensor override is
  // not a stage approval, and the audit trail has to say which one happened.
  receiptKind = null,
  remediation = null,
  // Verbatim human-authored or agent-authored text this finding is ABOUT (today:
  // a maintained dissent's position). Rendered as a quote rather than folded into
  // `title`, because a summarized objection is a different objection. Omitted
  // entirely when absent, so every other finding's shape is unchanged.
  quote = null,
}) => {
  if (!FINDING_CODES.includes(code)) {
    throw new Error(`gate-preconditions: unknown finding code "${code}"`);
  }
  // A blocking finding that is neither overridable nor re-runnable would be a
  // dead end, and an advisory one can never be overridden because it never
  // blocks. Enforced here so a new check cannot introduce a stuck state.
  if (severity !== 'blocking' && overridable) {
    throw new Error(`gate-preconditions: advisory finding "${code}" cannot be overridable`);
  }
  if (overridable && !receiptKind) {
    throw new Error(`gate-preconditions: overridable finding "${code}" names no receipt kind`);
  }
  return {
    code,
    severity,
    title,
    detail,
    overridable,
    receiptKind,
    remediation,
    ...(quote ? { quote: String(quote) } : {}),
  };
};

const sameAttempt = (row, attempt) => Number(row?.attempt) === Number(attempt);

const receiptsOfKind = (receipts, kind, attempt) =>
  (receipts ?? []).filter((row) => row?.kind === kind && sameAttempt(row, attempt));

// A `<stage>-questions` output is satisfied by the platform question channel
// (HUMAN# rows + timeline), not by a graph artifact — see
// `isQuestionChannelOutput`. Excluded here so it is neither reported missing nor
// demanded as a re-save after the confirmation checkpoint.
const requiredOutputs = (stage) =>
  (stage?.outputArtifacts ?? [])
    .filter((output) => !output?.optional)
    .map((output) => output?.artifact ?? output)
    .filter((artifact) => Boolean(artifact) && !isQuestionChannelOutput(artifact));

// `if-present` is upstream's "only when a conditional question flow actually
// ran". The platform-native reading of that is data, not extra state: did this
// stage attempt actually ask a question?
const askedAQuestion = (events, attempt) =>
  (events ?? []).some(
    (event) =>
      eventTypeOf(event) === 'v2.question.asked' &&
      // A question raised by a session that does not own the checkpoint (the
      // ensemble integrator, dispatched after the owner settled its
      // confirmation) is not the stage's conditional question flow.
      event.detail?.checkpointOwner !== false &&
      // `appendEvent` persists the attempt under `detail`; events written before
      // it did carry none and still count, as they always have.
      (event.detail?.attempt == null || sameAttempt(event.detail, attempt)),
  );

const summaryConfirmationRequired = (policy, events, attempt) => {
  if (policy?.summaryConfirmation === 'required') return true;
  return policy?.summaryConfirmation === 'if-present' && askedAQuestion(events, attempt);
};

// Upstream's lineage rule, at the only seam this platform has: the newest
// recorded write of each required output must carry the CURRENT authorization.
// A write with no recorded stamp is treated exactly like an unauthorized one —
// absence of evidence is non-compliance, not a pass.
const lineageGaps = ({ events, artifacts, authorizationId, decidedAt }) =>
  artifacts.filter((artifact) => {
    const stamps = (events ?? []).filter(
      (event) =>
        eventTypeOf(event) === 'v2.artifact.stamped' && event?.detail?.artifactType === artifact,
    );
    if (stamps.length === 0) return true;
    const newestStamp = stamps
      .toSorted((left, right) =>
        String(left.timestamp ?? '').localeCompare(String(right.timestamp ?? '')),
      )
      .at(-1);
    return (
      newestStamp.detail?.authorizationId !== authorizationId ||
      String(newestStamp.timestamp ?? '') <= String(decidedAt ?? '')
    );
  });

// The gate-plane sensor verdicts, rendered as findings. Exported on its own
// because the STAGE RUNNER produces them (it is the only component that runs the
// gate plane) while the ORCHESTRATOR re-derives them from the same rules — so a
// verdict the human already overrode on a previous revision must not come back
// as a fresh finding from either side. A PASS says nothing; `notApplicable`
// (INCONCLUSIVE with the flag) says the sensor had no deliverable to inspect,
// which is also nothing to decide.
const sensorGateFindings = ({ sensorVerdicts = [], receipts = [], attempt = 0 } = {}) => {
  const overridden = new Set(
    receiptsOfKind(receipts, 'sensor-override', attempt).flatMap(
      (row) => row.detail?.sensorIds ?? [],
    ),
  );
  const findings = [];
  for (const verdict of sensorVerdicts ?? []) {
    if (verdict?.result === 'PASS' || overridden.has(verdict?.sensorId)) continue;
    if (verdict?.detail?.notApplicable === true) continue;
    const blocking = verdict?.severity === 'blocking';
    findings.push(
      finding({
        code: blocking ? 'sensor_gate_blocking' : 'sensor_gate_advisory',
        severity: blocking ? 'blocking' : 'advisory',
        title: `Sensor ${verdict.sensorId} (gate) → ${verdict.result}${verdict.detail?.artifact ? ` on ${verdict.detail.artifact}` : ''}`,
        detail: {
          sensorId: verdict.sensorId,
          result: verdict.result,
          reason: verdict.detail?.reason ?? null,
        },
        overridable: blocking,
        ...(blocking ? { receiptKind: 'sensor-override' } : {}),
        remediation: blocking
          ? 'Override to accept the verdict on the record, or request changes so the agent fixes it.'
          : 'Advisory verdict; decide with it in view.',
      }),
    );
  }
  return findings;
};

const evaluateGatePreconditions = ({
  stage = null,
  policy = null,
  attempt = 0,
  receipts = [],
  events = [],
  sensorVerdicts = [],
  reviewVerdict = null,
  ensembleEvidence = null,
  // The required outputs the runner actually observed. `null` means "not
  // observed" (the orchestrator re-read, which sees receipts and events but not
  // the workspace), and an unobserved set is never reported as missing.
  producedArtifacts = null,
  // Approved inputs whose content changed since their producing stage was
  // approved (change control). Empty/null when the check did not run.
  changedInputs = [],
} = {}) => {
  if (!policy) return { ok: true, findings: [] };

  const findings = [];
  const required = requiredOutputs(stage);

  if (Array.isArray(producedArtifacts)) {
    for (const artifact of required.filter((a) => !producedArtifacts.includes(a))) {
      findings.push(
        finding({
          code: 'required_artifact_missing',
          severity: 'blocking',
          title: `Required output "${artifact}" was not produced`,
          detail: { artifact },
          // Overridable (three-outcome rule): a declared output the platform
          // cannot map, or one the human judges unnecessary, must never leave a
          // gate that only offers `request-changes` forever. Approving over it
          // is recorded as a stage-approval receipt naming the artifact, so the
          // gap is on the audit trail rather than silently accepted.
          overridable: true,
          receiptKind: 'stage-approval',
          remediation: `Request changes so the agent creates ${artifact}, or override to approve without it on the record.`,
        }),
      );
    }
  }

  if (summaryConfirmationRequired(policy, events, attempt)) {
    const [receipt] = receiptsOfKind(receipts, 'summary-confirmation', attempt);
    if (!receipt) {
      findings.push(
        finding({
          code: 'summary_confirmation_missing',
          receiptKind: 'stage-approval',
          severity: 'blocking',
          title: 'The consolidated confirmation checkpoint was never answered',
          detail: { stageInstanceId: stage?.stageInstanceId ?? null, attempt },
          overridable: true,
          remediation:
            'Approve to waive the checkpoint for this stage, or request changes so the agent raises it and re-saves its outputs.',
        }),
      );
    } else {
      const gaps = lineageGaps({
        events,
        artifacts: required,
        authorizationId: receipt.sk,
        decidedAt: receipt.decidedAt,
      });
      if (gaps.length > 0) {
        findings.push(
          finding({
            code: 'summary_confirmation_stale',
            receiptKind: 'stage-approval',
            severity: 'blocking',
            title: 'Outputs were not re-saved after the confirmation was given',
            detail: { artifacts: gaps, authorizationId: receipt.sk },
            overridable: true,
            remediation: `Approve to accept them as they are, or request changes so the agent re-saves: ${gaps.join(', ')}.`,
          }),
        );
      }
    }
  }

  if (policy.planApproval === 'required') {
    if (receiptsOfKind(receipts, 'plan-approval', attempt).length === 0) {
      findings.push(
        finding({
          code: 'plan_approval_missing',
          receiptKind: 'stage-approval',
          severity: 'blocking',
          title: 'The implementation plan was never approved',
          detail: { stageInstanceId: stage?.stageInstanceId ?? null, attempt },
          overridable: true,
          remediation:
            'Approve to accept the work without a recorded plan approval, or request changes so the agent presents its plan first.',
        }),
      );
    }
  }

  const declaredSupports = ensembleEvidence?.supports ?? [];
  if (declaredSupports.length > 0) {
    const contributed = new Set(
      receiptsOfKind(receipts, 'persona-contribution', attempt).map(
        (row) => row.detail?.agentRef ?? row.unitSlug,
      ),
    );
    for (const agentRef of declaredSupports.filter((ref) => !contributed.has(ref))) {
      findings.push(
        finding({
          code: 'persona_contribution_missing',
          severity: 'advisory',
          title: `Support persona ${agentRef} produced no contribution`,
          detail: { agentRef },
          remediation: `Review the stage output knowing ${agentRef}'s perspective is absent.`,
        }),
      );
    }
  }

  const declaredLinks = ensembleEvidence?.links ?? [];
  if (declaredLinks.length > 0) {
    const completed = receiptsOfKind(receipts, 'pipeline-link', attempt).length;
    if (completed < declaredLinks.length) {
      findings.push(
        finding({
          code: 'pipeline_link_incomplete',
          severity: 'advisory',
          title: `Only ${completed} of ${declaredLinks.length} pipeline links completed`,
          detail: { completed, declared: declaredLinks.length, links: declaredLinks },
          remediation: 'Review the stage output knowing the pipeline did not run end to end.',
        }),
      );
    }
  }

  // The stage's aggregate wall-clock budget cut persona sessions before they ran
  // (or while they ran). Advisory while at least one collaborator's evidence
  // exists: the stage output is there, the human decides knowing which
  // perspectives are absent. When the cut left NO collaborator evidence at all
  // (no support contribution, no pipeline link past the lead) the ensemble did
  // not happen, so the finding blocks — overridably, so approving a stage that
  // ran as a single session is a recorded waiver rather than a silent one.
  const budgetCut = ensembleEvidence?.budgetExhausted ?? [];
  if (budgetCut.length > 0) {
    const collaboratorEvidence = [
      ...(declaredSupports.length > 0
        ? [receiptsOfKind(receipts, 'persona-contribution', attempt).length]
        : []),
      ...(declaredLinks.length > 0
        ? [Math.max(0, receiptsOfKind(receipts, 'pipeline-link', attempt).length - 1)]
        : []),
    ];
    const fullyCut =
      collaboratorEvidence.length > 0 && collaboratorEvidence.every((count) => count === 0);
    findings.push(
      finding({
        code: 'stage_budget_exhausted',
        severity: fullyCut ? 'blocking' : 'advisory',
        title: fullyCut
          ? `The stage wall-clock budget ran out before any collaborator ran; ${budgetCut.length} persona session(s) were cut`
          : `The stage wall-clock budget ran out; ${budgetCut.length} persona session(s) did not run to completion`,
        detail: { sessions: budgetCut, ...(fullyCut ? { collaboratorEvidence: 0 } : {}) },
        overridable: fullyCut,
        ...(fullyCut ? { receiptKind: 'stage-approval' } : {}),
        remediation: fullyCut
          ? 'Override to approve the single-session output on the record, or request changes to run the stage again with a fresh budget.'
          : 'Review the stage output knowing these sessions were cut, or request changes to run the stage again with a fresh budget.',
      }),
    );
  }

  if (reviewVerdict?.advisory && reviewVerdict.verdict !== 'READY') {
    findings.push(
      finding({
        code: 'review_advisory_findings',
        severity: 'advisory',
        title: `Advisory review (${reviewVerdict.reviewerAgent ?? 'reviewer'}): ${reviewVerdict.verdict ?? 'NOT-READY'}`,
        detail: { findings: reviewVerdict.findings ?? null },
        remediation: 'The advisory reviewer does not block; decide with its findings in view.',
      }),
    );
  }

  for (const dissent of ensembleEvidence?.dissent ?? []) {
    findings.push(
      finding({
        code: 'review_dissent_maintained',
        severity: 'advisory',
        title: `Maintained dissent (${dissent.agentRef ?? 'collaborator'})`,
        // Quoted verbatim: a summarized objection is a different objection. The
        // text rides `quote` as well as `detail` so every renderer (gate prompt,
        // review panel) shows the words the collaborator actually wrote.
        detail: { agentRef: dissent.agentRef ?? null, position: dissent.position ?? null },
        quote: dissent.quote ?? dissent.position ?? null,
        remediation: 'Decide whether the objection changes your approval.',
      }),
    );
  }

  findings.push(...sensorGateFindings({ sensorVerdicts, receipts, attempt }));

  for (const changed of changedInputs ?? []) {
    findings.push(
      finding({
        code: 'change_control_input_changed',
        severity: 'advisory',
        title: `Approved input ${changed.artifactId} changed since it was approved`,
        detail: changed,
        remediation: 'Confirm the stage still holds against the changed input.',
      }),
    );
  }

  return { ok: findings.every((item) => item.severity !== 'blocking'), findings };
};

// The gate's third option exists only when a human can actually resolve a block
// by taking responsibility for it. A non-overridable block offers
// `request-changes` alone, which re-runs the stage — so the run is never stuck
// and the option list never lies about what is possible.
const overridableFindings = (findings = []) =>
  findings.filter((item) => item.severity === 'blocking' && item.overridable);

// The runner and the orchestrator see overlapping evidence — the runner observed
// the workspace, the orchestrator re-read the receipts — so the same condition
// can be reported twice. Identity is (code, detail): the same code about a
// DIFFERENT artifact or sensor is a different finding and must survive.
const mergeFindings = (...lists) => {
  const byIdentity = new Map();
  for (const item of lists.flat().filter(Boolean)) {
    byIdentity.set(`${item.code}\u0000${JSON.stringify(item.detail ?? null)}`, item);
  }
  return [...byIdentity.values()];
};

export {
  FINDING_CODES,
  evaluateGatePreconditions,
  mergeFindings,
  overridableFindings,
  sensorGateFindings,
};
export default {
  FINDING_CODES,
  evaluateGatePreconditions,
  mergeFindings,
  overridableFindings,
  sensorGateFindings,
};
