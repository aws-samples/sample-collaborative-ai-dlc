import { describe, expect, it, vi } from 'vitest';
import {
  normalizeConnection,
  normalizeCredentialBinding,
  connectionAudience,
  assertMatchingConnection,
  assertRuntimeSupportsBinding,
  AGENT_AUTH_MODES_CATALOG,
  withoutTrailingSlashes,
} from '../agent-auth-catalog.js';
import {
  selectConnection,
  executionCredentialBinding,
  prepareAgentInvocation,
} from '../agent-credential-service.js';
import { authorizeConnectionChange, validateOAuthCredential } from '../agent-oauth-contract.js';
import {
  issueAgentCredentialGrant,
  verifyIssuedAgentCredentialGrant,
  loadAgentCredentialGrantSecret,
  signAgentCredentialGrant,
  verifyAgentCredentialGrant,
} from '../agent-credential-grants.js';
import { connectionBinding } from '../agent-binding-selection.js';

const gateway = (overrides = {}) =>
  normalizeConnection({
    id: 'gateway-1',
    revision: 1,
    mode: 'litellm',
    backend: 'litellm',
    mechanism: 'api-key',
    source: 'platform',
    configuration: { endpoint: 'https://gateway.example/v1' },
    ...overrides,
  });
const oauth = (mechanism = 'oauth-user') =>
  gateway({
    mechanism,
    source: 'space',
    projectId: 'p1',
    configuration: {
      endpoint: 'https://gateway.example/v1',
      issuer: 'https://identity.example',
      clientId: 'aidlc',
      audience: 'inference',
      scopes: ['model.invoke'],
    },
  });

describe('authentication contracts and scope selection', () => {
  it('normalizes trailing path separators without backtracking over internal separators', () => {
    const path = `/base/${'/'.repeat(100_000)}suffix///`;
    expect(withoutTrailingSlashes(path)).toBe(path.slice(0, -3));
    expect(withoutTrailingSlashes('/'.repeat(100_000))).toBe('');
    expect(withoutTrailingSlashes('')).toBe('');
  });
  it('keeps future modes unavailable and interprets every legacy Bedrock binding as a key', () => {
    expect(
      AGENT_AUTH_MODES_CATALOG.filter((mode) => mode.available).map((mode) => mode.id),
    ).toEqual(['keys']);
    expect(normalizeCredentialBinding({ provider: 'bedrock', source: 'space' })).toEqual({
      provider: 'bedrock',
      source: 'space',
    });
    expect(executionCredentialBinding({ agentCli: 'claude', projectId: 'p1' })).toEqual({
      provider: 'bedrock',
      source: 'platform',
    });
    expect(() => executionCredentialBinding({ agentCli: 'claude', projectId: 'p2' }, 'p1')).toThrow(
      'does not belong',
    );
  });
  it('limits personal overrides to keys bound to the effective gateway', () => {
    const platform = gateway();
    const personal = gateway({ id: 'personal', source: 'user', userId: 'u1' });
    expect(
      selectConnection({
        policy: { mode: 'litellm' },
        platform,
        personal,
        userId: 'u1',
        cli: 'codex',
      }),
    ).toEqual(personal);
    expect(() =>
      selectConnection({
        policy: { mode: 'litellm' },
        platform,
        personal,
        userId: 'u2',
        cli: 'codex',
      }),
    ).toThrow('caller API key');
    const other = gateway({
      id: 'space',
      source: 'space',
      projectId: 'p1',
      configuration: { endpoint: 'https://other.example/v1' },
    });
    expect(() =>
      selectConnection({
        policy: { mode: 'litellm' },
        platform,
        space: other,
        personal,
        projectId: 'p1',
        userId: 'u1',
        cli: 'claude',
      }),
    ).toThrow('effective gateway');
    expect(() => selectConnection({ policy: { mode: 'keys' }, platform, cli: 'claude' })).toThrow(
      'platform authentication mode',
    );
  });
  it('fails closed on a revoked selected connection and excludes personal IAM and OAuth', () => {
    expect(() =>
      selectConnection({
        policy: { mode: 'litellm' },
        platform: gateway({ state: 'revoked' }),
        cli: 'claude',
      }),
    ).toThrow('repair');
    expect(() => gateway({ mechanism: 'oauth-machine', source: 'user', userId: 'u1' })).toThrow(
      'scope',
    );
    const role = normalizeConnection({
      id: 'role',
      revision: 1,
      mode: 'iam',
      backend: 'bedrock',
      mechanism: 'assume-role',
      source: 'platform',
      configuration: { roleArn: 'arn:aws:iam::123456789012:role/inference', region: 'eu-west-1' },
    });
    expect(
      selectConnection({
        policy: { mode: 'iam' },
        platform: role,
        personal: gateway(),
        cli: 'claude',
      }),
    ).toEqual(role);
    expect(() => normalizeConnection({ ...role, source: 'user', userId: 'u1' })).toThrow('scope');
  });
  it('validates complete endpoint/IdP configuration and does not mix identities', () => {
    for (const endpoint of [
      'http://gateway.example',
      'https://user:pass@gateway.example',
      'https://gateway.example?token=x',
      'https://gateway.example/#x',
    ]) {
      expect(() => gateway({ configuration: { endpoint } })).toThrow();
    }
    expect(() => oauth('oauth-machine')).not.toThrow();
    expect(() =>
      gateway({
        mechanism: 'oauth-machine',
        configuration: { endpoint: 'https://gateway.example/v1' },
      }),
    ).toThrow('issuer');
    expect(() =>
      gateway({ configuration: { endpoint: 'https://gateway.example', accessToken: 'secret' } }),
    ).toThrow('unsupported fields');
    expect(() => assertMatchingConnection(oauth(), oauth('oauth-machine'))).not.toThrow();
    expect(connectionAudience(oauth())).toContain('inference');
  });
  it('requires administrator authority and informed sharing for OAuth user sign-in', () => {
    const connection = oauth();
    expect(() =>
      authorizeConnectionChange({
        actor: { adminProjectIds: ['p2'] },
        connection,
        sharedConsent: true,
      }),
    ).toThrow('administrator');
    expect(() =>
      authorizeConnectionChange({ actor: { adminProjectIds: ['p1'] }, connection }),
    ).toThrow('shared space connection');
    expect(
      authorizeConnectionChange({
        actor: { adminProjectIds: ['p1'] },
        connection,
        sharedConsent: true,
      }),
    ).toEqual(connection);
    const credential = {
      grantType: 'authorization_code',
      issuer: 'https://identity.example',
      audience: 'inference',
      clientId: 'aidlc',
      subject: 'shared-owner',
      accessToken: 'fake-access',
      expiresAt: 2000,
    };
    expect(validateOAuthCredential({ connection, credential, now: 1000 }).subject).toBe(
      'shared-owner',
    );
    for (const change of [
      { expiresAt: 999 },
      { subject: 'replacement' },
      { audience: 'other' },
      { grantType: 'client_credentials' },
    ]) {
      expect(() =>
        validateOAuthCredential({
          connection,
          credential: { ...credential, ...change },
          expectedSubject: 'shared-owner',
          now: 1000,
        }),
      ).toThrow('does not match');
    }
  });
  it('checks runtime compatibility for new bindings while retaining legacy support', () => {
    const binding = connectionBinding(gateway(), 4);
    expect(() => assertRuntimeSupportsBinding(binding, {})).toThrow('Publish an environment');
    expect(() =>
      assertRuntimeSupportsBinding(binding, { agentAuthProtocol: 2, agentAuthModes: ['keys'] }),
    ).toThrow();
    expect(() =>
      assertRuntimeSupportsBinding(binding, { agentAuthProtocol: 2, agentAuthModes: ['litellm'] }),
    ).not.toThrow();
    expect(() =>
      assertRuntimeSupportsBinding({ provider: 'bedrock', source: 'platform' }, {}),
    ).not.toThrow();
  });
  it.each(['execution', 'compose', 'discussion', 'capabilities'])(
    'uses common grant preparation for %s',
    async (purpose) => {
      const issueGrant = vi.fn(async () => 'signed-grant');
      const credentialBinding = { provider: 'bedrock', source: 'space' };
      const prepared = await prepareAgentInvocation(
        { purpose, projectId: 'p1', executionId: 'e1', credentialBinding },
        { issueGrant },
      );
      expect(prepared.agentCredentialGrant).toBe('signed-grant');
      expect(issueGrant).toHaveBeenCalledWith({
        purpose,
        projectId: 'p1',
        executionId: 'e1',
        bindings: [credentialBinding],
      });
    },
  );
});

describe('grant wrappers and secret cache', () => {
  const secret = 'g'.repeat(48);
  const claims = {
    purpose: 'execution',
    projectId: 'p1',
    executionId: 'e1',
    bindings: [{ provider: 'bedrock', source: 'space' }],
  };
  it('coalesces secret reads per client/path and expires the cache', async () => {
    const ssm = { send: vi.fn(async () => ({ Parameter: { Value: secret } })) };
    const env = { AGENT_CREDENTIAL_GRANT_SECRET_PARAM: '/grant-secret' };
    await Promise.all(
      [1, 2, 3].map(() => loadAgentCredentialGrantSecret(ssm, { env, now: () => 1000 })),
    );
    expect(ssm.send).toHaveBeenCalledTimes(1);
    expect(ssm.send.mock.calls[0][0].input).toEqual({
      Name: '/grant-secret',
      WithDecryption: true,
    });
    await loadAgentCredentialGrantSecret(ssm, { env, now: () => 301001 });
    expect(ssm.send).toHaveBeenCalledTimes(2);
    const other = { send: vi.fn(async () => ({ Parameter: { Value: secret } })) };
    await loadAgentCredentialGrantSecret(other, { env });
    expect(other.send).toHaveBeenCalledOnce();
  });
  it('does not cache missing or invalid secret values', async () => {
    const ssm = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ Parameter: { Value: 'short' } })
        .mockResolvedValueOnce({ Parameter: { Value: secret } }),
    };
    const options = { env: { AGENT_CREDENTIAL_GRANT_SECRET_PARAM: '/retry-secret' } };
    await expect(loadAgentCredentialGrantSecret(ssm, options)).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED',
    });
    await expect(loadAgentCredentialGrantSecret(ssm, options)).resolves.toBe(secret);
  });
  it('round-trips asynchronous issuance and verification without reading a secret when explicitly supplied', async () => {
    const ssm = { send: vi.fn() };
    const token = await issueAgentCredentialGrant(ssm, claims, { secret, now: () => 1000000 });
    expect(
      await verifyIssuedAgentCredentialGrant(ssm, token, { secret, now: () => 1000001 }),
    ).toMatchObject(claims);
    expect(ssm.send).not.toHaveBeenCalled();
    await expect(
      verifyIssuedAgentCredentialGrant(ssm, token, { secret, now: () => 1400000 }),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_EXPIRED' });
  });
  it('rejects malformed and cross-space bindings and signs versioned references without secrets', () => {
    for (const binding of [null, [], {}, 'invalid'])
      expect(() => signAgentCredentialGrant({ ...claims, bindings: [binding] }, secret)).toThrow(
        'binding',
      );
    const binding = connectionBinding(oauth(), 3);
    const token = signAgentCredentialGrant({ ...claims, bindings: [binding] }, secret);
    expect(verifyAgentCredentialGrant(token, secret)).toMatchObject({
      version: 2,
      bindings: [binding],
    });
    expect(() =>
      signAgentCredentialGrant({ ...claims, projectId: 'p2', bindings: [binding] }, secret),
    ).toThrow('different space');
    expect(Buffer.from(token.split('.')[0], 'base64url').toString()).not.toContain('accessToken');
  });
});
