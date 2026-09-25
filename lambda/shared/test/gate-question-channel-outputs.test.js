// Upstream 2.9.0 lists `<stage>-questions` in a stage's `produces:`. The platform
// asks those questions through ask_question / confirm_summary (HUMAN# rows and the
// timeline), never as a graph artifact, so a gate built from a real 2.9.0 plan
// must not report them missing — otherwise the gate can only offer
// request-changes, forever. Built from the pinned compatibility fixture so the
// proof is the actual release catalog, not a hand-written stage.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filesFromCompatibilityFixture } from '../aidlc-compatibility.js';
import { buildFromFiles } from '../block-mappers.js';
import { buildExecutionPlan } from '../v2-execution-plan.js';
import { isQuestionChannelOutput } from '../aidlc-capabilities.js';
import { evaluateGatePreconditions, overridableFindings } from '../gate-preconditions.js';

const PROFILE = 'v2.9.0';

const keyById = (items) =>
  Object.fromEntries(
    items.filter((item) => item.id).map((item) => [item.id, { ...item, version: 1 }]),
  );

const planFor = (scope) => {
  const files = filesFromCompatibilityFixture({
    profileId: PROFILE,
    fixture: JSON.parse(
      readFileSync(
        new URL(`./fixtures/aidlc-compatibility/${PROFILE}.json`, import.meta.url),
        'utf8',
      ),
    ),
  });
  const { blocks, workflow } = buildFromFiles(files);
  const ofType = (type) => keyById(blocks.filter((block) => block.type === type));
  return buildExecutionPlan({
    workflow: { ...workflow, version: 1 },
    scope,
    library: {
      stagesById: ofType('STAGE'),
      agentsById: ofType('AGENT'),
      sensorsById: ofType('SENSOR'),
      rulesById: ofType('RULE'),
      artifactsById: ofType('ARTIFACT'),
      scopesById: ofType('SCOPE'),
      fromRelease: true,
    },
  }).plan;
};

const stageOf = (stageId) => {
  const stage = planFor('feature').stages.find((item) => item.stageId === stageId);
  if (!stage) throw new Error(`fixture plan has no ${stageId} stage`);
  return stage;
};

const deliverables = (stage) =>
  stage.outputArtifacts.map((output) => output.artifact).filter((a) => !isQuestionChannelOutput(a));

describe('2.9.0 `<stage>-questions` outputs are satisfied by the question channel', () => {
  for (const stageId of ['requirements-analysis', 'intent-capture']) {
    it(`${stageId}: the plan declares a questions output, and the gate never reports it`, () => {
      const stage = stageOf(stageId);
      const outputs = stage.outputArtifacts.map((output) => output.artifact);
      expect(outputs).toContain(`${stageId}-questions`);
      expect(stage.policy).toBeTruthy();

      // Every real deliverable produced, no questions artifact in the graph: clean.
      const result = evaluateGatePreconditions({
        stage,
        policy: stage.policy,
        producedArtifacts: deliverables(stage),
      });
      expect(result.findings.map((f) => f.code)).not.toContain('required_artifact_missing');
    });

    it(`${stageId}: a confirmation receipt is not stale for the never-saved questions output`, () => {
      const stage = stageOf(stageId);
      const decidedAt = '2026-01-01T00:00:00.000Z';
      const authorizationId = `RECEIPT#summary-confirmation#${stage.stageInstanceId}#0#-`;
      const result = evaluateGatePreconditions({
        stage,
        policy: stage.policy,
        attempt: 0,
        receipts: [
          {
            sk: authorizationId,
            kind: 'summary-confirmation',
            stageInstanceId: stage.stageInstanceId,
            attempt: 0,
            decidedAt,
          },
        ],
        events: [
          {
            eventType: 'v2.question.asked',
            stageInstanceId: stage.stageInstanceId,
            attempt: 0,
            detail: { attempt: 0 },
          },
          ...deliverables(stage).map((artifactType) => ({
            eventType: 'v2.artifact.stamped',
            stageInstanceId: stage.stageInstanceId,
            timestamp: '2026-01-01T00:00:05.000Z',
            detail: { artifactType, authorizationId },
          })),
        ],
        producedArtifacts: deliverables(stage),
      });
      const codes = result.findings.map((f) => f.code);
      expect(codes).not.toContain('required_artifact_missing');
      expect(codes).not.toContain('summary_confirmation_stale');
    });
  }

  it('a genuinely missing deliverable still blocks, but is always overridable', () => {
    const stage = stageOf('requirements-analysis');
    const result = evaluateGatePreconditions({
      stage,
      policy: stage.policy,
      producedArtifacts: [],
    });
    const missing = result.findings.filter((f) => f.code === 'required_artifact_missing');
    expect(missing.map((f) => f.detail.artifact)).toEqual(['requirements']);
    expect(missing[0]).toMatchObject({ overridable: true, receiptKind: 'stage-approval' });
    expect(overridableFindings(result.findings).length).toBeGreaterThan(0);
  });

  it('recognises only the questions naming convention', () => {
    expect(isQuestionChannelOutput('requirements-analysis-questions')).toBe(true);
    expect(isQuestionChannelOutput('requirements')).toBe(false);
    expect(isQuestionChannelOutput('-questions')).toBe(false);
    expect(isQuestionChannelOutput(null)).toBe(false);
  });
});
