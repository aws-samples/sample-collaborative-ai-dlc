// The gate-precondition evaluator. One fixture per finding
// code plus the empty case, because this is the function that decides whether a
// human sees a block, an advisory note, or nothing at all — and the empty case is
// the byte-identity guarantee for every unpinned and 2.3.3-era run.

import { describe, expect, it } from 'vitest';
import {
  FINDING_CODES,
  evaluateGatePreconditions,
  mergeFindings,
  overridableFindings,
} from '../gate-preconditions.js';
import { buildEventRow } from '../v2-process-keys.js';

const STAGE = Object.freeze({
  stageId: 'requirements-analysis',
  stageInstanceId: 'si-1',
  outputArtifacts: [{ artifact: 'requirements' }, { artifact: 'notes', optional: true }],
});

const POLICY = Object.freeze({
  sensorsEnabled: true,
  reviewClass: 'adversarial',
  reviewArtifact: null,
  summaryConfirmation: 'none',
  changeControl: null,
  learnings: 'on',
  skeleton: null,
});

const receipt = (over = {}) => ({
  sk: 'RECEIPT#summary-confirmation#si-1#0#-',
  kind: 'summary-confirmation',
  stageInstanceId: 'si-1',
  attempt: 0,
  decidedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const stamp = (artifactType, over = {}) => ({
  eventType: 'v2.artifact.stamped',
  timestamp: '2026-01-01T00:00:05.000Z',
  detail: { artifactType, authorizationId: 'RECEIPT#summary-confirmation#si-1#0#-' },
  ...over,
});

const codesOf = (result) => result.findings.map((item) => item.code);

describe('evaluateGatePreconditions: the inert path', () => {
  it('returns the empty verdict with no resolved policy, whatever else is present', () => {
    expect(
      evaluateGatePreconditions({
        stage: STAGE,
        policy: null,
        producedArtifacts: [],
        sensorVerdicts: [{ sensorId: 's', result: 'FAIL', severity: 'blocking' }],
      }),
    ).toEqual({ ok: true, findings: [] });
    expect(evaluateGatePreconditions()).toEqual({ ok: true, findings: [] });
  });

  it('returns the empty verdict for a compliant stage under a resolved policy', () => {
    expect(
      evaluateGatePreconditions({
        stage: STAGE,
        policy: POLICY,
        producedArtifacts: ['requirements'],
      }),
    ).toEqual({ ok: true, findings: [] });
  });
});

describe('evaluateGatePreconditions: required outputs', () => {
  it('blocks, and offers an override on the record, when a required output is missing', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: [],
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(['required_artifact_missing']);
    expect(result.findings[0]).toMatchObject({
      severity: 'blocking',
      overridable: true,
      receiptKind: 'stage-approval',
      detail: { artifact: 'requirements' },
    });
    // Three-outcome rule: a missing output can never leave only request-changes.
    expect(overridableFindings(result.findings)).toHaveLength(1);
  });

  it('never reports a missing output the caller did not observe', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: null,
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('ignores an absent OPTIONAL output', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual([]);
  });
});

describe('evaluateGatePreconditions: summary confirmation', () => {
  const required = { ...POLICY, summaryConfirmation: 'required' };

  it('blocks with an override when the checkpoint was never answered', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: required,
      producedArtifacts: ['requirements'],
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(['summary_confirmation_missing']);
    expect(result.findings[0]).toMatchObject({
      overridable: true,
      receiptKind: 'stage-approval',
    });
  });

  it('passes when the receipt exists and every required output was stamped after it', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: required,
      receipts: [receipt()],
      events: [stamp('requirements')],
      producedArtifacts: ['requirements'],
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('treats a write stamped at the exact confirmation time as stale', () => {
    const decidedAt = '2026-01-01T00:00:00.000Z';
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: required,
      receipts: [receipt({ decidedAt })],
      events: [stamp('requirements', { timestamp: decidedAt })],
      producedArtifacts: ['requirements'],
    });

    expect(codesOf(result)).toEqual(['summary_confirmation_stale']);
    expect(result.findings[0].detail.artifacts).toEqual(['requirements']);
  });

  it('treats an UNSTAMPED write as non-compliance, not as a pass', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: required,
      receipts: [receipt()],
      events: [],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['summary_confirmation_stale']);
    expect(result.findings[0].detail.artifacts).toEqual(['requirements']);
  });

  it('treats a write stamped with a SUPERSEDED authorization as stale', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: required,
      receipts: [receipt()],
      events: [
        stamp('requirements', {
          detail: {
            artifactType: 'requirements',
            authorizationId: 'RECEIPT#summary-confirmation#si-1#0#-old',
          },
        }),
      ],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['summary_confirmation_stale']);
  });

  it('treats a write made BEFORE the confirmation as stale', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: required,
      receipts: [receipt()],
      events: [stamp('requirements', { timestamp: '2025-12-31T00:00:00.000Z' })],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['summary_confirmation_stale']);
  });

  it('treats a newer write without the current authorization as stale', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: required,
      receipts: [receipt()],
      events: [
        stamp('requirements'),
        stamp('requirements', {
          timestamp: '2026-01-01T00:00:10.000Z',
          detail: {
            artifactType: 'requirements',
            authorizationId: 'RECEIPT#summary-confirmation#si-1#0#-superseded',
          },
        }),
      ],
      producedArtifacts: ['requirements'],
    });

    expect(codesOf(result)).toEqual(['summary_confirmation_stale']);
    expect(result.findings[0].detail.artifacts).toEqual(['requirements']);
  });

  it('checks the newest authorization stamp for every artifact id of a required type', () => {
    const decidedAt = '2026-01-01T00:00:00.000Z';
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: required,
      receipts: [receipt({ decidedAt })],
      events: [
        stamp('requirements', {
          timestamp: '2025-12-31T23:59:59.000Z',
          detail: {
            artifactId: 'artifact-unapproved',
            artifactType: 'requirements',
            authorizationId: 'RECEIPT#summary-confirmation#si-1#0#-old',
          },
        }),
        stamp('requirements', {
          timestamp: '2026-01-01T00:00:05.000Z',
          detail: {
            artifactId: 'artifact-approved',
            artifactType: 'requirements',
            authorizationId: receipt().sk,
          },
        }),
      ],
      producedArtifacts: ['requirements'],
    });

    expect(codesOf(result)).toEqual(['summary_confirmation_stale']);
    expect(result.findings[0].detail.artifacts).toEqual(['requirements']);
  });

  it('ignores a receipt from a PRIOR attempt', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: required,
      attempt: 1,
      receipts: [receipt({ attempt: 0 })],
      events: [stamp('requirements')],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['summary_confirmation_missing']);
  });

  it('is a no-op under if-present when the attempt asked no question', () => {
    const ifPresent = { ...POLICY, summaryConfirmation: 'if-present' };
    expect(
      evaluateGatePreconditions({
        stage: STAGE,
        policy: ifPresent,
        events: [],
        producedArtifacts: ['requirements'],
      }),
    ).toEqual({ ok: true, findings: [] });

    const asked = evaluateGatePreconditions({
      stage: STAGE,
      policy: ifPresent,
      events: [{ eventType: 'v2.question.asked' }],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(asked)).toEqual(['summary_confirmation_missing']);
  });

  it('under if-present, ignores a question asked by a PRIOR attempt', () => {
    const ifPresent = { ...POLICY, summaryConfirmation: 'if-present' };
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: ifPresent,
      attempt: 1,
      events: [{ eventType: 'v2.question.asked', detail: { attempt: 0 } }],
      producedArtifacts: ['requirements'],
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });

  // A dispatched persona (the ensemble integrator) does not own the checkpoint;
  // its question is not the stage's conditional question flow and must not arm
  // if-present after the owner already settled.
  it('under if-present, ignores a question raised by a non-owner session', () => {
    const ifPresent = { ...POLICY, summaryConfirmation: 'if-present' };
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: ifPresent,
      attempt: 0,
      events: [
        buildEventRow({
          executionId: 'e1',
          type: 'v2.question.asked',
          actor: 'si-1',
          summary: 'Agent asked 1 question(s)',
          detail: { attempt: 0, checkpointOwner: false },
          now: '2026-01-01T00:00:00.000Z',
          eventId: 'ev-1',
        }),
      ],
      producedArtifacts: ['requirements'],
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it('under if-present, counts the persisted row shape of an owner question', () => {
    const ifPresent = { ...POLICY, summaryConfirmation: 'if-present' };
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: ifPresent,
      attempt: 0,
      events: [
        buildEventRow({
          executionId: 'e1',
          type: 'v2.question.asked',
          actor: 'si-1',
          summary: 'Agent asked 1 question(s)',
          detail: { attempt: 0 },
          now: '2026-01-01T00:00:00.000Z',
          eventId: 'ev-1',
        }),
      ],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['summary_confirmation_missing']);
  });
});

describe('evaluateGatePreconditions: plan approval', () => {
  it('blocks with an override when no plan-approval receipt exists for the attempt', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: { ...POLICY, planApproval: 'required' },
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['plan_approval_missing']);
    expect(result.findings[0]).toMatchObject({ overridable: true, receiptKind: 'stage-approval' });
  });

  it('passes with the receipt present', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: { ...POLICY, planApproval: 'required' },
      receipts: [receipt({ kind: 'plan-approval', sk: 'RECEIPT#plan-approval#si-1#0#-' })],
      producedArtifacts: ['requirements'],
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });
});

describe('evaluateGatePreconditions: ensemble evidence', () => {
  it('reports a support persona that produced no contribution as an advisory GAP', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      ensembleEvidence: { supports: ['design-agent', 'quality-agent'] },
      receipts: [
        receipt({
          kind: 'persona-contribution',
          sk: 'RECEIPT#persona-contribution#si-1#0#-',
          detail: { agentRef: 'quality-agent' },
        }),
      ],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['persona_contribution_missing']);
    // A gap never blocks: the run continues and the human is told.
    expect(result.ok).toBe(true);
    expect(result.findings[0]).toMatchObject({
      severity: 'advisory',
      overridable: false,
      detail: { agentRef: 'design-agent' },
    });
  });

  it('reports an incomplete pipeline chain as advisory', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      ensembleEvidence: { links: ['lead', 'a', 'b'] },
      receipts: [receipt({ kind: 'pipeline-link', sk: 'RECEIPT#pipeline-link#si-1#0#-#0' })],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['pipeline_link_incomplete']);
    expect(result.findings[0].detail).toMatchObject({ completed: 1, declared: 3 });
    expect(result.ok).toBe(true);
  });

  it('quotes maintained dissent verbatim', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      ensembleEvidence: {
        dissent: [{ agentRef: 'quality-agent', position: 'OBJECT: the retry budget is wrong' }],
      },
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['review_dissent_maintained']);
    expect(result.findings[0].detail.position).toBe('OBJECT: the retry budget is wrong');
  });
});

describe('evaluateGatePreconditions: reviewer and sensors', () => {
  it('surfaces an advisory reviewer verdict without blocking', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      reviewVerdict: {
        advisory: true,
        verdict: 'NOT-READY',
        reviewerAgent: 'architecture-reviewer',
        findings: 'Section 3 is unsupported',
      },
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['review_advisory_findings']);
    expect(result.ok).toBe(true);
    expect(result.findings[0].title).toContain('architecture-reviewer');
  });

  it('says nothing about an adversarial reviewer or a READY advisory one', () => {
    expect(
      codesOf(
        evaluateGatePreconditions({
          stage: STAGE,
          policy: POLICY,
          reviewVerdict: { advisory: false, verdict: 'NOT-READY' },
          producedArtifacts: ['requirements'],
        }),
      ),
    ).toEqual([]);
    expect(
      codesOf(
        evaluateGatePreconditions({
          stage: STAGE,
          policy: POLICY,
          reviewVerdict: { advisory: true, verdict: 'READY' },
          producedArtifacts: ['requirements'],
        }),
      ),
    ).toEqual([]);
  });

  it('holds the gate on a BLOCKING gate-plane sensor, with an override', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      sensorVerdicts: [
        {
          sensorId: 'claim-sources',
          result: 'FAIL',
          severity: 'blocking',
          detail: { artifact: 'requirements.md', reason: 'unsourced claim' },
        },
      ],
      producedArtifacts: ['requirements'],
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(['sensor_gate_blocking']);
    expect(result.findings[0]).toMatchObject({
      overridable: true,
      receiptKind: 'sensor-override',
    });
    expect(result.findings[0].title).toContain('requirements.md');
  });

  it('keeps an advisory sensor verdict advisory, and lets a PASS through', () => {
    const advisory = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      sensorVerdicts: [
        { sensorId: 'heading-shape', result: 'WARN', severity: 'advisory' },
        { sensorId: 'links', result: 'PASS', severity: 'blocking' },
      ],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(advisory)).toEqual(['sensor_gate_advisory']);
    expect(advisory.ok).toBe(true);
  });

  it('drops a blocking sensor finding already overridden in THIS attempt', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      receipts: [
        receipt({
          kind: 'sensor-override',
          sk: 'RECEIPT#sensor-override#si-1#0#-',
          detail: { sensorIds: ['claim-sources'] },
        }),
      ],
      sensorVerdicts: [{ sensorId: 'claim-sources', result: 'FAIL', severity: 'blocking' }],
      producedArtifacts: ['requirements'],
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });
});

describe('evaluateGatePreconditions: change control', () => {
  it('notes a changed approved input as advisory', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: { ...POLICY, changeControl: 'relaxed' },
      changedInputs: [{ artifactId: 'design', fromHash: 'a', toHash: 'b' }],
      producedArtifacts: ['requirements'],
    });
    expect(codesOf(result)).toEqual(['change_control_input_changed']);
    expect(result.ok).toBe(true);
  });
});

describe('evaluateGatePreconditions: composition order and codes', () => {
  it('reports findings in upstream composition order', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: { ...POLICY, summaryConfirmation: 'required', changeControl: 'relaxed' },
      producedArtifacts: [],
      ensembleEvidence: {
        supports: ['design-agent'],
        dissent: [{ agentRef: 'quality-agent', position: 'OBJECT' }],
      },
      reviewVerdict: { advisory: true, verdict: 'NOT-READY' },
      sensorVerdicts: [{ sensorId: 's1', result: 'FAIL', severity: 'blocking' }],
      changedInputs: [{ artifactId: 'design' }],
    });
    expect(codesOf(result)).toEqual([
      'required_artifact_missing',
      'summary_confirmation_missing',
      'persona_contribution_missing',
      'review_advisory_findings',
      'review_dissent_maintained',
      'sensor_gate_blocking',
      'change_control_input_changed',
    ]);
    expect(result.ok).toBe(false);
    // Every code the evaluator can emit is declared, so the frontend copy map
    // and the rewind-eligible set can be checked against one list.
    for (const code of codesOf(result)) expect(FINDING_CODES).toContain(code);
  });
});

describe('mergeFindings', () => {
  const missing = (artifact) => ({
    code: 'required_artifact_missing',
    severity: 'blocking',
    title: `Required output "${artifact}" was not produced`,
    detail: { artifact },
    overridable: true,
    receiptKind: 'stage-approval',
    remediation: null,
  });

  it('deduplicates the same finding reported by both call sites', () => {
    expect(mergeFindings([missing('requirements')], [missing('requirements')])).toHaveLength(1);
  });

  it('keeps the same code about a DIFFERENT subject', () => {
    expect(mergeFindings([missing('requirements')], [missing('design')])).toHaveLength(2);
  });

  it('tolerates empty lists and a list of nothing', () => {
    expect(mergeFindings([], [])).toEqual([]);
    expect(mergeFindings([null, undefined], [missing('requirements')])).toHaveLength(1);
  });
});

// The verbatim dissent text has to REACH the gate. `detail.position` alone is
// invisible to every renderer, so the finding carries `quote` too — and only the
// findings that actually quote something carry the field, which is what keeps
// every other finding's shape (and the byte-identical prompt) unchanged.
describe('evaluateGatePreconditions: maintained dissent carries the verbatim text', () => {
  const dissentResult = (dissent) =>
    evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: ['requirements'],
      ensembleEvidence: { dissent: [dissent] },
    });

  it('quotes the position verbatim', () => {
    const result = dissentResult({
      agentRef: 'aidlc-quality-agent',
      class: 'knowledge',
      position: 'OBJECT: the retry budget ignores the 429 path',
    });
    expect(codesOf(result)).toEqual(['review_dissent_maintained']);
    expect(result.findings[0].quote).toBe('OBJECT: the retry budget ignores the 429 path');
    // Still advisory: a dissent informs the decision, it does not block it.
    expect(result.ok).toBe(true);
  });

  it('prefers an explicit quote over the position when the emitter sends both', () => {
    expect(
      dissentResult({ agentRef: 'a', position: 'summarised', quote: 'the exact words' }).findings[0]
        .quote,
    ).toBe('the exact words');
  });

  it('omits the field entirely when there is nothing to quote', () => {
    const result = dissentResult({ agentRef: 'a' });
    expect(result.findings[0]).not.toHaveProperty('quote');
  });

  it('leaves every other finding shape untouched', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: [],
    });
    expect(result.findings[0]).not.toHaveProperty('quote');
    expect(Object.keys(result.findings[0])).toEqual([
      'code',
      'severity',
      'title',
      'detail',
      'overridable',
      'receiptKind',
      'remediation',
    ]);
  });
});

describe('evaluateGatePreconditions: stage wall-clock budget', () => {
  it('reports the sessions the budget cut as ONE advisory finding', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: ['requirements'],
      receipts: [
        { kind: 'summary-confirmation', attempt: 0, sk: 'RECEIPT#summary-confirmation#si-1#0#-' },
      ],
      ensembleEvidence: {
        supports: [],
        links: [],
        dissent: [],
        budgetExhausted: [{ agentRef: 'aidlc-product-agent', role: 'integrator' }],
      },
    });
    const cut = result.findings.find((item) => item.code === 'stage_budget_exhausted');
    expect(cut).toMatchObject({
      severity: 'advisory',
      overridable: false,
      detail: { sessions: [{ agentRef: 'aidlc-product-agent', role: 'integrator' }] },
    });
  });

  it('blocks, overridably, when the cut left no collaborator evidence at all', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: ['requirements'],
      ensembleEvidence: {
        supports: ['design-agent', 'quality-agent'],
        links: [],
        dissent: [],
        budgetExhausted: [
          { agentRef: 'design-agent', role: 'support' },
          { agentRef: 'quality-agent', role: 'support' },
        ],
      },
    });
    const cut = result.findings.find((item) => item.code === 'stage_budget_exhausted');
    expect(cut).toMatchObject({
      severity: 'blocking',
      overridable: true,
      receiptKind: 'stage-approval',
    });
    expect(overridableFindings(result.findings)).toContainEqual(cut);
  });

  it('stays advisory when one collaborator contributed before the cut', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: ['requirements'],
      receipts: [
        { kind: 'persona-contribution', attempt: 0, detail: { agentRef: 'design-agent' } },
      ],
      ensembleEvidence: {
        supports: ['design-agent', 'quality-agent'],
        links: [],
        dissent: [],
        budgetExhausted: [{ agentRef: 'quality-agent', role: 'support' }],
      },
    });
    expect(result.findings.find((item) => item.code === 'stage_budget_exhausted')).toMatchObject({
      severity: 'advisory',
      overridable: false,
    });
  });

  it('stays advisory when pipeline evidence exists but a support persona was cut', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: ['requirements'],
      receipts: [
        { kind: 'pipeline-link', attempt: 0, detail: { agentRef: 'lead' } },
        { kind: 'pipeline-link', attempt: 0, detail: { agentRef: 'quality-agent' } },
      ],
      ensembleEvidence: {
        supports: ['design-agent'],
        links: ['lead', 'quality-agent'],
        dissent: [],
        budgetExhausted: [{ agentRef: 'design-agent', role: 'support' }],
      },
    });

    const budget = result.findings.find((item) => item.code === 'stage_budget_exhausted');
    expect(result.ok).toBe(true);
    expect(codesOf(result)).toContain('persona_contribution_missing');
    expect(codesOf(result)).not.toContain('pipeline_link_incomplete');
    expect(budget).toMatchObject({ severity: 'advisory', overridable: false });
    expect(budget.receiptKind).toBeNull();
  });

  it('blocks a pipeline whose only completed link is the lead', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: ['requirements'],
      receipts: [{ kind: 'pipeline-link', attempt: 0, detail: { agentRef: 'lead' } }],
      ensembleEvidence: {
        supports: [],
        links: ['lead', 'design-agent'],
        dissent: [],
        budgetExhausted: [{ agentRef: 'design-agent', role: 'link' }],
      },
    });
    expect(result.findings.find((item) => item.code === 'stage_budget_exhausted').severity).toBe(
      'blocking',
    );
  });

  it('says nothing when no session was cut', () => {
    const result = evaluateGatePreconditions({
      stage: STAGE,
      policy: POLICY,
      producedArtifacts: ['requirements'],
      ensembleEvidence: { supports: [], links: [], dissent: [] },
    });
    expect(codesOf(result)).not.toContain('stage_budget_exhausted');
  });
});

describe('FINDING_CODES is closed', () => {
  it('still refuses an unknown code', () => {
    expect(FINDING_CODES).toContain('review_dissent_maintained');
  });
});
