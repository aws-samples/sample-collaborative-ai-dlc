import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from '@aws/durable-execution-sdk-js-testing';
import { __durableHandler } from './fixtures/completion-handler.js';

// runtime_mcp_credentials = gateway_only on the REAL durable runner: a pinned
// (or legacy inline) config with direct MCP servers fails the stage inside the
// existing dispatch step, never reaches the runtime, and the operation names a
// run records are unchanged (replay compatibility for in-flight executions).

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});
afterEach(() => vi.unstubAllEnvs());

const SENTINEL = 'sentinel-pinned-mcp-secret-4d7e';
const META = {
  executionId: 'i1',
  intentId: 'i1',
  projectId: 'p1',
  status: 'CREATED',
  workflowId: 'aidlc-v2',
  workflowVersion: 1,
  scope: 'feature',
  startedAt: 'T',
  startedBy: 'u1',
  repos: ['owner/repo'],
  branch: 'aidlc/i1',
  baseBranch: 'main',
  gitProvider: 'github',
  agentCli: 'kiro',
  parkReleaseSeconds: null,
};

const makeWorld = (meta) => {
  const world = { invokes: [], statusWrites: [], retirements: [] };
  world.deps = {
    store: {
      getExecution: async () => ({ ...META, ...meta }),
      updateExecution: async (input) => {
        if (input.status) world.statusWrites.push(input.status);
        return { orchestratorRunId: input.orchestratorRunId ?? null };
      },
      addPendingGrantRetirements: async ({ grantIds }) => grantIds,
      clearPendingGrantRetirements: async ({ grantIds }) => grantIds,
      failStageAttemptForGrantRetirement: async () => ({ state: 'FAILED' }),
      listUnits: async () => [],
      setGateCallbackId: async () => ({}),
      getHumanTask: async () => ({ status: 'answered' }),
      appendEvent: async () => ({}),
      failRunningStageAttempt: async () => null,
    },
    loadPlan: async () => ({ valid: true, plan: { stages: [{ stageId: 'a' }] } }),
    invokeRuntime: async (payload) => {
      // A current container refuses the side-effect-free probe.
      if (payload.command === 'init-ws-start' && !payload.callbackId) {
        return { ok: false, reason: 'missing_callback_id' };
      }
      world.invokes.push(payload);
      if (payload.command === 'run-stage-start' || payload.command === 'init-ws-start') {
        return { ok: true, accepted: true };
      }
      return { ok: true };
    },
    issueGatewayGrant: async (scope, options) => `gw:${scope.mode}:${options?.randomId?.() ?? 'x'}`,
    retireGatewayGrant: async (retirement) => {
      world.retirements.push(retirement);
      return { retired: true, alreadyRetired: false };
    },
    retireGatewayExecution: async () => ({ retired: true, alreadyRetired: false }),
    awaitGrantIssuance: async () => ({ retiredAt: null, waitedMs: 0, bounded: false }),
    stopSession: async () => ({ stopped: true }),
    broadcast: async () => {},
    applicationUrl: 'https://aidlc.example.test/',
  };
  return world;
};

const run = async (world, { completeStage = false } = {}) => {
  const handler = withDurableExecution((event, ctx) => __durableHandler(event, ctx, world.deps));
  const runner = new LocalDurableTestRunner({ handlerFunction: handler });
  const completion = runner.run({
    payload: { action: 'start', intentId: 'i1', executionId: 'i1' },
  });
  const init = await runner.getOperation('init-ws-cb').waitForData(WaitingOperationStatus.STARTED);
  await init.sendCallbackSuccess(JSON.stringify({ ok: true }));
  if (completeStage) {
    const op = await runner.getOperation('stage-cb-a').waitForData(WaitingOperationStatus.STARTED);
    await op.sendCallbackSuccess(JSON.stringify({ ok: true, state: 'SUCCEEDED' }));
  }
  const execution = await completion;
  return {
    result: execution.getResult(),
    names: execution.getOperations().map((op) => op.getOperationData()?.Name),
  };
};

const remoteWithSecret = {
  wiki: { type: 'http', url: 'https://wiki.example/mcp', headers: { Authorization: SENTINEL } },
};

describe('runtime_mcp_credentials = gateway_only — orchestrator dispatch', () => {
  it.each([
    ['a pinned two-tier config', { mcpServersByTier: { global: {}, project: remoteWithSecret } }],
    ['a legacy inline config', { mcpServersByTier: undefined, customMcpServers: remoteWithSecret }],
    [
      'a global stdio server',
      { mcpServersByTier: { global: { tool: { command: 'npx' } }, project: {} } },
    ],
  ])('fails the stage on %s without dispatching it', async (_label, meta) => {
    vi.stubEnv('RUNTIME_MCP_CREDENTIALS', 'gateway_only');
    const world = makeWorld(meta);
    const { result, names } = await run(world);

    expect(result).toMatchObject({ ok: false, reason: 'stage_failed' });
    expect(JSON.stringify(result)).toContain('runtime_mcp_gateway_only');
    expect(world.invokes.map((p) => p.command)).not.toContain('run-stage-start');
    expect(JSON.stringify(world.invokes)).not.toContain(SENTINEL);
    expect(world.statusWrites).toContain('FAILED');
    // The refusal settles like any dispatch refusal: the attempt's jti is retired.
    expect(world.retirements.filter((r) => r.stageId)).toEqual([
      expect.objectContaining({ stageId: 'a', outcome: 'FAILED' }),
    ]);
    expect(names).toContain('run-a');
  });

  it('records the same operation names as the default profile when no server is pinned', async () => {
    const allow = await run(makeWorld({ mcpServersByTier: null }), { completeStage: true });
    vi.stubEnv('RUNTIME_MCP_CREDENTIALS', 'gateway_only');
    const strict = await run(makeWorld({ mcpServersByTier: { global: {}, project: {} } }), {
      completeStage: true,
    });
    expect(allow.result).toEqual({ ok: true, intentId: 'i1', stages: 1 });
    expect(strict.result).toEqual(allow.result);
    expect(strict.names).toEqual(allow.names);
  });

  it('keeps dispatching direct servers under the default profile', async () => {
    const world = makeWorld({ mcpServersByTier: { global: {}, project: remoteWithSecret } });
    const { result } = await run(world, { completeStage: true });
    expect(result).toEqual({ ok: true, intentId: 'i1', stages: 1 });
    const [dispatch] = world.invokes.filter((p) => p.command === 'run-stage-start');
    expect(dispatch.mcpServersByTier).toEqual({ global: {}, project: remoteWithSecret });
  });
});
