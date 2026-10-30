import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient } from '@aws-sdk/client-ssm';
import { resolveStageMcpSecrets } from '../mcp-secret-broker.js';
import { resolveMcpSecrets } from '../mcp-secret-resolver.js';
import { verifyMcp } from '../commands/verify-mcp.js';
import { runWithGatewayGrant } from '../mcp/gateway-context.js';
import { authorizeMcpSecretRequest } from '../../credential-broker/mcp-secrets.js';
import { signMcpSecretVerificationGrant } from '../../shared/mcp-secret-verification-grant.js';

const lambda = mockClient(LambdaClient);
const ssm = mockClient(SSMClient);
const server = (ref) => ({ command: 'npx', ...(ref ? { env: { K: `\${${ref}}` } } : {}) });
const config = { global: { g: server('GK') }, project: { p: server('PK') } };
const secret = 'test-mcp-verification-key'.repeat(3);
const response = (value) => ({ Payload: Buffer.from(JSON.stringify(value)) });
beforeEach(() => {
  vi.stubEnv('ENGINE_DATA_FUNCTION', 'engine-data');
  vi.stubEnv('CREDENTIAL_BROKER_FUNCTION', 'credential-broker');
  lambda.reset();
  ssm.reset();
  ssm.onAnyCommand().rejects(new Error('Direct SSM tripwire'));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MCP runtime remote boundary', () => {
  it('attaches the current stage grant on every serialized broker request, including concurrent contexts', async () => {
    lambda
      .on(InvokeCommand)
      .resolves(response({ ok: true, secretEnv: { GK: 'global', PK: 'project' } }));
    const calls = await Promise.all(
      ['grant-a', 'grant-b'].map((grant) =>
        runWithGatewayGrant(grant, () =>
          resolveStageMcpSecrets({ projectId: 'p', mcpServersByTier: config }),
        ),
      ),
    );
    expect(calls).toEqual([
      { secretEnv: { GK: 'global', PK: 'project' } },
      { secretEnv: { GK: 'global', PK: 'project' } },
    ]);
    const requests = lambda.commandCalls(InvokeCommand).map(({ args: [command] }) => {
      expect(command.input.FunctionName).toBe('credential-broker');
      return JSON.parse(Buffer.from(command.input.Payload));
    });
    expect(requests.map((req) => req.gatewayGrant)).toEqual(['grant-a', 'grant-b']);
    expect(requests[0]).toEqual({
      action: 'resolve-mcp-secrets',
      gatewayGrant: 'grant-a',
      projectId: 'p',
      mcpServersByTier: config,
    });
    expect(ssm.calls()).toHaveLength(0);
  });
  it('verifies full-config once through real JSON transport and the broker, retaining partial results without Gateway or runtime SSM', async () => {
    const mcpServersByTier = {
      global: { g: server('GK'), c: server('CLASH') },
      project: {
        p: server('PK'),
        missing: server('MISSING'),
        c2: server('CLASH'),
        reserved: server('PATH'),
      },
    };
    const verificationGrant = signMcpSecretVerificationGrant(
      { projectId: 'p', mcpServersByTier },
      secret,
    );
    const requests = [];
    const savedRead = vi.fn(async ({ input }) => ({
      Parameter: { Value: input.Name === '/app/dev/mcp-secrets/GK' ? 'global-value' : undefined },
    }));
    lambda.on(InvokeCommand).callsFake(async (input) => {
      const req = JSON.parse(Buffer.from(input.Payload));
      requests.push(req);
      return response(
        await authorizeMcpSecretRequest(req, {
          env: {
            ENGINE_DATA_ENABLED: 'true',
            AGENT_SETTINGS_SSM_PREFIX: '/app/dev',
            AGENT_CREDENTIAL_GRANT_SECRET: secret,
          },
          ssmClient: { send: savedRead },
          ddbClient: {
            send: () => {
              throw new Error('No META for verification');
            },
          },
        }),
      );
    });
    const probeServer = vi.fn(async () => ({ ok: true, tools: ['lookup'] }));
    const local = vi.fn(() => {
      throw new Error('local resolver tripwire');
    });
    const result = await verifyMcp(
      {
        projectId: 'p',
        mcpServersByTier,
        verificationGrant,
        unsavedSecrets: { PK: 'typed-value' },
      },
      { probeServer, resolveMcpSecrets: local },
    );
    expect(result.results).toMatchObject({
      g: { ok: true },
      p: { ok: true },
      missing: { code: 'MCP_SECRET_MISSING' },
      c: { code: 'MCP_SECRET_COLLISION' },
      c2: { code: 'MCP_SECRET_COLLISION' },
      reserved: { code: 'MCP_SECRET_RESERVED' },
    });
    expect(probeServer.mock.calls.map(([spec]) => spec.env.K).toSorted()).toEqual([
      'global-value',
      'typed-value',
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('gatewayGrant');
    expect(requests[0].mcpServersByTier).toEqual(mcpServersByTier);
    expect(local).not.toHaveBeenCalled();
    expect(ssm.calls()).toHaveLength(0);
    expect(JSON.stringify(result)).not.toMatch(/global-value|typed-value/);
  });
  it.each([
    { ok: false, code: 'MCP_VERIFICATION_GRANT_INVALID' },
    { ok: true, secretEnv: null },
    { ok: true, secretEnv: { GK: 'value', PK: 'value' }, results: {} },
    { ok: true, secretEnv: { PATH: 'value' }, results: {} },
  ])(
    'fails remote verification closed, without local or per-server fallback: %j',
    async (value) => {
      lambda.on(InvokeCommand).resolves(response(value));
      const local = vi.fn();
      const probeServer = vi.fn();
      expect(
        await verifyMcp(
          { projectId: 'p', mcpServersByTier: config, verificationGrant: 'test-token' },
          { probeServer, resolveMcpSecrets: local },
        ),
      ).toEqual({ error: 'MCP secret broker resolution failed' });
      expect(lambda.calls()).toHaveLength(1);
      expect(local).not.toHaveBeenCalled();
      expect(probeServer).not.toHaveBeenCalled();
      expect(ssm.calls()).toHaveLength(0);
    },
  );
  it('never exposes raw transport errors or falls back after rejection', async () => {
    lambda
      .on(InvokeCommand)
      .rejects(new Error('secret-sentinel /app/dev/mcp-secrets/PK token-body'));
    await expect(
      runWithGatewayGrant('grant', () =>
        resolveStageMcpSecrets({ projectId: 'p', mcpServersByTier: config }),
      ),
    ).rejects.toThrow(/^MCP secret broker resolution failed$/);
    expect(ssm.calls()).toHaveLength(0);
  });
  it('fails closed with a missing broker or missing stage grant', async () => {
    vi.stubEnv('CREDENTIAL_BROKER_FUNCTION', '');
    await expect(
      resolveStageMcpSecrets({ projectId: 'p', mcpServersByTier: config }),
    ).rejects.toThrow('MCP secret broker resolution failed');
    expect(lambda.calls()).toHaveLength(0);
    vi.stubEnv('CREDENTIAL_BROKER_FUNCTION', 'credential-broker');
    lambda.on(InvokeCommand).callsFake((input) => {
      expect(JSON.parse(Buffer.from(input.Payload)).gatewayGrant).toBeNull();
      return response({ ok: false, code: 'GATEWAY_GRANT_INVALID' });
    });
    await expect(
      resolveStageMcpSecrets({ projectId: 'p', mcpServersByTier: config }),
    ).rejects.toThrow('MCP secret broker resolution failed');
    expect(ssm.calls()).toHaveLength(0);
  });
  it('trips direct resolution in enabled mode even with an injected getter', async () => {
    const getParam = vi.fn();
    await expect(resolveMcpSecrets({ getParam })).rejects.toThrow(
      'Direct MCP secret resolution is disabled',
    );
    await expect(resolveMcpSecrets()).rejects.toThrow('Direct MCP secret resolution is disabled');
    expect(getParam).not.toHaveBeenCalled();
    expect(ssm.calls()).toHaveLength(0);
  });
  it('permits no-secret probes without any authority or AWS access', async () => {
    const probeServer = vi.fn(async () => ({ ok: true, tools: [] }));
    expect(await verifyMcp({ mcpServers: { plain: server() } }, { probeServer })).toEqual({
      results: { plain: { ok: true, tools: [] } },
    });
    expect(probeServer).toHaveBeenCalledTimes(1);
    expect(lambda.calls()).toHaveLength(0);
    expect(ssm.calls()).toHaveLength(0);
  });
  it.each(['returned', 'thrown'])(
    'redacts %s probe errors that echo resolved values',
    async (kind) => {
      lambda.on(InvokeCommand).resolves(
        response({
          ok: true,
          secretEnv: { GK: 'private-secret', PK: 'private-secret' },
          results: { g: { ok: true }, p: { ok: true } },
        }),
      );
      const probeServer = async () => {
        if (kind === 'thrown') throw new Error('private-secret');
        return { ok: false, error: 'private-secret' };
      };
      const result = await verifyMcp(
        { projectId: 'p', mcpServersByTier: config, verificationGrant: 'test-token' },
        { probeServer },
      );
      expect(result.results.g).toEqual({ ok: false, error: 'MCP server probe failed' });
      expect(JSON.stringify(result)).not.toContain('private-secret');
    },
  );
});
