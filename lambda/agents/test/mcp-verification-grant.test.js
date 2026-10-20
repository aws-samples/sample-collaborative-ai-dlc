import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand, GetParametersCommand } from '@aws-sdk/client-ssm';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { Logger } from '@aws-lambda-powertools/logger';
import { handler } from '../index.js';
import { verifyMcpSecretVerificationGrant } from '../../shared/mcp-secret-verification-grant.js';
import { mcpSecretConfigAuthority } from '../../shared/mcp-secret-config.js';

const partition = `mcp-grant-${randomUUID()}`;
const secret = 'test-mcp-verification-key'.repeat(3);
const ssm = mockClient(SSMClient);
const runtime = mockClient(BedrockAgentCoreClient);
const globalConfig = { g: { command: 'npx', env: { K: '${GLOBAL_SAVED}' } } };
const editedConfig = { p: { command: 'uvx', env: { K: '${PROJECT_KEY}' } } };
let connection;
beforeAll(async () => {
  connection = new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  const g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(connection)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: partition,
        readPartitions: [partition],
      }),
    );
  await g.addV('Project').property('id', 'p1').next();
  for (const role of ['owner', 'admin', 'viewer']) {
    await g.addV('User').property('id', role).next();
    await g
      .V()
      .has('Project', 'id', 'p1')
      .as('p')
      .V()
      .has('User', 'id', role)
      .as('u')
      .addE('HAS_MEMBER')
      .from_('p')
      .to('u')
      .property('role', role)
      .next();
  }
});
afterAll(async () => {
  await connection?.close();
});
beforeEach(() => {
  vi.stubEnv('GREMLIN_PARTITION', partition);
  vi.stubEnv('ENGINE_DATA_ENABLED', 'true');
  vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/app/dev');
  vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', secret);
  vi.stubEnv('AGENTCORE_RUNTIME_ARN', 'arn:aws:bedrock-agentcore:eu:1:runtime/test');
  ssm.reset();
  runtime.reset();
  ssm.on(GetParametersCommand).resolves({
    Parameters: [{ Name: '/app/dev/custom-mcp-servers', Value: JSON.stringify(globalConfig) }],
  });
  runtime.onAnyCommand().resolves({});
  runtime
    .on(InvokeAgentRuntimeCommand)
    .resolves({ response: { transformToString: async () => JSON.stringify({ results: {} }) } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const event = (input, user = 'owner', platformAdmin = false) => ({
  httpMethod: 'POST',
  path: '/agents/verify-mcp',
  body: JSON.stringify(input),
  requestContext: {
    authorizer: {
      claims: { sub: user, ...(platformAdmin ? { 'cognito:groups': 'platform-admin' } : {}) },
    },
  },
});
const payload = () =>
  JSON.parse(Buffer.from(runtime.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input.payload));

describe('authorized MCP verification issuance', () => {
  it('drops retained drafts for renamed/removed refs and refs outside the editable tier', async () => {
    const result = await handler(
      event({
        projectId: 'p1',
        mcpServers: editedConfig,
        unsavedSecrets: {
          OLD_KEY: 'old-draft',
          GLOBAL_SAVED: 'foreign-draft',
          PROJECT_KEY: 'current-draft',
        },
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(payload().unsavedSecrets).toEqual({ PROJECT_KEY: 'current-draft' });
    expect(
      verifyMcpSecretVerificationGrant(payload().verificationGrant, secret).allowedRefs,
    ).toEqual({
      global: ['GLOBAL_SAVED'],
      project: ['PROJECT_KEY'],
    });
  });
  it.each(['owner', 'admin'])(
    'issues only after project %s authorization, binding saved global config and editable project refs',
    async (role) => {
      const result = await handler(
        event(
          {
            projectId: 'p1',
            mcpServers: editedConfig,
            unsavedSecrets: { PROJECT_KEY: 'typed-private-value' },
            verificationGrant: 'caller-forged-token',
            mcpServersByTier: {
              global: { attacker: { command: 'npx', env: { K: '${FORGED_GLOBAL}' } } },
            },
          },
          role,
        ),
      );
      expect(result.statusCode).toBe(200);
      const sent = payload();
      expect(sent.mcpServersByTier).toEqual({ global: globalConfig, project: editedConfig });
      expect(sent.unsavedSecrets).toEqual({ PROJECT_KEY: 'typed-private-value' });
      const claims = verifyMcpSecretVerificationGrant(sent.verificationGrant, secret);
      expect(claims).toMatchObject({
        projectId: 'p1',
        purpose: 'verify-mcp',
        overrideTier: 'project',
        allowedRefs: { global: ['GLOBAL_SAVED'], project: ['PROJECT_KEY'] },
        configDigest: mcpSecretConfigAuthority(sent.mcpServersByTier).configDigest,
      });
      expect(claims.expiresAt - claims.issuedAt).toBe(300);
      expect(JSON.stringify(claims)).not.toMatch(/typed-private-value|FORGED_GLOBAL/);
      expect(sent).not.toHaveProperty('gatewayGrant');
      expect(JSON.stringify(result)).not.toContain(sent.verificationGrant);
    },
  );
  it('issues a global-only token after platform-admin authorization', async () => {
    expect((await handler(event({ mcpServers: globalConfig }, 'platform', true))).statusCode).toBe(
      200,
    );
    const sent = payload();
    expect(verifyMcpSecretVerificationGrant(sent.verificationGrant, secret)).toMatchObject({
      projectId: null,
      overrideTier: 'global',
      allowedRefs: { global: ['GLOBAL_SAVED'], project: [] },
    });
    expect(ssm.calls()).toHaveLength(0);
  });
  it.each([
    ['viewer', { projectId: 'p1', mcpServers: editedConfig }],
    ['stranger', { projectId: 'p1', mcpServers: editedConfig }],
    ['owner', { mcpServers: globalConfig }],
  ])('does not sign, read secrets, or invoke for unauthorized %s', async (user, input) => {
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', '');
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET_PARAM', '/grant-secret');
    expect((await handler(event(input, user))).statusCode).toBe(403);
    expect(ssm.calls()).toHaveLength(0);
    expect(runtime.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });
  it('authorizes config validation before signing or invoking', async () => {
    expect(
      (await handler(event({ mcpServers: { invalid: {} } }, 'platform', true))).statusCode,
    ).toBe(400);
    expect(ssm.calls()).toHaveLength(0);
    expect(runtime.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });
  it('retains the original payload and requires no signing key when disabled', async () => {
    vi.stubEnv('ENGINE_DATA_ENABLED', 'false');
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', '');
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET_PARAM', '/grant-secret');
    expect((await handler(event({ projectId: 'p1', mcpServers: editedConfig }))).statusCode).toBe(
      200,
    );
    expect(payload()).toEqual({
      command: 'verify-mcp',
      projectId: 'p1',
      mcpServersByTier: { global: globalConfig, project: editedConfig },
    });
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(0);
  });
  it('reuses the existing SSM credential-grant key and does not return or log it', async () => {
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', '');
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET_PARAM', '/grant-secret');
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: secret } });
    const result = await handler(event({ mcpServers: globalConfig }, 'platform', true));
    expect(result.statusCode).toBe(200);
    expect(verifyMcpSecretVerificationGrant(payload().verificationGrant, secret).overrideTier).toBe(
      'global',
    );
    expect(ssm.commandCalls(GetParameterCommand)[0].args[0].input).toEqual({
      Name: '/grant-secret',
      WithDecryption: true,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
  it('fails closed on missing signing configuration without invoking', async () => {
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', '');
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET_PARAM', '');
    expect((await handler(event({ mcpServers: globalConfig }, 'platform', true))).statusCode).toBe(
      502,
    );
    expect(runtime.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });
  it('redacts a failed runtime invocation that includes the token or typed secret', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const sentinel = 'private-token-and-secret-sentinel';
    runtime.on(InvokeAgentRuntimeCommand).rejects(new Error(sentinel));
    const result = await handler(
      event(
        { mcpServers: globalConfig, unsavedSecrets: { GLOBAL_SAVED: sentinel } },
        'platform',
        true,
      ),
    );
    expect(result.statusCode).toBe(502);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify(log.mock.calls)).not.toContain(payload().verificationGrant);
  });
});
