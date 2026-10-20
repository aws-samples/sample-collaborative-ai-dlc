// Remote-mode closure: with engine-data and the MCP Gateway configured, the
// representative engine commands wired the way the container wires them reach
// AWS data only through Lambda invocations of engine-data, the credential
// broker and the source-control runtime alias. Every direct DynamoDB, S3, SSM
// and API Gateway client, and the Gremlin driver, is a tripwire that fails the
// command and is counted, so a path that still uses the runtime role's data
// permissions cannot pass.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { verifyReviewTargets } from '../commands/run-stage.js';
import { deriveArtifacts } from '../commands/derive-artifacts.js';
import { recordPr } from '../commands/record-pr.js';
import { initLane } from '../commands/lane.js';
import { verifyMcp } from '../commands/verify-mcp.js';
import { resolveStageMcpSecrets } from '../mcp-secret-broker.js';
import { fetchCustomRules } from '../custom-rules.js';
import { createReleaseScriptClosureReader } from '../release-script-closure.js';

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
