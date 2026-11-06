// Remote-mode closure: with engine-data and the MCP Gateway configured, the
// representative engine commands wired the way the container wires them reach
// AWS data only through Lambda invocations of engine-data, the credential
// broker and the source-control runtime alias. Every direct DynamoDB, S3, SSM
// and API Gateway client, and the Gremlin driver, is a tripwire that fails the
// command and is counted, so a path that still uses the runtime role's data
// permissions cannot pass.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import gremlin from 'gremlin';
import { mockClient } from 'aws-sdk-client-mock';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import { runWithGatewayGrant } from '../mcp/gateway-context.js';
import { broadcastToIntent, invokeSourceControlOperation } from '../clients.js';
import { customRulePinsFor, graphAccessFor, processStoreFor } from '../http-server.js';
import { initWs } from '../commands/init-ws.js';
import { runStage, verifyReviewTargets } from '../commands/run-stage.js';
import { deriveArtifacts } from '../commands/derive-artifacts.js';
import { recordPr } from '../commands/record-pr.js';
import { initLane } from '../commands/lane.js';
import { verifyMcp } from '../commands/verify-mcp.js';
import { resolveStageMcpSecrets } from '../mcp-secret-broker.js';
import { fetchCustomRules } from '../custom-rules.js';
import { renderRulesDoc } from '../stage-materializer.js';
import { createReleaseScriptClosureReader } from '../release-script-closure.js';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { stageInstanceId as planStageInstanceId } from '../../shared/v2-execution-plan.js';
import {
  STAGE_WRITE_METHODS,
  STORE_READ_METHODS,
  createStoreGateway,
} from '../../engine-data/store-gateway.js';
import { GRAPH_OPS } from '../../engine-data/graph-schemas.js';
import { createGraphGateway } from '../../engine-data/graph-gateway.js';

const GRANT = 'stage-grant-token';
const SOURCE_CONTROL_ALIAS =
  'arn:aws:lambda:us-east-1:123456789012:function:source-control:runtime';
const REMOTE_ENV = {
  ENGINE_DATA_FUNCTION: 'engine-data',
  AIDLC_MCP_GATEWAY_URL: 'https://gateway.example',
  CREDENTIAL_BROKER_FUNCTION: 'credential-broker',
  SOURCE_CONTROL_FUNCTION: SOURCE_CONTROL_ALIAS,
  V2_PROCESS_TABLE: 'process-test',
  ARTIFACTS_BUCKET: 'artifacts-test',
  CONNECTIONS_TABLE: 'connections-test',
  WEBSOCKET_ENDPOINT: 'https://ws.example',
};
const IDS = { projectId: 'p-1', intentId: 'i-1', executionId: 'i-1' };

const directMocks = [
  mockClient(DynamoDBClient),
  mockClient(DynamoDBDocumentClient),
  mockClient(S3Client),
  mockClient(SSMClient),
  mockClient(ApiGatewayManagementApiClient),
];
const lambdaMock = mockClient(LambdaClient);
let directGraph;
let invocations;
let workspace;
// When set, store.* and graph.* requests are answered by the real engine-data
// gateways (grant verification and scope binding included).
let engineDataGateway = null;

// engine-data answers for the ops these commands use; everything else is a
// successful no-result call, as for a store write.
const ENGINE_DATA_RESULTS = {
  'graph.getIntentGraph': [],
  'graph.recordPullRequest': { recorded: true },
  'blob.readCustomRules': [{ filename: 'a.md', content: 'Rule A' }],
  'catalog.loadScriptClosure': [{ relativePath: 'aidlc-lib.ts', content: 'export {};' }],
};

const respond = (value) => ({ Payload: Buffer.from(JSON.stringify(value)) });
const serveLambda = () =>
  lambdaMock.on(InvokeCommand).callsFake(async ({ FunctionName, Payload }) => {
    const request = JSON.parse(Buffer.from(Payload).toString('utf8'));
    invocations.push({ FunctionName, request });
    if (FunctionName === 'engine-data' && engineDataGateway?.handles(request.op)) {
      return respond(await engineDataGateway.handle(request));
    }
    if (FunctionName === 'engine-data') {
      const result = Object.hasOwn(ENGINE_DATA_RESULTS, request.op)
        ? ENGINE_DATA_RESULTS[request.op]
        : null;
      return respond({ ok: true, result });
    }
    if (FunctionName === 'credential-broker') {
      if (request.action === 'resolve-mcp-secrets') {
        return respond({
          ok: true,
          secretEnv: { PK: 'project-value' },
          ...(request.verificationGrant ? { results: { p: { ok: true } } } : {}),
        });
      }
      return respond({ ok: true, committer: null });
    }
    if (FunctionName === SOURCE_CONTROL_ALIAS) {
      if (request.operation === 'default-branch') return respond({ ok: true, result: 'trunk' });
      if (request.operation === 'pr-status') {
        return respond({ ok: true, result: { state: 'open', draft: false } });
      }
      return respond({ ok: true, result: { state: 'open', draft: true } });
    }
    throw new Error(`unexpected function ${FunctionName}`);
  });

const directCallCount = () =>
  directMocks.reduce((sum, mock) => sum + mock.calls().length, 0) + directGraph.mock.calls.length;

// The container's wiring (http-server main) in remote mode.
const containerDeps = () => {
  const store = processStoreFor({ env: REMOTE_ENV });
  const { engineData, openGraph, openEngineGraph } = graphAccessFor({
    env: REMOTE_ENV,
    openGraph: async () => {
      throw new Error('the direct opener must never be handed to commands');
    },
  });
  return {
    engineData,
    store,
    openGraph,
    openEngineGraph,
    broadcast: (payload) => broadcastToIntent(payload?.intentId, payload, { env: REMOTE_ENV }),
  };
};

const granted = (fn) => runWithGatewayGrant(GRANT, fn);
const functionsCalled = () => [...new Set(invocations.map((call) => call.FunctionName))].toSorted();
const opsCalled = () =>
  invocations.filter((call) => call.FunctionName === 'engine-data').map((call) => call.request.op);

beforeEach(async () => {
  for (const [key, value] of Object.entries(REMOTE_ENV)) vi.stubEnv(key, value);
  for (const mock of directMocks) {
    mock.reset();
    mock.onAnyCommand().rejects(new Error('direct AWS client tripwire'));
  }
  lambdaMock.reset();
  serveLambda();
  invocations = [];
  directGraph = vi
    .spyOn(gremlin.driver.DriverRemoteConnection.prototype, 'open')
    .mockRejectedValue(new Error('direct Neptune tripwire'));
  workspace = await mkdtemp(path.join(tmpdir(), 'runtime-closure-'));
});

afterEach(async () => {
  engineDataGateway = null;
  vi.unstubAllEnvs();
  directGraph.mockRestore();
  await rm(workspace, { recursive: true, force: true });
});

describe('runtime data closure in remote mode', () => {
  it('selects only remote facades and a direct-graph tripwire', async () => {
    const deps = containerDeps();
    expect(deps.engineData).toBe(true);
    await expect(deps.openGraph()).rejects.toMatchObject({ code: 'ENGINE_DATA_GRAPH_DIRECT' });
    expect(directCallCount()).toBe(0);
  });

  it('init-ws seeds through engine-data and resolves the base branch through the alias', async () => {
    const result = await granted(() =>
      initWs(
        { ...IDS, repos: ['acme/api'], branch: 'aidlc/i-1', gitProvider: 'github', title: 'T' },
        {
          ...containerDeps(),
          workspaceDir: workspace,
          checkoutRepos: async () => [
            { repo: 'acme/api', targetDir: workspace, cloned: true, branchOk: true },
          ],
          remoteBranchExists: async () => ({ exists: false }),
          seedInitialCommit: async ({ baseBranch }) => ({ seeded: true, baseBranch }),
          pushBranch: async () => ({ pushed: true }),
        },
      ),
    );
    expect(result).toMatchObject({ ok: true, repos: ['acme/api'] });
    expect(opsCalled()).toEqual(
      expect.arrayContaining([
        'graph.ensureIntent',
        'store.createExecution',
        'store.appendEvent',
        'realtime.broadcastIntent',
      ]),
    );
    const alias = invocations.find((call) => call.FunctionName === SOURCE_CONTROL_ALIAS);
    expect(alias.request).toEqual({
      action: 'operate',
      gatewayGrant: GRANT,
      executionId: 'i-1',
      projectId: 'p-1',
      provider: 'github',
      repo: 'acme/api',
      operation: 'default-branch',
      args: {},
    });
    expect(
      invocations.find((call) => call.FunctionName === 'credential-broker').request,
    ).toMatchObject({ action: 'source-control', gatewayGrant: GRANT, requiredAccess: 'identity' });
    expect(directCallCount()).toBe(0);
  });

  it('run-stage review recheck, MCP secrets and custom rules use only their services', async () => {
    const rows = await granted(() =>
      verifyReviewTargets({
        targets: [{ repoId: 'acme/api', number: 7 }],
        projectId: 'p-1',
        executionId: 'i-1',
        gitProvider: 'github',
      }),
    );
    expect(rows[0]).toMatchObject({ repoId: 'acme/api' });
    expect(
      invocations
        .filter((call) => call.FunctionName === SOURCE_CONTROL_ALIAS)
        .map(({ request }) => [request.operation, request.args, request.gatewayGrant]),
    ).toEqual([
      ['pr-status', { number: 7 }, GRANT],
      ['set-pr-draft', { number: 7, draft: true }, GRANT],
    ]);
    await expect(
      granted(() =>
        resolveStageMcpSecrets({
          projectId: 'p-1',
          mcpServersByTier: { global: {}, project: { p: { command: 'npx', env: { K: '${PK}' } } } },
        }),
      ),
    ).resolves.toEqual({ secretEnv: { PK: 'project-value' } });
    await expect(
      granted(() =>
        fetchCustomRules({
          customRules: [{ filename: 'a.md', s3Key: 'custom-rules/p-1/a.md' }],
          env: REMOTE_ENV,
        }),
      ),
    ).resolves.toEqual([{ filename: 'a.md', content: 'Rule A' }]);
    expect(functionsCalled()).toEqual(
      ['credential-broker', 'engine-data', SOURCE_CONTROL_ALIAS].toSorted(),
    );
    expect(directCallCount()).toBe(0);
  });

  // run-stage builds this reader with its default catalog read for a pinned
  // intent; a release sensor's sibling imports are release objects.
  it("a release sensor's import closure is read through engine-data", async () => {
    const reader = createReleaseScriptClosureReader({
      methodologyRelease: { releaseId: 'aidlc:1', sourceSha: 'a'.repeat(40), closureDigest: 'b' },
      releaseOwnsSensor: () => true,
    });
    await expect(
      granted(() => reader('type-check', 'import { lib } from "./aidlc-lib.ts";')),
    ).resolves.toEqual([{ relativePath: 'aidlc-lib.ts', content: 'export {};' }]);
    expect(opsCalled()).toEqual(['catalog.loadScriptClosure']);
    expect(directCallCount()).toBe(0);
  });

  it('checkpoint rule pins go through engine-data', async () => {
    const pin = customRulePinsFor({ env: REMOTE_ENV });
    await granted(() => pin({ rules: [{ filename: 'a.md' }] }));
    expect(opsCalled()).toEqual(['blob.pinCustomRuleVersions']);
    expect(directCallCount()).toBe(0);
  });

  it('derive-artifacts and record-pr reach the graph only through engine-data', async () => {
    const deps = containerDeps();
    await expect(
      granted(() => deriveArtifacts({ ...IDS, stageInstanceId: 'si-1' }, deps)),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      granted(() =>
        recordPr({ ...IDS, prs: [{ repo: 'acme/api', url: 'https://x/pr/1', number: 1 }] }, deps),
      ),
    ).resolves.toMatchObject({ ok: true, recorded: [{ recorded: true }] });
    expect(opsCalled()).toEqual(
      expect.arrayContaining([
        'graph.getIntentGraph',
        'graph.recordPullRequest',
        'realtime.broadcastIntent',
      ]),
    );
    expect(directCallCount()).toBe(0);
  });

  it('a unit lane records and broadcasts through engine-data', async () => {
    const { store, broadcast } = containerDeps();
    const result = await granted(() =>
      initLane(
        {
          ...IDS,
          unitSlug: 'auth',
          sectionIndex: 0,
          repos: ['acme/api'],
          unitBranch: 'aidlc/i-1--auth',
          intentBranch: 'aidlc/i-1',
          workspaceDir: workspace,
        },
        {
          store,
          broadcast,
          checkoutRepo: async () => ({ cloned: true }),
          ensureLaneBranch: async () => ({ ready: true, created: true, sha: 'abc' }),
        },
      ),
    );
    expect(result).toMatchObject({ ok: true, unitSlug: 'auth' });
    expect(opsCalled()).toEqual(['store.appendEvent', 'realtime.broadcastIntent']);
    expect(directCallCount()).toBe(0);
  });

  it('verify-mcp resolves secrets through the broker without a Gateway grant', async () => {
    const probeServer = vi.fn(async () => ({ ok: true, tools: ['t'] }));
    const result = await verifyMcp(
      {
        projectId: 'p-1',
        mcpServersByTier: { global: {}, project: { p: { command: 'npx', env: { K: '${PK}' } } } },
        verificationGrant: 'verification-token',
      },
      { probeServer },
    );
    expect(result.results).toMatchObject({ p: { ok: true } });
    expect(invocations).toHaveLength(1);
    expect(invocations[0].FunctionName).toBe('credential-broker');
    expect(invocations[0].request).not.toHaveProperty('gatewayGrant');
    expect(directCallCount()).toBe(0);
  });
});

describe('source-control client with engine-data off', () => {
  it('keeps the legacy unqualified request without grant or execution', async () => {
    vi.stubEnv('ENGINE_DATA_FUNCTION', '');
    vi.stubEnv('SOURCE_CONTROL_FUNCTION', 'source-control');
    lambdaMock.on(InvokeCommand).resolves(respond({ ok: true, result: 'main' }));
    await expect(
      granted(() =>
        invokeSourceControlOperation({
          projectId: 'p-1',
          executionId: 'i-1',
          provider: 'github',
          repo: 'acme/api',
          operation: 'default-branch',
        }),
      ),
    ).resolves.toBe('main');
    const [
      {
        args: [command],
      },
    ] = lambdaMock.commandCalls(InvokeCommand);
    expect(command.input.FunctionName).toBe('source-control');
    expect(JSON.parse(Buffer.from(command.input.Payload))).toEqual({
      action: 'operate',
      projectId: 'p-1',
      provider: 'github',
      repo: 'acme/api',
      operation: 'default-branch',
      args: {},
    });
  });
});

// run-stage under a real signed stage grant, with every process-store and graph
// call answered by the engine-data gateways: none of the calls the stage makes
// may be denied by the stage binding.
describe('run-stage under a stage grant', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const NOW = Date.now();
  const WORKFLOW = { id: 'aidlc-v2', version: 3 };
  const STAGE_ID = 'requirements-analysis';
  const OWN_SI = planStageInstanceId('aidlc-v2@3', STAGE_ID);
  const LEG = { orchestratorRunId: 'run-1', stageCallbackId: 'cb-1' };

  const library = () => ({
    stagesById: {
      [STAGE_ID]: {
        id: STAGE_ID,
        version: 1,
        phase: 'inception',
        mode: 'inline',
        leadAgent: 'aidlc-product-agent',
        produces: [STAGE_ID],
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
    artifactsById: { [STAGE_ID]: { id: STAGE_ID, terminal: true } },
    knowledgeById: {},
  });
  const workflow = () => ({
    ...WORKFLOW,
    placements: [{ stageId: STAGE_ID, order: 0, scopeMembership: { feature: 'EXECUTE' } }],
    ruleRefs: [],
    scopeRefs: [{ scopeId: 'feature' }],
  });

  // An in-memory process store behind the gateway: the scope reads the gateway
  // makes and a plausible answer for each write.
  const backingStore = () => {
    const stages = new Map();
    const meta = {
      ...IDS,
      status: 'RUNNING',
      workflowId: WORKFLOW.id,
      workflowVersion: WORKFLOW.version,
      orchestratorRunId: LEG.orchestratorRunId,
    };
    const upsert = (input) => {
      stages.set(input.stageInstanceId, {
        ...stages.get(input.stageInstanceId),
        executionId: IDS.executionId,
        stageId: STAGE_ID,
        ...input,
      });
      return {};
    };
    const explicit = {
      getExecution: async () => meta,
      getStage: async (_e, id) => stages.get(id) ?? null,
      getHumanTask: async () => null,
      claimStageAttempt: async ({ ownership }) => upsert({ ...ownership, state: 'RUNNING' }),
      putStage: async (input) => upsert(input),
      resumeStageRow: async (input) => upsert(input),
      updateStageState: async (input) => upsert(input),
      appendOutput: async () => ({ seq: 1, timestamp: 'T' }),
      recordMetric: async () => ({ metricId: 'm-1' }),
      recordSensorRun: async () => ({ sensorRunId: 'sr-1' }),
      listReceipts: async () => [],
      listSensorRuns: async () => [],
      listPendingSteering: async () => [],
      listEvents: async () => [],
    };
    // Any other write succeeds with an empty row.
    return new Proxy(explicit, {
      get: (target, name) => target[name] ?? (async () => ({})),
    });
  };

  // A graph that holds the Intent anchor and answers every operation emptily.
  const anchoredGraph = () => {
    const chain = {
      V: () => chain,
      has: () => chain,
      values: () => chain,
      toList: async () => [IDS.projectId],
      hasNext: async () => true,
    };
    return chain;
  };

  const serveEngineData = () => {
    const verifyGrant = (token) =>
      verifyGatewayGrant(token, { publicKeyFor: async () => publicKey });
    const denials = [];
    const audit = (record) => {
      if (record.decision === 'deny') denials.push(record);
    };
    const store = backingStore();
    const storeGateway = createStoreGateway({ verifyGrant, createStore: () => store, audit });
    const graphGateway = createGraphGateway({
      verifyGrant,
      createStore: () => store,
      withGraph: (fn) => fn(anchoredGraph()),
      createOps: () => new Proxy({}, { get: () => async () => [] }),
      audit,
    });
    engineDataGateway = {
      handles: (op) => op.startsWith('store.') || op.startsWith('graph.'),
      handle: (request) =>
        request.op.startsWith('store.') ? storeGateway(request) : graphGateway(request),
    };
    return denials;
  };

  const stageGrant = (scope) =>
    issueGatewayGrant(
      { mode: 'stage', ...IDS, stageId: STAGE_ID, ...scope },
      { keyId: 'kid', sign: async (m) => cryptoSign('sha256', m, privateKey), now: () => NOW },
    );

  const runDeps = () => ({
    ...containerDeps(),
    loadLibrary: async () => ({ workflow: workflow(), library: library() }),
    loadBlockBody: async (b) => (b?.bodyRef?.s3Key ? `body:${b.bodyRef.s3Key}` : ''),
    materializeStage: async ({ stage }) => ({
      prompt: `PROMPT ${stage.stageId}`,
      mcpConfigPath: '/ws/.aidlc/mcp.json',
    }),
    materializeMcpConfig: async () => '/ws/.aidlc/mcp.json',
    materializeKiroAgent: async () => 'aidlc',
    materializeOpenCodeConfig: async () => '{"share":"disabled"}',
    materializeCodexHome: async () => '/ws/.aidlc/codex-home',
    renderRulesDoc,
    mcpEntry: '/opt/agentcore/mcp/index.js',
    availableClis: ['claude'],
    env: { ...REMOTE_ENV, BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' },
    spawnFn: () => ({
      on: (event, callback) => event === 'close' && setImmediate(() => callback(0)),
      stdin: { end() {} },
    }),
    clock: () => 'T',
    commitAndPushAll: async () => ({ ok: true, committed: false, results: [] }),
  });

  const payload = {
    ...IDS,
    stageId: STAGE_ID,
    workflowId: WORKFLOW.id,
    workflowVersion: WORKFLOW.version,
    scope: 'feature',
    workspaceDir: '/ws',
    mcpServersByTier: { global: {}, project: { p: { command: 'npx', env: { K: '${PK}' } } } },
  };

  it.each([
    ['an orchestrated leg', LEG],
    ['a legacy dispatch without a leg', {}],
  ])('makes only calls the binding allows for %s', async (_label, leg) => {
    const denials = serveEngineData();
    const token = await stageGrant(leg);
    const result = await runWithGatewayGrant(token, () =>
      runStage({ ...payload, ...leg }, runDeps()),
    );
    expect(result).toMatchObject({ ok: true, state: 'SUCCEEDED', stageInstanceId: OWN_SI });
    const ops = opsCalled();
    expect(ops).toEqual(
      expect.arrayContaining([
        'store.putStage',
        'store.updateExecution',
        'store.updateStageState',
        'store.appendEvent',
      ]),
    );
    if (leg.orchestratorRunId) expect(ops).toContain('store.claimStageAttempt');
    expect(denials).toEqual([]);
    expect(directCallCount()).toBe(0);
  });

  // The path above does not reach every call site (parks, sensors, loop-backs,
  // ensembles, change control), so the code that runs under a stage grant is
  // also read for every store method and graph operation it names.
  it('names only store methods and graph operations a stage grant may call', async () => {
    const sources = await Promise.all(
      [
        'commands/run-stage.js',
        'ensemble-runner.js',
        'sensor-runner.js',
        'release-script-closure.js',
        'persona-dispatch.js',
        'auth-resolver.js',
        'code-traceability.js',
      ].map((file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8')),
    );
    const source = sources.join('\n');
    const stageStore = new Set([...STORE_READ_METHODS, ...STAGE_WRITE_METHODS]);
    const storeCalls = new Set(
      [...source.matchAll(/\b(?:store|processStore)\s*\??\.\s*([A-Za-z]+)\s*(?:\?\.\s*)?\(/g)].map(
        ([, method]) => method,
      ),
    );
    expect(storeCalls.size).toBeGreaterThan(10);
    // Optional calls (`store.method?.(…)`) are calls too: the checkpoint repair
    // raises its counter that way.
    expect(storeCalls).toContain('raiseStageCounter');
    expect([...storeCalls].filter((method) => !stageStore.has(method))).toEqual([]);
    const graphCalls = Object.keys(GRAPH_OPS).filter((name) =>
      new RegExp(`\\.${name}\\s*(?:\\?\\.\\s*)?\\(`).test(source),
    );
    expect(graphCalls.length).toBeGreaterThan(3);
    expect(graphCalls.filter((name) => !GRAPH_OPS[name].stageGrant)).toEqual([]);
  });

  it('is denied when the grant names another stage', async () => {
    const denials = serveEngineData();
    const token = await stageGrant({ ...LEG, stageId: 'application-design' });
    await runWithGatewayGrant(token, () => runStage({ ...payload, ...LEG }, runDeps())).catch(
      () => null,
    );
    expect(denials.length).toBeGreaterThan(0);
    expect(denials[0]).toMatchObject({ reason: expect.stringMatching(/mismatch/) });
  });
});
