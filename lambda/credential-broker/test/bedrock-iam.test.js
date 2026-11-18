import { describe, expect, it, vi } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { authorizeAgentCredentialRequest } from '../index.js';
import { BEDROCK_IAM_RENEWAL } from '../bedrock-iam-provider.js';
import { INFERENCE_SESSION_POLICY } from '../bedrock-iam.js';
import { normalizeConnection } from '../../shared/agent-auth-catalog.js';
import { connectionBinding } from '../../shared/agent-binding-selection.js';
import { legacyConnection } from '../../shared/agent-connection-repository.js';
import { loggableAgentCredentialErrorCode } from '../agent-provider-registry.js';
import {
  signAgentCredentialGrant,
  verifyAgentCredentialGrant,
} from '../../shared/agent-credential-grants.js';
import { signRenewal, verifyRenewal } from '../agent-credential-renewal.js';
const SECRET = 'fixture-signing-secret-'.repeat(3);
const START = Date.parse('2026-09-24T10:00:00Z');
const HOUR = 3600_000;
const connection = normalizeConnection({
  id: 'iam-1',
  revision: 1,
  mode: 'iam',
  backend: 'bedrock',
  mechanism: 'assume-role',
  source: 'space',
  projectId: 'p',
  configuration: {
    roleArn: 'arn:aws:iam::222222222222:role/Inference',
    region: 'eu-west-1',
    externalId: 'external-fixture',
  },
});
const binding = connectionBinding(connection, 3);
const fixture = (purpose = 'execution') => {
  let time = START;
  let state = 'ready';
  const ddbClient = {
    send: vi.fn(async (command) => {
      expect(command).toBeInstanceOf(GetCommand);
      if (command.input.Key.pk === 'AGENTAUTH#POLICY')
        return {
          Item: { mode: 'keys', revision: 4, defaultConnectionId: 'legacy-platform-bedrock' },
        };
      if (command.input.Key.pk === 'EXEC#e')
        return { Item: { projectId: 'p', credentialBinding: binding, status: 'RUNNING' } };
      if (command.input.Key.pk === `AGENTAUTH#CONNECTION#${connection.id}`)
        return {
          Item: { ...connection, state: command.input.Key.sk === 'META' ? state : 'ready' },
        };
      return {};
    }),
  };
  const stsClient = {
    send: vi.fn(async () => ({
      Credentials: {
        AccessKeyId: 'TARGET',
        SecretAccessKey: 'inert-secret',
        SessionToken: 'inert-session',
        Expiration: new Date(time + HOUR),
      },
    })),
  };
  const claims = {
    purpose,
    projectId: 'p',
    executionId: purpose === 'execution' ? 'e' : null,
    bindings: [binding],
  };
  const grant = signAgentCredentialGrant(claims, SECRET, { now: () => START });
  return {
    grant,
    stsClient,
    ddbClient,
    deps: {
      ddbClient,
      stsClient,
      secret: SECRET,
      env: { V2_PROCESS_TABLE: 'test', AGENT_SETTINGS_SSM_PREFIX: '/test' },
      now: () => time,
    },
    advance: (ms) => {
      time += ms;
    },
    revoke: () => {
      state = 'revoked';
    },
  };
};
describe('versioned IAM broker authorization', () => {
  it('assumes only the pinned role with ExternalId and an inference-only session policy', async () => {
    const f = fixture();
    const result = await authorizeAgentCredentialRequest(
      { grant: f.grant, roleArn: 'attacker' },
      f.deps,
    );
    const [command] = f.stsClient.send.mock.calls[0];
    expect(command).toBeInstanceOf(AssumeRoleCommand);
    expect(command.input).toMatchObject({
      RoleArn: connection.configuration.roleArn,
      ExternalId: 'external-fixture',
      DurationSeconds: 3600,
      Policy: INFERENCE_SESSION_POLICY,
    });
    const policy = JSON.parse(command.input.Policy);
    expect(policy.Statement[0]).toEqual({
      Effect: 'Deny',
      Action: 'sts:AssumeRole',
      Resource: '*',
    });
    expect(policy.Statement[1].Action).toContain('bedrock-mantle:CreateInference');
    expect(policy.Statement[1].Action.every((action) => action.startsWith('bedrock'))).toBe(true);
    expect(result.credentials[0].binding).toEqual(binding);
    const claims = verifyAgentCredentialGrant(f.grant, SECRET, { now: () => START });
    expect(command.input.RoleSessionName).toBe(
      `collaborative-${claims.grantId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}`,
    );
    expect(result.credentials[0].iamCredentials).toEqual({
      AccessKeyId: 'TARGET',
      SecretAccessKey: 'inert-secret',
      Token: 'inert-session',
      Expiration: new Date(START + HOUR).toISOString(),
    });
  });
  it('accepts neutral and legacy renewal requests with identical host-owned leases', async () => {
    const f = fixture();
    const original = (await authorizeAgentCredentialRequest({ grant: f.grant }, f.deps))
      .credentials[0];
    expect(original.lease.renewal).toEqual({
      action: BEDROCK_IAM_RENEWAL.action,
      grant: original.renewalToken,
    });
    f.advance(HOUR);
    const neutral = await authorizeAgentCredentialRequest(
      { action: BEDROCK_IAM_RENEWAL.action, grant: original.renewalToken },
      f.deps,
    );
    const legacy = await authorizeAgentCredentialRequest(
      { action: BEDROCK_IAM_RENEWAL.action, renewalToken: original.renewalToken },
      f.deps,
    );
    expect(neutral).toEqual(legacy);
    expect(neutral.credentials[0].lease.authorizationExpiresAt).toBe(START + 8 * HOUR);
    await expect(
      authorizeAgentCredentialRequest(
        {
          action: BEDROCK_IAM_RENEWAL.action,
          grant: original.renewalToken,
          renewalToken: f.grant,
        },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
    expect(f.stsClient.send).toHaveBeenCalledTimes(3);
  });
  it('keeps Kiro discovery available when the IAM adapter is denied', async () => {
    const f = fixture('capabilities');
    const kiro = connectionBinding(legacyConnection('legacy-space-kiro-p'), 3);
    const grant = signAgentCredentialGrant(
      { purpose: 'capabilities', projectId: 'p', bindings: [binding, kiro] },
      SECRET,
      { now: () => START },
    );
    f.stsClient.send.mockRejectedValue(
      Object.assign(new Error('private IAM diagnostic'), { name: 'AccessDeniedException' }),
    );
    const result = await authorizeAgentCredentialRequest(
      { grant },
      {
        ...f.deps,
        ssmClient: { send: vi.fn(async () => ({ Parameter: { Value: 'kiro-key' } })) },
      },
    );
    expect(result.credentials[0]).toEqual({ binding, error: 'BEDROCK_IAM_ACCESS_DENIED' });
    expect(result.credentials[1]).toMatchObject({ binding: kiro, value: 'kiro-key' });
    expect(result.credentials[1]).not.toHaveProperty('iamCredentials');
    expect(result.credentials[1]).not.toHaveProperty('renewalToken');
    expect(JSON.stringify(result)).not.toContain('private IAM diagnostic');
  });
  it.each(['grant secret', 'key'])(
    'keeps %s SSM denial retryable and outside IAM classification',
    async (source) => {
      const f = fixture('capabilities');
      const denied = Object.assign(new Error('private SSM diagnostic'), {
        name: 'AccessDeniedException',
      });
      const key = connectionBinding(legacyConnection('legacy-platform-bedrock'), 3);
      const grant =
        source === 'key'
          ? signAgentCredentialGrant(
              { purpose: 'capabilities', projectId: 'p', bindings: [key] },
              SECRET,
              { now: () => START },
            )
          : f.grant;
      const failure = await authorizeAgentCredentialRequest(
        { grant },
        {
          ...f.deps,
          ...(source === 'grant secret'
            ? {
                secret: null,
                env: {
                  ...f.deps.env,
                  AGENT_CREDENTIAL_GRANT_SECRET_PARAM: '/test/grant-secret',
                },
              }
            : {}),
          ssmClient: {
            send: vi.fn(async () => {
              throw denied;
            }),
          },
        },
      ).catch((error) => error);
      expect(failure).toBe(denied);
      expect(loggableAgentCredentialErrorCode(failure)).toBe('AGENT_CREDENTIAL_BROKER_FAILED');
      expect(f.stsClient.send).not.toHaveBeenCalled();
    },
  );
  it('renews after handoff expiry with the same binding and a non-sliding eight-hour deadline', async () => {
    const f = fixture();
    const original = (await authorizeAgentCredentialRequest({ grant: f.grant }, f.deps))
      .credentials[0];
    f.advance(3 * HOUR);
    await expect(authorizeAgentCredentialRequest({ grant: f.grant }, f.deps)).rejects.toMatchObject(
      { code: 'AGENT_CREDENTIAL_GRANT_EXPIRED' },
    );
    const renewed = (
      await authorizeAgentCredentialRequest(
        {
          action: BEDROCK_IAM_RENEWAL.action,
          renewalToken: original.renewalToken,
          roleArn: 'attacker',
        },
        f.deps,
      )
    ).credentials[0];
    expect(renewed.renewalToken).toBe(original.renewalToken);
    expect(renewed.renewalExpiresAt).toBe(START + 8 * HOUR);
    expect(renewed.iamCredentials.Expiration).toBe(new Date(START + 4 * HOUR).toISOString());
    expect(renewed.binding).toEqual(binding);
    f.advance(5 * HOUR);
    await expect(
      authorizeAgentCredentialRequest(
        { action: BEDROCK_IAM_RENEWAL.action, renewalToken: renewed.renewalToken },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_EXPIRED' });
    expect(f.stsClient.send).toHaveBeenCalledTimes(2);
  });
  it('never requests an STS session past the signed renewal deadline', async () => {
    const f = fixture();
    const original = (await authorizeAgentCredentialRequest({ grant: f.grant }, f.deps))
      .credentials[0];
    expect(f.stsClient.send.mock.calls[0][0].input.DurationSeconds).toBe(3600);
    const renew = () =>
      authorizeAgentCredentialRequest(
        { action: BEDROCK_IAM_RENEWAL.action, grant: original.renewalToken },
        f.deps,
      );
    f.advance(7 * HOUR + 1800_000 + 500);
    await renew();
    expect(f.stsClient.send.mock.calls[1][0].input.DurationSeconds).toBe(1799);
    f.advance(1800_000 - 899_000);
    await expect(renew()).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_EXPIRED' });
    expect(f.stsClient.send).toHaveBeenCalledTimes(2);
  });
  it('rejects handoff/renewal audience substitution, tampering and revoked connections', async () => {
    const f = fixture();
    const c = (await authorizeAgentCredentialRequest({ grant: f.grant }, f.deps)).credentials[0];
    expect(() =>
      verifyAgentCredentialGrant(c.renewalToken, SECRET, { now: () => START }),
    ).toThrow();
    expect(() =>
      verifyRenewal({
        token: f.grant,
        key: SECRET,
        policy: BEDROCK_IAM_RENEWAL,
        owns: () => true,
        now: () => START,
      }),
    ).toThrow();
    const parts = c.renewalToken.split('.');
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims.bindings[0].configuration.roleArn = 'arn:aws:iam::333333333333:role/Other';
    parts[0] = Buffer.from(JSON.stringify(claims)).toString('base64url');
    await expect(
      authorizeAgentCredentialRequest(
        { action: BEDROCK_IAM_RENEWAL.action, renewalToken: parts.join('.') },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
    f.revoke();
    f.advance(HOUR);
    await expect(
      authorizeAgentCredentialRequest(
        { action: BEDROCK_IAM_RENEWAL.action, renewalToken: c.renewalToken },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_CONNECTION_UNAVAILABLE' });
    expect(f.stsClient.send).toHaveBeenCalledOnce();
  });
  it('verifies an unactivated role only for the signed verification purpose, without renewal authority', async () => {
    const f = fixture('verify-connection');
    const c = (await authorizeAgentCredentialRequest({ grant: f.grant }, f.deps)).credentials[0];
    expect(c.renewalToken).toBeNull();
    expect(c.renewalExpiresAt).toBe(START + 300_000);
    expect(() =>
      signRenewal({
        claims: verifyAgentCredentialGrant(f.grant, SECRET, { now: () => START }),
        binding,
        policy: BEDROCK_IAM_RENEWAL,
        key: SECRET,
      }),
    ).toThrow();
    expect(f.ddbClient.send.mock.calls).toHaveLength(2); // scope lock and policy, no untrusted connection lookup
    expect(
      f.ddbClient.send.mock.calls.every(
        ([command]) => !command.input.Key.pk.startsWith('AGENTAUTH#CONNECTION#'),
      ),
    ).toBe(true);
  });
  it('rejects a signed binding that differs from its stored connection before STS', async () => {
    const f = fixture();
    const grant = signAgentCredentialGrant(
      {
        purpose: 'capabilities',
        projectId: 'p',
        bindings: [
          { ...binding, configuration: { ...binding.configuration, region: 'eu-north-1' } },
        ],
      },
      SECRET,
      { now: () => START },
    );
    const result = await authorizeAgentCredentialRequest({ grant }, f.deps);
    expect(result.credentials[0].error).toBe('AGENT_CREDENTIAL_GRANT_INVALID');
    expect(f.stsClient.send).not.toHaveBeenCalled();
  });
});
