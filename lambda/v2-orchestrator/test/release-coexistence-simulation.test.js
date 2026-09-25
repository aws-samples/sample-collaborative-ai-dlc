import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  filesFromCompatibilityFixture,
  normalizeAidlcFrontmatter,
} from '../../shared/aidlc-compatibility.js';
import { buildFromFiles } from '../../shared/block-mappers.js';
import {
  buildExecutionPlan,
  planSegments,
  stageInstanceId as planStageInstanceId,
} from '../../shared/v2-execution-plan.js';
import { __durableHandler } from '../index.js';

vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});

const PROFILE_IDS = ['current-stable', 'v2.6.18', 'v2.7.0', 'v2.8.2', 'v2.9.0'];
const UNIT_PLAN = {
  units: [
    { slug: 'auth', dependsOn: [] },
    { slug: 'billing', dependsOn: ['auth'] },
  ],
  batches: [['auth'], ['billing']],
  skipMatrix: {},
  walkingSkeleton: 'auth',
};

const fixtureFiles = (profileId) => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(`../../shared/test/fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
      'utf8',
    ),
  );
  const files = filesFromCompatibilityFixture({ profileId, fixture });

  // Release import normalizes the 2.8+ command-template dialect before YAML
  // parsing; the vendored fixtures intentionally retain the upstream bytes.
  return new Map(
    [...files].map(([path, content]) => {
      const normalized = normalizeAidlcFrontmatter({ profileId, path, content });
      if (normalized.error) throw new Error(normalized.error.message);
      return [path, normalized.content];
    }),
  );
};

const blocksById = (blocks, type) =>
  Object.fromEntries(
    blocks
      .filter((block) => block.type === type && block.id)
      .map((block) => [block.id, { ...block, version: 1 }]),
  );

const resolveReleaseProfiles = () =>
  PROFILE_IDS.map((profileId) => {
    const { blocks, workflow, runtimeFiles } = buildFromFiles(fixtureFiles(profileId));
    const library = {
      stagesById: blocksById(blocks, 'STAGE'),
      agentsById: blocksById(blocks, 'AGENT'),
      sensorsById: blocksById(blocks, 'SENSOR'),
      rulesById: blocksById(blocks, 'RULE'),
      artifactsById: blocksById(blocks, 'ARTIFACT'),
      scopesById: blocksById(blocks, 'SCOPE'),
      fromRelease: true,
      runtimeFilePaths: [...runtimeFiles.keys()].toSorted(),
    };
    const scopes = [
      ...new Set(
        workflow.placements.flatMap((placement) => Object.keys(placement.scopeMembership ?? {})),
      ),
    ].toSorted();

    return {
      profileId,
      scopes: scopes.map((scope) => {
        const result = buildExecutionPlan({
          workflow: { ...workflow, version: 1 },
          scope,
          library,
        });
        expect(result.valid, `${profileId}/${scope}: ${JSON.stringify(result.errors)}`).toBe(true);
        return { scope, plan: result.plan };
      }),
    };
  });

const segmentsFor = (plan) => planSegments(plan.stages);

const loopBackStagesFor = (plan) => {
  const segment = segmentsFor(plan).find(
    (candidate) =>
      candidate.kind === 'stages' &&
      candidate.stages.some((stage) => stage.stageId === 'build-and-test'),
  );
  if (!segment) return [];
  const buildAndTestIndex = segment.stages.findIndex((stage) => stage.stageId === 'build-and-test');
  const targetIndex = segment.stages.findIndex(
    (stage) =>
      stage.stageId === 'code-generation' &&
      stage.outputArtifacts.some((output) => output.artifact === 'code-generation-plan'),
  );
  const buildAndTest = segment.stages[buildAndTestIndex];
  if (
    buildAndTestIndex < 0 ||
    targetIndex < 0 ||
    targetIndex >= buildAndTestIndex ||
    buildAndTest.policy?.loopBack !== 'human-offered'
  ) {
    return [];
  }
  return segment.stages.slice(targetIndex, buildAndTestIndex + 1);
};

const answerFor = (gate, world) => {
  if (gate.kind === 'halt' || gate.options?.includes('retry')) return { decision: 'retry' };
  if (gate.kind === 'question') return { answer: 'Continue with the approved choice' };
  if (gate.kind === 'checkpoint') return { answer: 'Looks correct', decision: 'reconfirm' };
  if (gate.kind === 'change-control') return { answer: 'reconfirm', decision: 'reconfirm' };
  if (gate.options?.includes('loop-back') && world.loopBackExpected && !world.loopBackChosen) {
    world.loopBackChosen = true;
    return { decision: 'loop-back' };
  }
  if (gate.options?.includes('override-and-approve')) {
    return { decision: 'override-and-approve', reason: 'Accepted for the simulation' };
  }
  if (gate.findings?.some((finding) => finding.code === 'change_control_input_changed')) {
    return { decision: 'approve', changeControl: 'reconfirm' };
  }
  if (gate.options?.includes('approve')) return { decision: 'approve' };
  if (gate.options?.includes('autonomous')) return { mode: 'autonomous' };
  return { answer: 'reconfirm' };
};

const makeWorld = ({ profileId, scope, plan, fault, loopBackStages }) => {
  const world = {
    profileId,
    scope,
    plan,
    fault,
    loopBackStages,
    loopBackExpected: loopBackStages.length > 0,
    loopBackChosen: false,
    raceGateUsed: false,
    gateResolvers: new Map(),
    stageResolvers: new Map(),
    gates: new Map(),
    invokes: [],
    stageRuns: [],
    stageResults: [],
    statusWrites: [],
    events: [],
    receipts: [],
    unitStates: [],
    execution: {
      executionId: 'exec-1',
      intentId: 'intent-1',
      projectId: 'project-1',
      status: 'CREATED',
      workflowId: plan.workflowId,
      workflowVersion: plan.workflowVersion,
      scope,
      startedAt: '2026-01-01T00:00:00.000Z',
      startedBy: 'simulation-user',
      repos: ['owner/repo'],
      branch: 'aidlc/intent-1',
      baseBranch: 'main',
      gitProvider: 'github',
      agentCli: 'kiro',
      parkReleaseSeconds: null,
      methodologyRelease: {
        releaseId: `aidlc:${profileId}`,
        sourceSha: 'a'.repeat(40),
        importerRevision: 2,
        closureDigest: 'd'.repeat(64),
      },
    },
    stageRows: new Map(),
    stageRunCounts: new Map(),
    parkedStageIds: new Set(),
    parkTargets: new Map(),
    faultUsed: false,
    faultStage: null,
  };

  const oncePerWorkflow = plan.stages.filter(
    (stage) => stage.parallelSection == null && stage.humanValidation === 'required',
  );
  for (const [index, stage] of oncePerWorkflow.slice(0, 2).entries()) {
    world.parkTargets.set(stage.stageId, ['question', 'checkpoint'][index]);
  }
  if (fault === 'answer-before-bind') world.raceGateUsed = false;
  if (fault === 'blocking-finding') {
    world.faultStage = plan.stages.find(
      (stage) =>
        stage.parallelSection == null &&
        stage.humanValidation === 'required' &&
        stage.policy?.sensorsEnabled &&
        stage.sensors.length > 0,
    );
    expect(
      world.faultStage,
      `${profileId}/${scope} has a sensor-enabled validation stage`,
    ).toBeTruthy();
  }
  if (fault === 'lane-retry') {
    world.faultStage = plan.stages.find((stage) => stage.parallelSection != null);
    expect(world.faultStage, `${profileId}/${scope} has a unit lane`).toBeTruthy();
  }

  const statusFor = (answer) =>
    ['approve', 'override-and-approve'].includes(answer?.decision) || answer?.mode
      ? 'approved'
      : answer?.decision === 'request-changes'
        ? 'rejected'
        : 'answered';

  const answerGate = (humanTaskId) => {
    const gate = world.gates.get(humanTaskId);
    if (!gate || gate.status !== 'pending') return;
    const answer = answerFor(gate, world);
    gate.answer = answer;
    gate.answeredAt = '2026-01-01T00:00:01.000Z';
    gate.answeredBy = 'simulation-user';
    gate.answeredByName = 'Simulation Human';
    gate.status = statusFor(answer);
    if (gate.kind === 'validation') world.answers.push({ gate, answer });
    world.gateResolvers.get(humanTaskId)?.({ answer });
  };
  world.answers = [];

  const ctx = {
    logger: { info() {}, debug() {}, error() {} },
    step: async (_name, fn) => fn(),
    createCallback: async (name) => {
      const callbackId = `callback-${name}`;
      if (name.startsWith('stage-cb-')) {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        world.stageResolvers.set(callbackId, resolve);
        return [promise, callbackId];
      }
      if (name.startsWith('await-')) {
        const humanTaskId = name.slice('await-'.length);
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        world.gateResolvers.set(humanTaskId, resolve);
        return [promise, callbackId];
      }
      return [Promise.resolve({ answer: null }), callbackId];
    },
    wait: async () => undefined,
    promise: {
      race: async (_name, promises) => Promise.race(promises),
      allSettled: async (_name, promises) => Promise.allSettled(promises),
    },
    runInChildContext: (_name, fn) => Promise.resolve().then(() => fn(ctx)),
  };

  const store = {
    getExecution: async () => ({ ...world.execution }),
    updateExecution: async (input) => {
      if (
        input.ifOrchestratorRunId &&
        input.ifOrchestratorRunId !== world.execution.orchestratorRunId
      ) {
        throw Object.assign(new Error('run ownership changed'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      Object.assign(world.execution, input);
      if (input.status) world.statusWrites.push(input.status);
      return { orchestratorRunId: world.execution.orchestratorRunId };
    },
    createHumanTask: async (input) => {
      if (!world.gates.has(input.humanTaskId)) {
        world.gates.set(input.humanTaskId, { ...input, status: 'pending' });
      }
      return world.gates.get(input.humanTaskId);
    },
    getHumanTask: async (_executionId, humanTaskId) => world.gates.get(humanTaskId) ?? null,
    setGateCallbackId: async (input) => {
      const gate = world.gates.get(input.humanTaskId);
      if (!gate) throw new Error(`gate ${input.humanTaskId} does not exist`);
      if (fault === 'answer-before-bind' && gate.kind === 'question' && !world.raceGateUsed) {
        world.raceGateUsed = true;
        world.faultUsed = true;
        answerGate(input.humanTaskId);
        gate.callbackId = null;
        return null;
      }
      gate.callbackId = input.callbackId;
      gate.callbackOwner = input.callbackOwner;
      gate.stageInstanceId ??= input.stageInstanceId;
      world.execution.pendingHumanTaskId = null;
      setTimeout(() => answerGate(input.humanTaskId), 0);
      return {};
    },
    supersedeHumanTask: async () => ({}),
    appendEvent: async (event) => {
      world.events.push(event);
      return event;
    },
    listEvents: async () => world.events,
    getStage: async (_executionId, stageInstanceId) => world.stageRows.get(stageInstanceId) ?? null,
    putStage: async (input) => {
      world.stageRows.set(input.stageInstanceId, { ...input });
      return input;
    },
    resetStageRow: async ({ stageInstanceId, loopBackId }) => {
      const row = world.stageRows.get(stageInstanceId);
      const next = {
        ...row,
        state: 'PENDING',
        attempt: Number(row?.attempt ?? 0) + 1,
        ...(loopBackId
          ? {
              loopBackCount: Number(row?.loopBackCount ?? 0) + 1,
              lastLoopBackId: loopBackId,
            }
          : {}),
      };
      world.stageRows.set(stageInstanceId, next);
      return next;
    },
    listReceipts: async (_executionId, { stageInstanceId, attempt } = {}) =>
      world.receipts.filter(
        (receipt) =>
          (stageInstanceId == null || receipt.stageInstanceId === stageInstanceId) &&
          (attempt == null || Number(receipt.attempt) === Number(attempt)),
      ),
    putReceipt: async (receipt) => {
      world.receipts.push(receipt);
      return receipt;
    },
    getUnitPlan: async () => UNIT_PLAN,
    updateUnitPlanDecisions: async (input) => {
      world.unitPlanDecisions = { ...world.unitPlanDecisions, ...input };
      return world.unitPlanDecisions;
    },
    listUnits: async () => [],
    updateUnitState: async (input) => {
      world.unitStates.push(`${input.slug}:${input.state}`);
      return input;
    },
    updateUnitPr: async (input) => input,
    failRunningStageAttempt: async (input) => {
      world.failedStageAttempts ??= [];
      world.failedStageAttempts.push(input);
      return null;
    },
  };

  const deps = {
    store,
    loadPlan: async () => ({ valid: true, plan }),
    invokeRuntime: async (payload) => {
      world.invokes.push(payload);
      if (payload.command === 'run-stage-start') {
        const key = `${payload.stageId}:${payload.unitSlug ?? 'intent'}`;
        const attempt = world.stageRunCounts.get(key) ?? 0;
        world.stageRunCounts.set(key, attempt + 1);
        world.stageRuns.push(payload);
        const stageInstanceId =
          payload.stageInstanceId ??
          (payload.unitSlug
            ? planStageInstanceId(
                plan.namespace,
                payload.stageId,
                payload.unitSlug,
                payload.sectionIndex,
              )
            : plan.stages.find((stage) => stage.stageId === payload.stageId)?.stageInstanceId);
        const plannedStage = plan.stages.find((stage) => stage.stageId === payload.stageId);

        let result;
        const parkedKind = world.parkTargets.get(payload.stageId);
        if (parkedKind && !world.parkedStageIds.has(payload.stageId)) {
          world.parkedStageIds.add(payload.stageId);
          const humanTaskId = `stage-${parkedKind}-${payload.stageId}`;
          world.gates.set(humanTaskId, {
            humanTaskId,
            stageInstanceId,
            kind: parkedKind,
            status: 'pending',
          });
          world.execution.pendingHumanTaskId = humanTaskId;
          result = {
            ok: true,
            state: 'WAITING_FOR_HUMAN',
            humanTaskId,
            stageInstanceId,
            unitSlug: payload.unitSlug ?? null,
          };
        } else if (
          fault === 'lane-retry' &&
          !world.faultUsed &&
          payload.unitSlug === UNIT_PLAN.walkingSkeleton &&
          payload.stageId === world.faultStage.stageId
        ) {
          world.faultUsed = true;
          result = { ok: false, state: 'FAILED', reason: 'synthetic_lane_failure' };
        } else {
          const outputArtifacts = payload.outputArtifacts ?? plannedStage?.outputArtifacts ?? [];
          const producedHeads = outputArtifacts.map((output, index) => ({
            artifactType: output.artifact,
            logicalKey: `ARTIFACT#${output.artifact}`,
            snapshotHash: `${String(index + 1).padStart(2, '0')}${'a'.repeat(62)}`,
          }));
          const findings = [];
          const gateSensorVerdicts = [];
          if (
            fault === 'blocking-finding' &&
            !world.faultUsed &&
            payload.stageId === world.faultStage.stageId
          ) {
            world.faultUsed = true;
            gateSensorVerdicts.push({
              sensorId: world.faultStage.sensors[0]?.sensorId,
              result: 'FAIL',
              severity: 'blocking',
              detail: { artifact: 'synthetic-output.md', reason: 'synthetic blocking finding' },
            });
          }
          result = {
            ok: true,
            state: 'SUCCEEDED',
            stageInstanceId,
            producedHeads,
            findings,
            gateSensorVerdicts,
            changedInputs: plannedStage?.policy?.changeControl
              ? [
                  {
                    artifactId: 'requirements',
                    previousSnapshotHash: 'a'.repeat(64),
                    currentSnapshotHash: 'b'.repeat(64),
                  },
                ]
              : [],
            verification: 'synthetic checks passed',
          };
          world.stageResults.push({ payload, result });

          if (plannedStage?.policy?.summaryConfirmation) {
            const receipt = {
              executionId: 'exec-1',
              kind: 'summary-confirmation',
              stageInstanceId,
              attempt: Number(world.stageRows.get(stageInstanceId)?.attempt ?? 0),
              sk: `summary-${stageInstanceId}-${world.stageRunCounts.get(key)}`,
              decidedAt: '2026-01-01T00:00:01.000Z',
            };
            world.receipts.push(receipt);
            for (const head of producedHeads) {
              world.events.push({
                type: 'v2.artifact.stamped',
                stageInstanceId,
                detail: {
                  artifactType: head.artifactType,
                  authorizationId: receipt.sk,
                },
                timestamp: '2026-01-01T00:00:02.000Z',
              });
            }
          }
          if (plannedStage?.policy?.planApproval === 'required') {
            world.receipts.push({
              executionId: 'exec-1',
              kind: 'plan-approval',
              stageInstanceId,
              attempt: Number(world.stageRows.get(stageInstanceId)?.attempt ?? 0),
            });
          }

          if (
            payload.stageId === 'build-and-test' &&
            world.loopBackExpected &&
            (world.stageRunCounts.get(key) ?? 0) === 1
          ) {
            world.events.push({
              type: 'v2.loopback.recommended',
              stageInstanceId,
              detail: { attempt: 0, reason: 'synthetic integration test failure' },
            });
          }
        }

        if (stageInstanceId) {
          const existing = world.stageRows.get(stageInstanceId) ?? {};
          world.stageRows.set(stageInstanceId, {
            ...existing,
            stageInstanceId,
            state: result.state,
            attempt: Number(existing.attempt ?? 0),
          });
        }
        world.stageResolvers.get(payload.stageCallbackId)(result);
        return { ok: true, accepted: true, stageId: payload.stageId };
      }
      if (payload.command === 'promote-units') {
        return {
          ok: true,
          unitCount: UNIT_PLAN.units.length,
          batchCount: UNIT_PLAN.batches.length,
          walkingSkeleton: UNIT_PLAN.walkingSkeleton,
        };
      }
      return { ok: true, checkpointId: `checkpoint-${world.invokes.length}` };
    },
    resolveToken: async () => 'simulation-token',
    stopSession: async () => ({ stopped: true }),
    broadcast: async () => {},
    openPr: async () => ({ skipped: true, reason: 'no_changes' }),
    comparePrBranches: async () => ({ status: 'unknown' }),
    applicationUrl: 'https://aidlc.example.test/',
  };

  return { world, ctx, deps };
};

const runCell = async ({ profileId, scope, plan, fault = null }) => {
  const loopBackStages = loopBackStagesFor(plan);
  const { world, ctx, deps } = makeWorld({ profileId, scope, plan, fault, loopBackStages });
  const result = await __durableHandler(
    { action: 'start', intentId: 'intent-1', executionId: 'exec-1' },
    ctx,
    deps,
  );
  return { result, world, loopBackStages };
};

const expectedValidationGateCount = (plan, loopBackStages) => {
  // Per-unit stages are governed by the section's skeleton and batch gates.
  const unitStageGates = plan.stages.filter(
    (stage) => stage.parallelSection != null && stage.humanValidation === 'required',
  ).length;
  const oncePerWorkflowGates = plan.summary.approvalGates - unitStageGates;
  return (
    oncePerWorkflowGates +
    loopBackStages.filter((stage) => stage.humanValidation === 'required').length
  );
};

const expectedSectionGateCount = (plan) =>
  plan.sections.reduce((count, section) => {
    const stages = plan.stages.filter((stage) => stage.parallelSection === section.index);
    const skeletonCeremonyOff = stages.some((stage) => stage.policy?.skeleton === 'off');
    const skeletonApproval = skeletonCeremonyOff ? 0 : 1;
    const autonomyChoice = UNIT_PLAN.units.length > 1 ? 1 : 0;
    return count + skeletonApproval + autonomyChoice;
  }, 0);

const compactCoverage = (profileRows) => {
  const header =
    '| Release | Scopes | Planned stages | Stage runs | Validation gates | All gates |\n|---|---:|---:|---:|---:|---:|';
  const rows = profileRows.map(
    ({ profileId, scopes, plannedStages, stageRuns, validationGates, gates }) =>
      `| ${profileId} | ${scopes} | ${plannedStages} | ${stageRuns} | ${validationGates} | ${gates} |`,
  );
  process.stdout.write(`${[header, ...rows].join('\n')}\n`);
};

describe('pinned AI-DLC release coexistence through a full v2 run', () => {
  it(
    'completes every real release-mode plan and scope, including gates, lanes, and loop-back',
    { timeout: 55_000 },
    async () => {
      const profiles = resolveReleaseProfiles();
      const report = [];
      const allRuns = [];
      const faultCells = new Map([
        ['v2.6.18/feature', 'lane-retry'],
        ['v2.7.0/mvp', 'blocking-finding'],
        ['v2.8.2/express', 'answer-before-bind'],
      ]);

      for (const { profileId, scopes } of profiles) {
        let plannedStages = 0;
        let stageRuns = 0;
        let validationGates = 0;
        let gates = 0;
        for (const { scope, plan } of scopes) {
          const fault = faultCells.get(`${profileId}/${scope}`) ?? null;
          const { result, world, loopBackStages } = await runCell({
            profileId,
            scope,
            plan,
            fault,
          });
          const cell = `${profileId}/${scope}`;

          expect(result, `${cell} execution result: ${JSON.stringify(result)}`).toMatchObject({
            ok: true,
            intentId: 'intent-1',
            stages: plan.stages.length,
          });
          expect(result.reason, `${cell} must not retire`).not.toBe('retired');
          expect(world.statusWrites.at(-1), `${cell} final status`).toBe('SUCCEEDED');
          expect(world.statusWrites).not.toContain('FAILED');
          expect(world.faultUsed, `${cell} injected fault was exercised`).toBe(fault !== null);

          for (const stage of plan.stages) {
            const ran = world.stageRuns.filter((run) => run.stageId === stage.stageId);
            expect(ran.length, `${cell} planned stage ${stage.stageId} ran`).toBeGreaterThan(0);
            if (stage.parallelSection != null) {
              for (const { slug } of UNIT_PLAN.units) {
                expect(
                  ran.some((run) => run.unitSlug === slug),
                  `${cell} lane stage ${stage.stageId} ran for ${slug}`,
                ).toBe(true);
              }
            } else {
              expect(
                ran.some((run) => run.unitSlug == null),
                `${cell} once-per-workflow stage ${stage.stageId} ran outside a lane`,
              ).toBe(true);
            }
          }

          const validation = [...world.gates.values()].filter((gate) => gate.kind === 'validation');
          const expectedGateCount = expectedValidationGateCount(
            plan,
            world.loopBackChosen ? loopBackStages : [],
          );
          expect(
            validation,
            `${cell} once-per-workflow validation gates match the plan and loop-back passes`,
          ).toHaveLength(expectedGateCount);
          for (const gate of validation) {
            expect(
              gate.options?.some((option) => ['approve', 'override-and-approve'].includes(option)),
              `${cell} ${gate.humanTaskId} must not dead-end without approval or override`,
            ).toBe(true);
            expect(gate.status, `${cell} ${gate.humanTaskId} was answered`).not.toBe('pending');
          }

          expect(
            [...world.gates.values()].every((gate) => gate.status !== 'pending'),
            `${cell} every offered gate received an answer`,
          ).toBe(true);
          expect(
            world.gates.size,
            `${cell} all validation, section, question, and checkpoint gates match the run plan`,
          ).toBe(
            expectedGateCount +
              world.parkTargets.size +
              expectedSectionGateCount(plan) +
              (fault === 'lane-retry' ? 1 : 0),
          );
          if (plan.sections.length > 0) {
            expect(
              world.events.some((event) => event.type === 'v2.units.fanout_approved'),
              `${cell} fan-out approval completed`,
            ).toBe(true);
          }
          expect(
            [...world.gates.values()]
              .filter((gate) => gate.kind === 'checkpoint')
              .map((g) => g.answer),
            `${cell} checkpoint answer`,
          ).toContainEqual({ answer: 'Looks correct', decision: 'reconfirm' });
          const changeControlGates = validation.filter((gate) =>
            gate.findings?.some((finding) => finding.code === 'change_control_input_changed'),
          );
          if (plan.stages.some((stage) => stage.policy?.changeControl)) {
            expect(
              changeControlGates,
              `${cell} reconfirmed a changed approved input`,
            ).not.toHaveLength(0);
            expect(
              changeControlGates.some((gate) => gate.answer?.changeControl === 'reconfirm'),
              `${cell} human explicitly reconfirmed the changed input`,
            ).toBe(true);
          }

          if (loopBackStages.length > 0) {
            expect(
              world.loopBackChosen,
              `${cell} offered and accepted a loop-back; gate options: ${JSON.stringify(
                [...world.gates.values()]
                  .filter(
                    (gate) =>
                      gate.stageInstanceId ===
                      plan.stages.find((s) => s.stageId === 'build-and-test')?.stageInstanceId,
                  )
                  .map(({ options, findings, answer }) => ({ options, findings, answer })),
              )}; recommendation: ${JSON.stringify(
                world.events.filter((event) => event.type === 'v2.loopback.recommended'),
              )}`,
            ).toBe(true);
            const codeGenerationRuns = world.stageRuns.filter(
              (run) => run.stageId === 'code-generation',
            );
            expect(codeGenerationRuns.length, `${cell} code-generation re-ran`).toBeGreaterThan(1);
            expect(
              world.stageRuns.findIndex((run) => run.stageId === 'code-generation'),
              `${cell} re-run continued to build-and-test`,
            ).toBeLessThan(
              world.stageRuns.findIndex(
                (run, index) => run.stageId === 'build-and-test' && index > 0,
              ),
            );
          } else {
            expect(world.loopBackChosen, `${cell} no loop-back was selected`).toBe(false);
          }

          if (fault === 'lane-retry') {
            expect(
              [...world.gates.values()].some(
                (gate) => gate.options?.includes('retry') && gate.answer?.decision === 'retry',
              ),
              `${cell} failed lane was retried by the human`,
            ).toBe(true);
          }
          if (fault === 'blocking-finding') {
            expect(
              [...world.gates.values()].some(
                (gate) =>
                  gate.kind === 'validation' &&
                  gate.findings?.some((finding) => finding.severity === 'blocking') &&
                  gate.answer?.decision === 'override-and-approve',
              ),
              `${cell} blocking finding used the override path`,
            ).toBe(true);
            expect(world.events.some((event) => event.type === 'v2.gate.override')).toBe(true);
          }
          if (fault === 'answer-before-bind') {
            expect(world.raceGateUsed, `${cell} answered before binding`).toBe(true);
            expect(world.statusWrites.at(-1)).toBe('SUCCEEDED');
          }

          allRuns.push({
            profileId,
            scope,
            stageRuns: world.stageRuns.length,
            gates: world.gates.size,
          });
          plannedStages += plan.stages.length;
          stageRuns += world.stageRuns.length;
          validationGates += validation.length;
          gates += world.gates.size;
        }
        report.push({
          profileId,
          scopes: scopes.length,
          plannedStages,
          stageRuns,
          validationGates,
          gates,
        });
      }

      expect(allRuns).toHaveLength(
        profiles.reduce((count, profile) => count + profile.scopes.length, 0),
      );
      if (process.env.AIDLC_RELEASE_SIMULATION_REPORT === '1') compactCoverage(report);
    },
  );
});
