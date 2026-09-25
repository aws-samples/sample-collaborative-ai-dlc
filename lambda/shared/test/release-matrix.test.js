import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AIDLC_COMPATIBILITY_PROFILES,
  filesFromCompatibilityFixture,
  normalizeAidlcFrontmatter,
} from '../aidlc-compatibility.js';
import { buildFromFiles } from '../block-mappers.js';
import {
  ENSEMBLE_PROTOCOL_FILE,
  resolveEnsembleTopology,
} from '../../agentcore/ensemble-runner.js';
import { buildStagePrompt, renderScopePolicy } from '../../agentcore/stage-materializer.js';
import { toolsForRole } from '../../agentcore/mcp/server.js';
import {
  buildExecutionPlan,
  planSegments,
  resolveStagePolicy,
  UNIT_DAG_ARTIFACT,
  UNIT_FOR_EACH,
} from '../v2-execution-plan.js';
import { evaluateGatePreconditions } from '../gate-preconditions.js';
import {
  LOOP_BACK_OPTION,
  LOOP_BACK_RECOMMENDED_EVENT,
  resolveLoopBackOffer,
} from '../stage-loopback.js';
import { resolveMethodologyLibrary } from '../release-resolver.js';
import { canonicalJson } from '../workflow-checkpoint.js';
import { buildGateOptions } from '../../v2-orchestrator/index.js';

const PROFILE_IDS = Object.keys(AIDLC_COMPATIBILITY_PROFILES);
const LIBRARY_TYPES = ['STAGE', 'AGENT', 'SENSOR', 'RULE', 'ARTIFACT', 'KNOWLEDGE', 'SCOPE'];
const CHECKPOINT_TOOLS = ['confirm_summary', 'request_plan_approval'];
const LEARNING_TOOLS = ['record_team_knowledge', 'record_learning_rule'];
const DOCUMENTED_UNGATED_FAILURES = new Set([
  'summary_confirmation_missing',
  'summary_confirmation_stale',
  'plan_approval_missing',
]);
const ATTEMPT = 0;
const DECIDED_AT = '2026-01-01T00:00:00.000Z';
const STAMPED_AT = '2026-01-01T00:00:01.000Z';

// The golden plan digests are the 2.3.3 baseline captured before release adapters.
const LEGACY_PLAN_DIGESTS = Object.freeze({
  bugfix: '9db9c5796db93e77f5304b8a768ec8a776748e7bc5f52b1fcb2c9b61bd295288',
  enterprise: 'edc690e0e42fc9f954e3b28db69c6116df9a24ccf31d1471cdca523a11e22e4f',
  feature: '171302b22cf8159fe785b8255a461f039c3fcfd0812bc51737f4b1b72b6e191e',
  infra: '015c582c48f0b1fbed59811b96c24f190d86a7f537dc3cdbdfe82d8c28c4abd2',
  mvp: '6e16bb353666ff31c19b1b5e78832188b871c2414422196cac7cc64e0a735da5',
  poc: '0ecd69c9eb42c52558a71812871d2e7936f2b9b8f5767e232aeb7c6502d8bd90',
  refactor: '33ce3a3b72c42893823468339e8e87c8d468ea53038c7cdf3cc5574d2c1d3213',
  'security-patch': '9e0201f3b5051ea669a0012672c196b0f1766dfe06d8ee3a76868e7fbe7344d5',
  workshop: '3e0ceaab383f51e4b8c0ee6d5013b317321cd818ef7ad3adf2138ab6b1d653e6',
});

const EXPECTED_LOOP_BACK_TUPLES = Object.freeze(
  [
    ['v2.6.18', 'bugfix', ['build-and-test']],
    [
      'v2.6.18',
      'express',
      ['build-and-test', 'deployment-pipeline', 'deployment-execution', 'observability-setup'],
    ],
    ['v2.6.18', 'poc', ['build-and-test']],
    ['v2.6.18', 'refactor', ['build-and-test']],
    [
      'v2.6.18',
      'security-patch',
      ['build-and-test', 'deployment-pipeline', 'deployment-execution'],
    ],
    ['v2.7.0', 'bugfix', ['build-and-test', 'deployment-pipeline', 'deployment-execution']],
    [
      'v2.7.0',
      'express',
      ['build-and-test', 'deployment-pipeline', 'deployment-execution', 'observability-setup'],
    ],
    ['v2.7.0', 'poc', ['build-and-test']],
    ['v2.7.0', 'refactor', ['build-and-test', 'deployment-pipeline', 'deployment-execution']],
    ['v2.7.0', 'security-patch', ['build-and-test', 'deployment-pipeline', 'deployment-execution']],
    ['v2.8.2', 'bugfix', ['build-and-test', 'deployment-pipeline', 'deployment-execution']],
    [
      'v2.8.2',
      'express',
      ['build-and-test', 'deployment-pipeline', 'deployment-execution', 'observability-setup'],
    ],
    ['v2.8.2', 'poc', ['build-and-test']],
    ['v2.8.2', 'refactor', ['build-and-test', 'deployment-pipeline', 'deployment-execution']],
    ['v2.8.2', 'security-patch', ['build-and-test', 'deployment-pipeline', 'deployment-execution']],
    ['v2.9.0', 'bugfix', ['build-and-test', 'deployment-pipeline', 'deployment-execution']],
    [
      'v2.9.0',
      'express',
      ['build-and-test', 'deployment-pipeline', 'deployment-execution', 'observability-setup'],
    ],
    ['v2.9.0', 'poc', ['build-and-test']],
    ['v2.9.0', 'refactor', ['build-and-test', 'deployment-pipeline', 'deployment-execution']],
    ['v2.9.0', 'security-patch', ['build-and-test', 'deployment-pipeline', 'deployment-execution']],
  ].flatMap(([profileId, scope, recommendingStages]) =>
    recommendingStages.map((recommendingStageId) => ({
      profileId,
      scope,
      recommendingStageId,
      targetStageId: 'code-generation',
    })),
  ),
);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const fixtureFor = (profileId) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
      'utf8',
    ),
  );

const keyById = (blocks) =>
  Object.fromEntries(blocks.filter((block) => block.id).map((block) => [block.id, block]));

const libraryFromBlocks = (blocks) =>
  Object.fromEntries(
    LIBRARY_TYPES.map((type) => [
      `${type.toLowerCase()}sById`,
      keyById(
        blocks.filter((block) => block.type === type).map((block) => ({ ...block, version: 1 })),
      ),
    ]),
  );

const fixtureContext = async (profileId) => {
  const fixture = fixtureFor(profileId);
  const files = filesFromCompatibilityFixture({ profileId, fixture });
  const normalizedFiles = new Map(
    [...files].map(([path, content]) => [
      path,
      normalizeAidlcFrontmatter({ profileId, path, content }).content,
    ]),
  );
  const built = buildFromFiles(normalizedFiles);
  const blocksByType = Object.fromEntries(
    LIBRARY_TYPES.map((type) => [
      type,
      built.blocks
        .filter((block) => block.type === type)
        .map((block) => ({ ...block, version: 1 })),
    ]),
  );
  const catalogWorkflow = { ...built.workflow, workflowVersion: 1, version: 1 };
  const closure = {
    releaseId: AIDLC_COMPATIBILITY_PROFILES[profileId].releaseId,
    catalog: { workflow: catalogWorkflow },
    blocksByType,
    runtimeFiles: new Map(
      fixture.runtimeFiles.map((runtimeFile) => [runtimeFile.path, runtimeFile]),
    ),
  };
  const resolved = await resolveMethodologyLibrary({
    closure,
    // No user overlay is present in these immutable fixtures; any DDB access
    // would mean the synthetic closure stopped following the release path.
    ddb: { send: () => Promise.reject(new Error('unexpected fixture DDB read')) },
    tableName: 'synthetic-fixture-table',
    workflowId: built.workflow.id,
    workflowVersion: 1,
  });

  return {
    fixture,
    built,
    workflow: { ...resolved.workflow, version: 1 },
    releaseLibrary: resolved.library,
    legacyLibrary: libraryFromBlocks(built.blocks),
  };
};

const toolAndPromptContract = (plan, library) =>
  plan.stages.map((stage) => {
    const stageBlock = library.stagesById[stage.stageId];
    const lead = library.agentsById[stage.agentRef];
    const supportAgents = (stage.supportAgentRefs ?? [])
      .map((ref) => library.agentsById[ref])
      .filter(Boolean)
      .map((agent) => ({ ref: agent.id, displayName: agent.displayName, persona: agent.body }));
    return {
      tools: toolsForRole('author', stage.stageId, stage.policy ?? null),
      prompt: buildStagePrompt({
        stage,
        stageBody: stageBlock?.body ?? '',
        agentPersona: lead?.body ?? '',
        supportAgents,
      }),
    };
  });

const makeReceipt = (kind, stage, detail = {}) => ({
  sk: `RECEIPT#${kind}#${stage.stageInstanceId}#${ATTEMPT}`,
  kind,
  stageInstanceId: stage.stageInstanceId,
  attempt: ATTEMPT,
  decidedAt: DECIDED_AT,
  detail,
});

const ensembleEvidenceFor = (topology, { compliant }) => {
  if (!topology) return null;
  const supports = topology.mode === 'pipeline' ? [] : topology.supports.map(({ ref }) => ref);
  return {
    supports,
    links: topology.mode === 'pipeline' ? topology.links : [],
    ...(!compliant
      ? { budgetExhausted: topology.mode === 'pipeline' ? topology.links : supports }
      : {}),
  };
};

const gateInputs = ({ stage, topology, tools, compliant }) => {
  const receipts = [];
  const events = [];
  const outputTypes = (stage.outputArtifacts ?? [])
    .map((item) => item.artifact ?? item)
    .filter(Boolean);
  const ensembleEvidence = ensembleEvidenceFor(topology, { compliant });
  let authorizationId = null;

  if (compliant && tools.includes('confirm_summary')) {
    const receipt = makeReceipt('summary-confirmation', stage);
    authorizationId = receipt.sk;
    receipts.push(receipt);
  }
  if (compliant && tools.includes('request_plan_approval')) {
    receipts.push(makeReceipt('plan-approval', stage));
  }
  if (compliant) {
    for (const artifactType of outputTypes) {
      events.push({
        eventType: 'v2.artifact.stamped',
        timestamp: STAMPED_AT,
        stageInstanceId: stage.stageInstanceId,
        detail: { artifactType, authorizationId, attempt: ATTEMPT },
      });
    }
    for (const agentRef of ensembleEvidence?.supports ?? []) {
      receipts.push(makeReceipt('persona-contribution', stage, { agentRef }));
    }
    for (const [ordinal] of (ensembleEvidence?.links ?? []).entries()) {
      receipts.push(makeReceipt('pipeline-link', stage, { ordinal }));
    }
  }

  return {
    stage,
    policy: stage.policy ?? null,
    attempt: ATTEMPT,
    receipts,
    events: compliant ? events : [],
    producedArtifacts: compliant ? outputTypes : [],
    sensorVerdicts: compliant
      ? (stage.sensors ?? []).map((sensor) => ({
          sensorId: sensor.sensorId,
          result: 'PASS',
          severity: sensor.severity ?? 'blocking',
        }))
      : [{ sensorId: 'synthetic-gate-sensor', result: 'FAIL', severity: 'blocking' }],
    ensembleEvidence,
  };
};

const resolveTopology = (stage, library, releaseId) =>
  resolveEnsembleTopology({
    stage,
    library,
    loadBlockBody: async (block) => block.body ?? '',
    methodologyRelease: { releaseId },
    env: {},
  });

const loopBackOfferFor = ({ stage, stages, profileId }) => {
  const segment = planSegments(stages).find((item) =>
    item.stages.some((candidate) => candidate.stageId === stage.stageId),
  );
  if (!segment || segment.kind !== 'stages') return { offered: false };
  const currentIndex = segment.stages.findIndex((candidate) => candidate.stageId === stage.stageId);
  const events =
    stage.policy?.loopBack === 'human-offered'
      ? [
          {
            eventType: LOOP_BACK_RECOMMENDED_EVENT,
            stageInstanceId: stage.stageInstanceId,
            detail: { attempt: ATTEMPT, reason: `synthetic recommendation for ${profileId}` },
          },
        ]
      : [];
  return resolveLoopBackOffer({
    stage,
    segmentStages: segment.stages,
    currentIndex,
    skippedStageIds: [],
    events,
    attempt: ATTEMPT,
    loopBackCount: 0,
  });
};

const matrixRow = ({ profileId, scope, plan, gateStats, checkpoints, ensembles, loopBacks }) => ({
  profile: profileId,
  scope,
  stages: plan?.stages.length ?? 0,
  gates: gateStats,
  checkpoints,
  ensembles: ensembles.length ? ensembles.join(',') : '—',
  loopBack: loopBacks.length ? loopBacks.join(',') : '—',
});

describe('release coexistence matrix', () => {
  it('takes every pinned profile and offered scope from the first stage to the last', async () => {
    const rows = [];
    const failures = [];
    const loopBackTuples = [];

    for (const profileId of PROFILE_IDS) {
      const context = await fixtureContext(profileId);
      const { workflow, releaseLibrary, legacyLibrary } = context;
      const expectedScopeCount = profileId === 'current-stable' ? 9 : 11;
      const scopes = [
        ...new Set(
          workflow.placements.flatMap((placement) => Object.keys(placement.scopeMembership ?? {})),
        ),
      ].toSorted();
      expect(scopes).toHaveLength(expectedScopeCount);

      for (const scope of scopes) {
        let plan = null;
        let gates = 0;
        let checkpoints = 0;
        const ensembles = [];
        const loopBacks = [];

        try {
          const releaseResult = buildExecutionPlan({ workflow, scope, library: releaseLibrary });
          const legacyResult = buildExecutionPlan({ workflow, scope, library: legacyLibrary });
          plan = releaseResult.plan;
          const expectedStages = workflow.placements.filter(
            (placement) => placement.scopeMembership?.[scope] === 'EXECUTE',
          ).length;

          expect(
            releaseResult.valid,
            `${profileId}/${scope} plan errors: ${JSON.stringify(releaseResult.errors)}`,
          ).toBe(true);
          expect(releaseResult.errors).toEqual([]);
          expect(releaseResult.errors.map(({ code }) => code)).not.toContain(
            'capability_unhandled',
          );
          expect(plan.stages).toHaveLength(expectedStages);
          expect(plan.stages.length).toBeGreaterThan(0);
          expect(plan.stages[0].dependencyStageIds).toEqual([]);
          expect(plan.stages.at(-1)).toBeDefined();

          const positionById = new Map(plan.stages.map((stage, index) => [stage.stageId, index]));
          for (const stage of plan.stages) {
            expect(stage.notImplemented).not.toBe(true);
            expect(stage.runtimeError).not.toBe('not_implemented');
            for (const dependencyId of stage.dependencyStageIds) {
              expect(positionById.get(dependencyId)).toBeLessThan(positionById.get(stage.stageId));
            }

            const policyErrors = [];
            const resolvedPolicy = resolveStagePolicy({
              scopeBlock: releaseLibrary.scopesById[scope] ?? null,
              stage: releaseLibrary.stagesById[stage.stageId],
              stageId: stage.stageId,
              errors: policyErrors,
              capabilities: plan.capabilities ?? {},
            });
            expect(policyErrors, `${profileId}/${scope}/${stage.stageId} policy`).toEqual([]);
            expect(stage.policy ?? null).toEqual(resolvedPolicy);
            expect(() => renderScopePolicy(stage.policy ?? null)).not.toThrow();
            expect(typeof renderScopePolicy(stage.policy ?? null)).toBe('string');

            const tools = toolsForRole('author', stage.stageId, stage.policy ?? null);
            for (const tool of CHECKPOINT_TOOLS) {
              const needed =
                tool === 'confirm_summary'
                  ? ['required', 'if-present'].includes(stage.policy?.summaryConfirmation)
                  : stage.policy?.planApproval === 'required';
              expect(tools.includes(tool)).toBe(needed);
            }
            for (const tool of LEARNING_TOOLS) {
              expect(tools.includes(tool)).toBe(stage.policy?.learnings !== 'off');
            }

            const topology = await resolveTopology(stage, releaseLibrary, releaseLibrary.releaseId);
            const supports = (stage.supportAgentRefs ?? []).filter(
              (ref) => ref && ref !== stage.agentRef && releaseLibrary.agentsById[ref],
            );
            const expectedSeparateSessions =
              supports.length > 0 &&
              (stage.mode === 'pipeline' ||
                stage.mode === 'mob' ||
                (stage.mode === 'subagent' &&
                  releaseLibrary.runtimeFilePaths.includes(ENSEMBLE_PROTOCOL_FILE)));
            expect(Boolean(topology), `${profileId}/${scope}/${stage.stageId} topology`).toBe(
              expectedSeparateSessions,
            );
            if (topology) {
              expect(topology.mode).toBe(stage.mode);
              ensembles.push(stage.stageId);
            }

            if (stage.humanValidation !== 'required') {
              const ungated = evaluateGatePreconditions({
                stage,
                policy: stage.policy ?? null,
                attempt: ATTEMPT,
                receipts: [],
                events: [],
                sensorVerdicts: [],
                producedArtifacts: null,
              });
              for (const finding of ungated.findings.filter(
                (item) => item.severity === 'blocking',
              )) {
                expect(DOCUMENTED_UNGATED_FAILURES.has(finding.code)).toBe(true);
              }
              continue;
            }

            gates += 1;
            checkpoints += CHECKPOINT_TOOLS.filter((tool) => tools.includes(tool)).length;

            const compliant = evaluateGatePreconditions(
              gateInputs({ stage, topology, tools, compliant: true }),
            );
            expect(compliant.ok, `${profileId}/${scope}/${stage.stageId} compliant`).toBe(true);
            expect(compliant.findings.filter((item) => item.severity === 'blocking')).toEqual([]);
            const compliantLoopBack = loopBackOfferFor({ stage, stages: plan.stages, profileId });
            const compliantOptions = buildGateOptions({
              findings: compliant.findings,
              loopBackOffered: compliantLoopBack.offered,
            });
            expect(compliantOptions).toContain('approve');
            expect(compliantOptions).toContain('request-changes');
            if (compliantLoopBack.offered) expect(compliantOptions).toContain(LOOP_BACK_OPTION);

            const noEvidence = evaluateGatePreconditions(
              gateInputs({ stage, topology, tools, compliant: false }),
            );
            const blocking = noEvidence.findings.filter((item) => item.severity === 'blocking');
            expect(
              blocking.every((item) => item.overridable),
              `${profileId}/${scope}/${stage.stageId} blocking findings`,
            ).toBe(true);
            const noEvidenceLoopBack = loopBackOfferFor({ stage, stages: plan.stages, profileId });
            const noEvidenceOptions = buildGateOptions({
              findings: noEvidence.findings,
              loopBackOffered: noEvidenceLoopBack.offered,
            });
            expect(noEvidenceOptions).toContain('request-changes');
            if (blocking.length > 0) {
              expect(noEvidenceOptions).toEqual([
                'request-changes',
                'override-and-approve',
                ...(noEvidenceLoopBack.offered ? [LOOP_BACK_OPTION] : []),
              ]);
              expect(noEvidenceOptions).not.toContain('approve');
            } else {
              expect(noEvidenceOptions).toEqual([
                'approve',
                'request-changes',
                ...(noEvidenceLoopBack.offered ? [LOOP_BACK_OPTION] : []),
              ]);
            }
            if (noEvidenceLoopBack.offered) {
              loopBacks.push(`${stage.stageId}→${noEvidenceLoopBack.target.stageId}`);
              loopBackTuples.push({
                profileId,
                scope,
                recommendingStageId: stage.stageId,
                targetStageId: noEvidenceLoopBack.target.stageId,
              });
            }
          }

          const hasUnitDag = plan.stages.some((stage) => stage.stageId === 'units-generation');
          const unitStages = plan.stages.filter((stage) => stage.forEach === UNIT_FOR_EACH);
          expect(releaseResult.errors.map(({ code }) => code)).not.toContain(
            'no_unit_dag_producer',
          );
          expect(releaseResult.errors.map(({ code }) => code)).not.toContain('unit_required');
          expect(releaseResult.warnings.map(({ code }) => code)).not.toContain('unit_required');
          if (!hasUnitDag) {
            for (const stage of unitStages) {
              expect(stage.forEachDegraded).toBe(true);
              expect(stage.parallelSection).toBeNull();
            }
            expect(
              releaseResult.warnings.some(({ code }) => code === 'scope_absent_unit_dag'),
            ).toBe(unitStages.length > 0);
          } else {
            expect(unitStages.every((stage) => !stage.forEachDegraded)).toBe(true);
            expect(
              plan.stages.some((stage) =>
                stage.outputArtifacts.some(
                  (output) => (output.artifact ?? output) === UNIT_DAG_ARTIFACT,
                ),
              ),
            ).toBe(true);
          }

          if (profileId === 'current-stable') {
            expect(sha256(canonicalJson(legacyResult.plan))).toBe(LEGACY_PLAN_DIGESTS[scope]);
            const releasePlanWithoutClosureCapabilities = { ...releaseResult.plan };
            delete releasePlanWithoutClosureCapabilities.capabilities;
            expect(releasePlanWithoutClosureCapabilities).toEqual(legacyResult.plan);
            const releasePromptTools = toolAndPromptContract(plan, releaseLibrary);
            const legacyPromptTools = toolAndPromptContract(legacyResult.plan, legacyLibrary);
            expect(sha256(canonicalJson(releasePromptTools))).toBe(
              sha256(canonicalJson(legacyPromptTools)),
            );
            expect(releasePromptTools).toEqual(legacyPromptTools);
          }

          rows.push(
            matrixRow({
              profileId,
              scope,
              plan,
              gateStats: gates,
              checkpoints,
              ensembles,
              loopBacks,
            }),
          );
        } catch (error) {
          rows.push(
            matrixRow({
              profileId,
              scope,
              plan,
              gateStats: gates,
              checkpoints,
              ensembles,
              loopBacks,
            }),
          );
          failures.push({ profileId, scope, error });
        }
      }
    }

    if (failures.length > 0 || process.env.AIDLC_RELEASE_MATRIX === '1') {
      console.table(rows);
    }
    expect(loopBackTuples).toEqual(EXPECTED_LOOP_BACK_TUPLES);
    expect(
      failures.map(({ profileId, scope, error }) => `${profileId}/${scope}: ${error.message}`),
    ).toEqual([]);
  });
});
