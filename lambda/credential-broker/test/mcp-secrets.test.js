import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { Logger } from '@aws-lambda-powertools/logger';
import { authorizeMcpSecretRequest } from '../mcp-secrets.js';
import { handler } from '../index.js';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { signMcpSecretVerificationGrant } from '../../shared/mcp-secret-verification-grant.js';
import { stageInstanceId } from '../../shared/v2-execution-plan.js';

const now = () => Date.parse('2026-10-19T12:00:00Z');
const secret = 'test-mcp-verification-key'.repeat(3);
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const scope = { mode: 'stage', projectId: 'p', intentId: 'i', executionId: 'e', stageId: 's' };
const instanceId = stageInstanceId('workflow@1', 's');
const token = (claims = {}, options = {}) =>
  issueGatewayGrant(
    { ...scope, ...claims },
    {
      keyId: 'trusted',
      sign: async (message) => sign('sha256', message, keys.privateKey),
      now,
      ...options,
    },
  );
const server = (ref) => ({ command: 'npx', ...(ref ? { env: { K: `\${${ref}}` } } : {}) });
const config = { global: { g: server('GK') }, project: { p: server('PK') } };
const env = {
  ENGINE_DATA_ENABLED: 'true',
  AGENT_SETTINGS_SSM_PREFIX: '/app/dev',
  V2_PROCESS_TABLE: 'process',
  AGENT_CREDENTIAL_GRANT_SECRET: secret,
};
const verifyToken = (mcpServersByTier = config, projectId = 'p', options = {}) =>
  signMcpSecretVerificationGrant({ mcpServersByTier, projectId }, secret, { now, ...options });
const request = (mcpServersByTier = config, projectId = 'p') => ({
  action: 'resolve-mcp-secrets',
  projectId,
  mcpServersByTier,
  verificationGrant: verifyToken(mcpServersByTier, projectId),
});
const rewrite = (tokenValue, changes, resign = true) => {
  const [encoded, signature] = tokenValue.split('.');
  const claims = { ...JSON.parse(Buffer.from(encoded, 'base64url')), ...changes };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${resign ? createHmac('sha256', secret).update(payload).digest('base64url') : signature}`;
};
const harness = ({ meta = {}, stage = {}, values = {} } = {}) => {
  const rows = {
    'EXEC#e/META': {
      executionId: 'e',
      projectId: 'p',
      intentId: 'i',
      workflowId: 'workflow',
      workflowVersion: 1,
      mcpServersByTier: config,
      ...meta,
    },
    [`EXEC#e/STAGE#${instanceId}`]: {
      executionId: 'e',
      stageId: 's',
      stageInstanceId: instanceId,
      ...stage,
    },
  };
  const saved = {
    '/app/dev/mcp-secrets/GK': 'global-value',
    '/app/dev/projects/p/mcp-secrets/PK': 'project-value',
    ...values,
  };
  return {
    env,
    now,
    verifyGrant: (grant) =>
      verifyGatewayGrant(grant, {
        now,
        publicKeyFor: async (id) => (id === 'trusted' ? keys.publicKey : null),
      }),
    ddbClient: {
      send: vi.fn(async ({ input }) => ({ Item: rows[`${input.Key.pk}/${input.Key.sk}`] })),
    },
    ssmClient: { send: vi.fn(async ({ input }) => ({ Parameter: { Value: saved[input.Name] } })) },
    rows,
  };
};
const paths = (deps) => deps.ssmClient.send.mock.calls.map(([command]) => command.input.Name);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('MCP broker stage security matrix', () => {
  it.each([{ gatewayGrant: null }, { gatewayGrant: 'tampered-token' }])(
    'rejects invalid stage token before data reads',
    async (authority) => {
      const deps = harness();
      await expect(
        authorizeMcpSecretRequest({ action: 'resolve-mcp-secrets', ...authority }, deps),
      ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_INVALID' });
      expect(deps.ddbClient.send).not.toHaveBeenCalled();
      expect(deps.ssmClient.send).not.toHaveBeenCalled();
    },
  );
  it('uses the signed unit/section selectors for stage membership', async () => {
    const deps = harness();
    const laneId = stageInstanceId('workflow@1', 's', 'auth', 2);
    deps.rows[`EXEC#e/STAGE#${laneId}`] = {
      executionId: 'e',
      stageId: 's',
      stageInstanceId: laneId,
      unitSlug: 'auth',
      sectionIndex: 2,
    };
    expect(
      await authorizeMcpSecretRequest(
        {
          action: 'resolve-mcp-secrets',
          gatewayGrant: await token({ unitSlug: 'auth', sectionIndex: 2 }),
        },
        deps,
      ),
    ).toMatchObject({ ok: true });
    expect(deps.ddbClient.send.mock.calls[1][0].input.Key).toEqual({
      pk: 'EXEC#e',
      sk: `STAGE#${laneId}`,
    });
    deps.ssmClient.send.mockClear();
    await expect(
      authorizeMcpSecretRequest(
        {
          action: 'resolve-mcp-secrets',
          gatewayGrant: await token({ unitSlug: 'auth', sectionIndex: 3 }),
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_SCOPE_MISMATCH' });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it('uses consistent signed META/stage keys and server-derived paths', async () => {
    const deps = harness();
    expect(
      await authorizeMcpSecretRequest(
        { action: 'resolve-mcp-secrets', gatewayGrant: await token() },
        deps,
      ),
    ).toEqual({ ok: true, secretEnv: { GK: 'global-value', PK: 'project-value' } });
    expect(deps.ddbClient.send.mock.calls.map(([command]) => command.input)).toEqual([
      { TableName: 'process', Key: { pk: 'EXEC#e', sk: 'META' }, ConsistentRead: true },
      {
        TableName: 'process',
        Key: { pk: 'EXEC#e', sk: `STAGE#${instanceId}` },
        ConsistentRead: true,
      },
    ]);
    expect(paths(deps)).toEqual(['/app/dev/mcp-secrets/GK', '/app/dev/projects/p/mcp-secrets/PK']);
    expect(
      deps.ssmClient.send.mock.calls.every(([command]) => command.input.WithDecryption === true),
    ).toBe(true);
  });
  it('normalizes legacy customMcpServers and ignores overridden global refs', async () => {
    const legacy = { p: server('PK') };
    const deps = harness({ meta: { mcpServersByTier: null, customMcpServers: legacy } });
    expect(
      await authorizeMcpSecretRequest(
        {
          action: 'resolve-mcp-secrets',
          gatewayGrant: await token(),
          mcpServersByTier: { project: legacy },
        },
        deps,
      ),
    ).toEqual({ ok: true, secretEnv: { PK: 'project-value' } });
    expect(paths(deps)).toEqual(['/app/dev/projects/p/mcp-secrets/PK']);
    const overridden = harness({
      meta: { mcpServersByTier: { global: { p: server('KIRO_API_KEY') }, project: legacy } },
    });
    await authorizeMcpSecretRequest(
      { action: 'resolve-mcp-secrets', gatewayGrant: await token() },
      overridden,
    );
    expect(paths(overridden)).toEqual(['/app/dev/projects/p/mcp-secrets/PK']);
  });
  it.each(['execution', 'conflict', 'discussion'])(
    'denies %s authority before META',
    async (mode) => {
      const deps = harness();
      await expect(
        authorizeMcpSecretRequest(
          { action: 'resolve-mcp-secrets', gatewayGrant: await token({ mode, stageId: null }) },
          deps,
        ),
      ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_SCOPE_MISMATCH' });
      expect(deps.ddbClient.send).not.toHaveBeenCalled();
      expect(deps.ssmClient.send).not.toHaveBeenCalled();
    },
  );
  it.each([
    { executionId: 'other' },
    { projectId: 'other' },
    { intentId: 'other' },
    { stageId: 'other' },
    { stageId: null },
    { unitSlug: 'foreign-unit' },
  ])('denies signed foreign scope %j', async (claims) => {
    const deps = harness();
    await expect(
      authorizeMcpSecretRequest(
        { action: 'resolve-mcp-secrets', gatewayGrant: await token(claims) },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_SCOPE_MISMATCH' });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it.each([
    { meta: { projectId: 'other' } },
    { meta: { intentId: 'other' } },
    { meta: { executionId: 'other' } },
    { stage: { executionId: 'other' } },
    { stage: { stageId: 'other' } },
    { stage: { stageInstanceId: 'other' } },
  ])('denies contradictory persisted ownership %j', async (options) => {
    const deps = harness(options);
    await expect(
      authorizeMcpSecretRequest(
        { action: 'resolve-mcp-secrets', gatewayGrant: await token() },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_SCOPE_MISMATCH' });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it.each(['META', 'stage'])('denies missing %s', async (row) => {
    const deps = harness();
    delete deps.rows[row === 'META' ? 'EXEC#e/META' : `EXEC#e/STAGE#${instanceId}`];
    await expect(
      authorizeMcpSecretRequest(
        { action: 'resolve-mcp-secrets', gatewayGrant: await token() },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_SCOPE_MISMATCH' });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it.each([
    [{ projectId: 'other' }, 'GATEWAY_GRANT_SCOPE_MISMATCH'],
    [{ mcpServersByTier: { global: {}, project: {} } }, 'MCP_SECRET_SCOPE_MISMATCH'],
    [
      { mcpServersByTier: { global: { g: server('FORGED_GLOBAL') }, project: config.project } },
      'MCP_SECRET_SCOPE_MISMATCH',
    ],
    [{ unsavedSecrets: {} }, 'MCP_SECRET_REQUEST_INVALID'],
    [{ unsavedSecrets: { PK: 'override' } }, 'MCP_SECRET_REQUEST_INVALID'],
  ])('denies request overrides %j', async (changes, code) => {
    const deps = harness();
    await expect(
      authorizeMcpSecretRequest(
        { action: 'resolve-mcp-secrets', gatewayGrant: await token(), ...changes },
        deps,
      ),
    ).rejects.toMatchObject({ code });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it.each([
    [{ global: {}, project: { p: server('AWS_SECRET_ACCESS_KEY') } }, 'MCP_SECRET_RESERVED'],
    [{ global: { g: server('SHARED') }, project: { p: server('SHARED') } }, 'MCP_SECRET_COLLISION'],
  ])('rejects policy failures before any secret read', async (mcpServersByTier, code) => {
    const deps = harness({ meta: { mcpServersByTier } });
    await expect(
      authorizeMcpSecretRequest(
        { action: 'resolve-mcp-secrets', gatewayGrant: await token() },
        deps,
      ),
    ).rejects.toMatchObject({ code });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it('never falls back to the global or another project prefix on a missing own-tier value', async () => {
    const deps = harness({
      meta: { mcpServersByTier: { project: { p: server('GK') } } },
      values: { '/app/dev/projects/other/mcp-secrets/GK': 'foreign' },
    });
    await expect(
      authorizeMcpSecretRequest(
        { action: 'resolve-mcp-secrets', gatewayGrant: await token() },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'MCP_SECRET_MISSING' });
    expect(paths(deps)).toEqual(['/app/dev/projects/p/mcp-secrets/GK']);
  });
});

describe('MCP broker verification security matrix', () => {
  it('redeems full-config refs without META or a Gateway grant', async () => {
    const deps = harness();
    expect(
      await authorizeMcpSecretRequest({ ...request(), unsavedSecrets: { PK: 'typed' } }, deps),
    ).toEqual({
      ok: true,
      secretEnv: { GK: 'global-value', PK: 'typed' },
      results: { g: { ok: true }, p: { ok: true } },
    });
    expect(paths(deps)).toEqual(['/app/dev/mcp-secrets/GK']);
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
  });
  it('permits global overrides only for a global verification token', async () => {
    const global = { global: config.global, project: {} };
    const deps = harness();
    const result = await authorizeMcpSecretRequest(
      { ...request(global, null), unsavedSecrets: { GK: 'typed-global' } },
      deps,
    );
    expect(result.secretEnv).toEqual({ GK: 'typed-global' });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it.each([
    [{ projectId: 'other' }, 'MCP_SECRET_SCOPE_MISMATCH'],
    [
      { mcpServersByTier: { global: { g: server('FORGED') }, project: config.project } },
      'MCP_SECRET_SCOPE_MISMATCH',
    ],
    [{ unsavedSecrets: { GK: 'typed-global' } }, 'MCP_SECRET_SCOPE_MISMATCH'],
    [{ unsavedSecrets: { UNUSED: 'typed' } }, 'MCP_SECRET_SCOPE_MISMATCH'],
    [{ unsavedSecrets: { project: { PK: 'typed' } } }, 'MCP_SECRET_SCOPE_MISMATCH'],
    [{ unsavedSecrets: [] }, 'MCP_SECRET_SCOPE_MISMATCH'],
  ])('denies altered request %j', async (changes, code) => {
    const deps = harness();
    await expect(
      authorizeMcpSecretRequest({ ...request(), ...changes }, deps),
    ).rejects.toMatchObject({ code });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
    expect(deps.ddbClient.send).not.toHaveBeenCalled();
  });
  it.each([
    [{ audience: 'aidlc-invocation-accounting' }, 'MCP_VERIFICATION_GRANT_INVALID'],
    [{ purpose: 'capabilities' }, 'MCP_VERIFICATION_GRANT_INVALID'],
    [{ expiresAt: now() / 1000 }, 'MCP_VERIFICATION_GRANT_EXPIRED'],
    [{ configDigest: 'a'.repeat(64) }, 'MCP_SECRET_SCOPE_MISMATCH'],
    [{ allowedRefs: { global: ['FORGED'], project: ['PK'] } }, 'MCP_SECRET_SCOPE_MISMATCH'],
    [{ overrideTier: 'global' }, 'MCP_VERIFICATION_GRANT_INVALID'],
  ])('checks even correctly signed invalid claims %j', async (changes, code) => {
    const deps = harness();
    const original = verifyToken(config, 'p', { now: () => now() - 1000 });
    await expect(
      authorizeMcpSecretRequest(
        { ...request(), verificationGrant: rewrite(original, changes) },
        deps,
      ),
    ).rejects.toMatchObject({ code });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it.each([
    { configDigest: 'b'.repeat(64) },
    { allowedRefs: { global: ['FORGED'], project: ['PK'] } },
    { overrideTier: 'global' },
  ])('rejects unsigned token tampering %j', async (changes) => {
    const deps = harness();
    await expect(
      authorizeMcpSecretRequest(
        { ...request(), verificationGrant: rewrite(verifyToken(), changes, false) },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'MCP_VERIFICATION_GRANT_INVALID' });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it('preserves per-server partial success and returns only safe missing/collision/reserved errors', async () => {
    const partial = {
      global: { g: server('GK'), clashG: server('CLASH'), p: server('DROPPED') },
      project: {
        p: server('PK'),
        clashP: server('CLASH'),
        reserved: server('PATH'),
        missing: server('MISSING'),
        plain: server(),
      },
    };
    const deps = harness();
    const result = await authorizeMcpSecretRequest(request(partial), deps);
    expect(result.secretEnv).toEqual({ GK: 'global-value', PK: 'project-value' });
    expect(result.results).toMatchObject({
      g: { ok: true },
      p: { ok: true },
      plain: { ok: true },
      clashG: { code: 'MCP_SECRET_COLLISION' },
      clashP: { code: 'MCP_SECRET_COLLISION' },
      reserved: { code: 'MCP_SECRET_RESERVED' },
      missing: { code: 'MCP_SECRET_MISSING' },
    });
    expect(paths(deps).toSorted()).toEqual([
      '/app/dev/mcp-secrets/GK',
      '/app/dev/projects/p/mcp-secrets/MISSING',
      '/app/dev/projects/p/mcp-secrets/PK',
    ]);
    expect(
      Object.values(result.results)
        .map((entry) => entry.error)
        .join(' '),
    ).not.toMatch(/global-value|project-value|\/app\/dev|MISSING|CLASH|PATH/);
  });
});

describe('MCP broker request and logging boundary', () => {
  it.each([{}, { gatewayGrant: 'g', verificationGrant: 'v' }])(
    'requires exactly one authority %j',
    async (authority) => {
      const deps = harness();
      await expect(
        authorizeMcpSecretRequest({ action: 'resolve-mcp-secrets', ...authority }, deps),
      ).rejects.toMatchObject({ code: 'MCP_SECRET_AUTHORITY_REQUIRED' });
      expect(deps.ddbClient.send).not.toHaveBeenCalled();
      expect(deps.ssmClient.send).not.toHaveBeenCalled();
    },
  );
  it.each([
    'parameterName',
    'prefix',
    'refs',
    'allowedRefs',
    'tier',
    'overrideTier',
    'executionId',
    '__proto__',
  ])('rejects caller selector %s', async (field) => {
    const deps = harness();
    await expect(
      authorizeMcpSecretRequest({ ...request(), [field]: 'arbitrary' }, deps),
    ).rejects.toMatchObject({ code: 'MCP_SECRET_REQUEST_INVALID' });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it('fails closed when disabled or missing server prefix', async () => {
    const deps = harness();
    await expect(
      authorizeMcpSecretRequest(request(), {
        ...deps,
        env: { ...env, ENGINE_DATA_ENABLED: 'false' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_SECRETS_DISABLED' });
    await expect(
      authorizeMcpSecretRequest(request(), {
        ...deps,
        env: { ...env, AGENT_SETTINGS_SSM_PREFIX: '' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_SECRET_NOT_CONFIGURED' });
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });
  it('handler never logs tokens, unsaved values or upstream secret metadata', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const ssm = mockClient(SSMClient);
    const sentinel = 'private-secret-sentinel';
    try {
      ssm.on(GetParameterCommand).rejects(new Error(`${sentinel} /app/dev/mcp-secrets/GK`));
      const verificationGrant = verifyToken(config, 'p', { now: Date.now });
      const result = await handler({
        ...request(),
        verificationGrant,
        unsavedSecrets: { PK: sentinel },
      });
      expect(result.results.g).toMatchObject({ ok: false, code: 'MCP_SECRET_READ_FAILED' });
      expect(result.secretEnv).toEqual({ PK: sentinel });
      expect(JSON.stringify(result.results)).not.toContain(sentinel);
      expect(await handler({ ...request(), verificationGrant: sentinel })).toEqual({
        ok: false,
        code: 'MCP_VERIFICATION_GRANT_INVALID',
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
      expect(JSON.stringify(log.mock.calls)).not.toContain(verificationGrant);
      expect(JSON.stringify(log.mock.calls)).not.toContain('/app/dev');
    } finally {
      ssm.restore();
    }
  });
});
