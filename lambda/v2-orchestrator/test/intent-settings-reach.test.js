// The per-intent AI-DLC settings have to reach the plan the RUN resolves, not
// only the one the intents API validated at create/PATCH.
//
// There are three plan resolutions per run and they must agree: the walk's
// initial `loadPlan`, the container's own resolution in `resolveStage`, and the
// re-resolution after learning rules are merged. A settings overlay that reaches
// the first but not the dispatch is worse than one that reaches none — the
// timeline would show a policy the agent never ran under. So this file asserts
// the projection on the walk AND on the dispatch payload, from a META row shaped
// exactly like one the intents API writes, and then feeds that payload to the
// real container entry point to prove the stage materializes under it.

import { describe, it, expect, vi } from 'vitest';
import { __durableHandler } from '../index.js';
import { runStage } from '../../agentcore/commands/run-stage.js';

const AIDLC_SETTINGS = Object.freeze({ guardPolicy: 'strict', planApproval: 'off' });

const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  status: 'CREATED',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'classic',
  startedAt: 'T',
  startedBy: 'u1',
  repos: ['owner/repo'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  parkReleaseSeconds: null,
  methodologyRelease: { releaseId: 'rel-211' },
  aidlcSettings: AIDLC_SETTINGS,
};

const makeCtx = () => {
  const stageCallbacks = new Map();
  const ctx = {
    logger: { info() {}, debug() {}, error() {} },
    step: async (_name, fn) => fn(),
    createCallback: async (name) => {
      if (String(name).startsWith('stage-cb-')) {
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        const id = `cb-${name}`;
        stageCallbacks.set(id, resolve);
        return [promise, id];
      }
      return [Promise.resolve({ answer: null }), `cb-${name}`];
    },
    wait: async () => undefined,
    promise: {
      race: async (_name, promises) => Promise.race(promises),
      allSettled: async (_name, promises) => Promise.allSettled(promises),
    },
    runInChildContext: (_name, fn) => Promise.resolve().then(() => fn(ctx)),
    stageCallbackResolvers: stageCallbacks,
  };
  return ctx;
};

const depsFor = (ctx, meta, invokes) => ({
  store: {
    getExecution: vi.fn(async () => meta),
    updateExecution: vi.fn(async () => ({})),
    createHumanTask: vi.fn(async (task) => ({ ...task, status: 'pending' })),
    setGateCallbackId: vi.fn(async () => ({})),
    supersedeHumanTask: vi.fn(async () => ({})),
    getHumanTask: vi.fn(async () => ({ status: 'answered' })),
    appendEvent: vi.fn(async () => ({})),
    putTrackerSync: vi.fn(async (sync) => sync),
    failRunningStageAttempt: vi.fn(async () => null),
    listUnits: vi.fn(async () => []),
    getUnit: vi.fn(async () => null),
  },
  loadPlan: vi.fn(async () => ({ valid: true, plan: { stages: [{ stageId: 'a' }] } })),
  invokeRuntime: vi.fn(async (payload) => {
    invokes.push(payload);
    if (payload.command === 'create-workflow-checkpoint') {
      return { ok: true, checkpointId: 'cp' };
    }
    if (payload.command === 'run-stage-start') {
      ctx.stageCallbackResolvers.get(payload.stageCallbackId)?.({ ok: true, state: 'SUCCEEDED' });
      return { ok: true, accepted: true, stageId: payload.stageId };
    }
    return { ok: true };
  }),
  issueAgentCredentialGrant: vi.fn(async () => 'grant'),
  stopSession: vi.fn(async () => ({ stopped: true })),
  broadcast: vi.fn(async () => {}),
  openPr: vi.fn(async () => ({ skipped: true, reason: 'no_changes' })),
  comparePrBranches: vi.fn(async () => ({ status: 'unknown' })),
  applicationUrl: 'https://example.test/',
});

const runStart = async (meta) => {
  const ctx = makeCtx();
  const invokes = [];
  const deps = depsFor(ctx, meta, invokes);
  await __durableHandler({ action: 'start', intentId: 'i1', executionId: 'i1' }, ctx, deps);
  return { deps, invokes };
};

describe('the recorded AI-DLC settings reach the running plan', () => {
  it('projects them onto the walk plan and every stage dispatch', async () => {
    const { deps, invokes } = await runStart(META);

    const planArgs = deps.loadPlan.mock.calls.map(([args]) => args);
    expect(planArgs.length).toBeGreaterThan(0);
    for (const args of planArgs) {
      expect(args.intentSettings).toEqual(AIDLC_SETTINGS);
    }

    const dispatches = invokes.filter((payload) => payload.command === 'run-stage-start');
    expect(dispatches.length).toBeGreaterThan(0);
    for (const payload of dispatches) {
      expect(payload.intentSettings).toEqual(AIDLC_SETTINGS);
    }
  });

  // The byte-identical half of the claim: an intent that recorded nothing — every
  // unpinned, 2.3.3, 2.8.2 and 2.9.0 intent — must send exactly the payload it
  // sent before, with no new key.
  it('adds no key for an intent that recorded none', async () => {
    const { deps, invokes } = await runStart({ ...META, aidlcSettings: undefined });

    for (const [args] of deps.loadPlan.mock.calls) {
      expect(args).not.toHaveProperty('intentSettings');
    }
    for (const payload of invokes.filter((item) => item.command === 'run-stage-start')) {
      expect(payload).not.toHaveProperty('intentSettings');
    }
  });

  // CONNECTED: the dispatch payload the orchestrator really produced is handed
  // to the real container entry point, and the policy the stage materializes
  // under is asserted. Asserting the payload alone would pass for a container
  // that ignored the field, which is the shape the earlier miss had.
  it('materializes the stage under the settings the dispatch carried', async () => {
    const { invokes } = await runStart(META);
    const dispatch = invokes.find((payload) => payload.command === 'run-stage-start');
    expect(dispatch.intentSettings).toEqual(AIDLC_SETTINGS);

    const library = {
      fromRelease: true,
      stagesById: {
        'requirements-analysis': {
          id: 'requirements-analysis',
          version: 1,
          phase: 'inception',
          mode: 'inline',
          leadAgent: 'aidlc-product-agent',
          produces: ['requirements-analysis'],
          consumes: [],
          sensors: [],
          humanValidation: 'required',
          bodyRef: { s3Key: 'blocks/bodies/sha256/stage' },
        },
      },
      agentsById: {
        'aidlc-product-agent': {
          id: 'aidlc-product-agent',
          modelOverride: null,
          bodyRef: { s3Key: 'blocks/bodies/sha256/agent' },
        },
      },
      sensorsById: {},
      rulesById: {},
      artifactsById: { 'requirements-analysis': { id: 'requirements-analysis', terminal: true } },
      knowledgeById: {},
      scopesById: {
        classic: { id: 'classic', guardPolicy: 'off', planApproval: 'on', collaborators: 'off' },
      },
    };
    const workflow = {
      id: 'aidlc-v2',
      version: 1,
      placements: [
        { stageId: 'requirements-analysis', order: 0, scopeMembership: { classic: 'EXECUTE' } },
      ],
      ruleRefs: [],
      scopeRefs: [{ scopeId: 'classic' }],
    };
    const materialized = [];

    const store = {
      putStage: async () => ({}),
      updateExecution: async () => ({}),
      updateStageState: async () => ({}),
      appendEvent: async () => ({}),
      appendOutput: async () => ({ seq: 1, timestamp: 'T' }),
      recordSensorRun: async () => ({}),
      recordMetric: async () => ({ metricId: 'm' }),
      listPendingSteering: async () => [],
      getHumanTask: async () => null,
      getStage: async () => null,
      getExecution: async () => META,
      getUnitPlan: async () => null,
    };
    const deps = {
      store,
      loadLibrary: async () => ({ workflow, library }),
      loadBlockBody: async () => '',
      clock: () => 'T',
      availableClis: ['claude'],
      env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
      materializeMcpConfig: async () => '/ws/.aidlc/mcp.json',
      renderRulesDoc: () => '',
      materializeStage: async ({ stage: resolvedStage }) => {
        materialized.push(resolvedStage.policy);
        return { prompt: 'PROMPT', mcpConfigPath: '/ws/.aidlc/mcp.json' };
      },
      spawnFn: () => ({
        on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
        stdin: { end() {} },
      }),
    };
    const result = await runStage(
      {
        projectId: dispatch.projectId,
        intentId: dispatch.intentId,
        executionId: dispatch.executionId,
        workflowId: dispatch.workflowId,
        workflowVersion: dispatch.workflowVersion,
        scope: dispatch.scope,
        stageId: 'requirements-analysis',
        intentSettings: dispatch.intentSettings,
        methodologyRelease: dispatch.methodologyRelease,
        workspaceDir: '/ws',
      },
      deps,
    );

    expect(result).toMatchObject({ ok: true });
    expect(materialized).toHaveLength(1);
    // `classic` authors guard_policy off and plan_approval on; the recorded
    // overrides invert both, and the container has to see the inverted values.
    expect(materialized[0]).toMatchObject({
      guardPolicy: 'strict',
      changeControl: 'strict',
      collaborators: 'off',
    });

    // The discriminating control: the same dispatch without the settings
    // resolves the scope's own `off` guard, so the assertion above is about the
    // overlay and not about the fixture.
    materialized.length = 0;
    await runStage(
      {
        projectId: dispatch.projectId,
        intentId: dispatch.intentId,
        executionId: dispatch.executionId,
        workflowId: dispatch.workflowId,
        workflowVersion: dispatch.workflowVersion,
        scope: dispatch.scope,
        stageId: 'requirements-analysis',
        methodologyRelease: dispatch.methodologyRelease,
        workspaceDir: '/ws',
      },
      deps,
    );
    expect(materialized[0]).toMatchObject({ guardPolicy: 'off', changeControl: null });
  });
});

// A composed grid's `scope` names no SCOPE block, so a dispatch that omits the
// recorded base scope materializes NO policy in the container while the walk
// resolved the base scope's. Asserted connected:
// the dispatch payload the orchestrator really produced is handed to the real
// container entry point, with a no-base control on the same fixture.
describe('the composed policy scope reaches the running plan', () => {
  const CUSTOM_META = {
    ...META,
    scope: 'enterprise-custom',
    policyScope: 'enterprise',
    composedGrid: { 'requirements-analysis': 'EXECUTE' },
    aidlcSettings: undefined,
  };

  const containerFixture = () => {
    const stage = {
      id: 'requirements-analysis',
      version: 1,
      phase: 'inception',
      mode: 'inline',
      leadAgent: 'aidlc-product-agent',
      produces: ['requirements-analysis'],
      consumes: [],
      sensors: [],
      humanValidation: 'required',
      bodyRef: { s3Key: 'blocks/bodies/sha256/stage' },
    };
    const library = {
      fromRelease: true,
      stagesById: { 'requirements-analysis': stage },
      agentsById: {
        'aidlc-product-agent': {
          id: 'aidlc-product-agent',
          modelOverride: null,
          bodyRef: { s3Key: 'blocks/bodies/sha256/agent' },
        },
      },
      sensorsById: {},
      rulesById: {},
      artifactsById: { 'requirements-analysis': { id: 'requirements-analysis', terminal: true } },
      knowledgeById: {},
      scopesById: {
        enterprise: {
          id: 'enterprise',
          guardPolicy: 'strict',
          planApproval: 'on',
          collaborators: 'on',
        },
      },
    };
    const workflow = {
      id: 'aidlc-v2',
      version: 1,
      placements: [
        {
          stageId: 'requirements-analysis',
          order: 0,
          scopeMembership: { enterprise: 'EXECUTE' },
        },
      ],
      ruleRefs: [],
      scopeRefs: [{ scopeId: 'enterprise' }],
    };
    const materialized = [];
    const deps = {
      store: {
        putStage: async () => ({}),
        updateExecution: async () => ({}),
        updateStageState: async () => ({}),
        appendEvent: async () => ({}),
        appendOutput: async () => ({ seq: 1, timestamp: 'T' }),
        recordSensorRun: async () => ({}),
        recordMetric: async () => ({ metricId: 'm' }),
        listPendingSteering: async () => [],
        getHumanTask: async () => null,
        getStage: async () => null,
        getExecution: async () => CUSTOM_META,
        getUnitPlan: async () => null,
      },
      loadLibrary: async () => ({ workflow, library }),
      loadBlockBody: async () => '',
      clock: () => 'T',
      availableClis: ['claude'],
      env: { BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
      materializeMcpConfig: async () => '/ws/.aidlc/mcp.json',
      renderRulesDoc: () => '',
      materializeStage: async ({ stage: resolvedStage }) => {
        materialized.push(resolvedStage.policy);
        return { prompt: 'PROMPT', mcpConfigPath: '/ws/.aidlc/mcp.json' };
      },
      spawnFn: () => ({
        on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
        stdin: { end() {} },
      }),
    };
    return { deps, materialized };
  };

  it('carries the base scope on the walk and on every dispatch', async () => {
    const { deps, invokes } = await runStart(CUSTOM_META);

    for (const [args] of deps.loadPlan.mock.calls) {
      expect(args.policyScope).toBe('enterprise');
    }
    const dispatches = invokes.filter((payload) => payload.command === 'run-stage-start');
    expect(dispatches.length).toBeGreaterThan(0);
    for (const payload of dispatches) {
      expect(payload.policyScope).toBe('enterprise');
    }
  });

  it('adds no key for a selection that names its scope directly', async () => {
    const { deps, invokes } = await runStart(META);

    for (const [args] of deps.loadPlan.mock.calls) {
      expect(args).not.toHaveProperty('policyScope');
    }
    for (const payload of invokes.filter((item) => item.command === 'run-stage-start')) {
      expect(payload).not.toHaveProperty('policyScope');
    }
  });

  it('materializes the stage under the base scope the dispatch carried', async () => {
    const { invokes } = await runStart(CUSTOM_META);
    const dispatch = invokes.find((payload) => payload.command === 'run-stage-start');
    expect(dispatch.policyScope).toBe('enterprise');

    const { deps, materialized } = containerFixture();
    const args = {
      projectId: dispatch.projectId,
      intentId: dispatch.intentId,
      executionId: dispatch.executionId,
      workflowId: dispatch.workflowId,
      workflowVersion: dispatch.workflowVersion,
      scope: dispatch.scope,
      stageId: 'requirements-analysis',
      composedGrid: dispatch.composedGrid,
      policyScope: dispatch.policyScope,
      methodologyRelease: dispatch.methodologyRelease,
      workspaceDir: '/ws',
    };

    expect(await runStage(args, deps)).toMatchObject({ ok: true });
    expect(materialized[0]).toMatchObject({
      guardPolicy: 'strict',
      changeControl: 'strict',
      collaborators: 'on',
    });

    // The discriminating control: the same customized dispatch WITHOUT the
    // recorded base scope resolves no scope policy at all, which is the
    // behaviour this commit removes.
    materialized.length = 0;
    await runStage({ ...args, policyScope: null }, deps);
    expect({
      guardPolicy: materialized[0]?.guardPolicy ?? null,
      collaborators: materialized[0]?.collaborators ?? null,
    }).toEqual({ guardPolicy: null, collaborators: null });
  });
});
