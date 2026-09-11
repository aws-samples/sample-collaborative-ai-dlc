import { describe, expect, it, vi } from 'vitest';
import { authorizeAgentCredentialRequest } from '../index.js';
import {
  signAgentCredentialGrant,
  verifyAgentCredentialGrant,
  verifyBedrockCredentialRenewal,
} from '../../shared/agent-credential-grants.js';

const secret = 'broker-test-secret'.repeat(4);
const binding = {
  provider: 'bedrock',
  source: 'space',
  authType: 'iam',
  iam: { roleArn: 'arn:aws:iam::222222222222:role/SpaceA', region: 'eu-west-1' },
};
const claims = {
  purpose: 'execution',
  projectId: 'space-a',
  executionId: 'run-a',
  bindings: [binding],
};
const setup = () => {
  let time = Date.now();
  const now = () => time;
  const stsClient = {
    send: vi.fn(async () => ({
      Credentials: {
        AccessKeyId: 'INERT',
        SecretAccessKey: 'inert-secret',
        SessionToken: 'inert-token',
        Expiration: new Date(time + 3600_000),
      },
    })),
  };
  const ssmClient = {
    send: vi.fn(() => {
      throw new Error('Unexpected secret lookup');
    }),
  };
  return {
    now,
    advance: (ms) => {
      time += ms;
    },
    stsClient,
    ssmClient,
    secret,
  };
};

describe('broker IAM authorization', () => {
  it('keeps Kiro available during capability discovery if the IAM role is denied', async () => {
    const deps = setup();
    deps.stsClient.send.mockRejectedValue(
      Object.assign(new Error('raw AWS details'), { name: 'AccessDenied' }),
    );
    deps.ssmClient.send.mockResolvedValue({ Parameter: { Value: 'inert-kiro' } });
    const grant = signAgentCredentialGrant(
      {
        ...claims,
        purpose: 'capabilities',
        bindings: [binding, { provider: 'kiro', source: 'platform' }],
      },
      secret,
      deps,
    );
    const result = await authorizeAgentCredentialRequest(
      { grant },
      { ...deps, env: { AGENT_SETTINGS_SSM_PREFIX: '/test' } },
    );
    expect(result.credentials).toEqual([
      { binding, error: 'BEDROCK_IAM_ACCESS_DENIED' },
      { binding: { provider: 'kiro', source: 'platform' }, value: 'inert-kiro' },
    ]);
    expect(JSON.stringify(result)).not.toContain('raw AWS details');
    const execution = signAgentCredentialGrant(claims, secret, deps);
    await expect(authorizeAgentCredentialRequest({ grant: execution }, deps)).rejects.toMatchObject(
      { name: 'AccessDenied' },
    );
  });
  it('ignores an attempted role/space substitution and only assumes the signed binding', async () => {
    const deps = setup();
    const grant = signAgentCredentialGrant(claims, secret, deps);
    const result = await authorizeAgentCredentialRequest(
      {
        grant,
        projectId: 'space-b',
        roleArn: 'arn:aws:iam::333333333333:role/SpaceB',
      },
      deps,
    );
    expect(result).toMatchObject({ projectId: 'space-a', executionId: 'run-a' });
    expect(result.credentials[0].binding).toEqual(binding);
    const input = deps.stsClient.send.mock.calls[0][0].input;
    expect(input.RoleArn).toBe(binding.iam.roleArn);
    const policy = JSON.parse(input.Policy);
    expect(
      policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => s.Action),
    ).not.toContain('sts:AssumeRole');
    expect(policy.Statement).toContainEqual({
      Effect: 'Deny',
      Action: 'sts:AssumeRole',
      Resource: '*',
    });
    expect(policy.Statement.flatMap((s) => s.Action)).toContain('bedrock-mantle:CreateInference');
    expect(deps.ssmClient.send).not.toHaveBeenCalled();
  });

  it('rejects tampering with either the initial grant or the renewal token before STS', async () => {
    const deps = setup();
    const grant = signAgentCredentialGrant(claims, secret, deps);
    const initial = await authorizeAgentCredentialRequest({ grant }, deps);
    const renewalToken = initial.credentials[0].renewalToken;
    const tamper = (token) => {
      const [payload, signature] = token.split('.');
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
      body.projectId = 'space-b';
      body.bindings[0].iam.roleArn = 'arn:aws:iam::333333333333:role/SpaceB';
      return `${Buffer.from(JSON.stringify(body)).toString('base64url')}.${signature}`;
    };
    deps.stsClient.send.mockClear();
    await expect(
      authorizeAgentCredentialRequest({ grant: tamper(grant) }, deps),
    ).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_INVALID',
    });
    await expect(
      authorizeAgentCredentialRequest(
        {
          action: 'renew-bedrock-credentials',
          renewalToken: tamper(renewalToken),
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
    expect(deps.stsClient.send).not.toHaveBeenCalled();
  });

  it('renews after three hours, never extends the invocation lease, and permits a fresh resumed invocation days later', async () => {
    const deps = setup();
    const grant = signAgentCredentialGrant(claims, secret, deps);
    const first = await authorizeAgentCredentialRequest({ grant }, deps);
    const credential = first.credentials[0];
    deps.advance(3 * 3600_000);
    expect(() => verifyAgentCredentialGrant(grant, secret, deps)).toThrow();
    const renewed = await authorizeAgentCredentialRequest(
      {
        action: 'renew-bedrock-credentials',
        renewalToken: credential.renewalToken,
        roleArn: 'arn:aws:iam::333333333333:role/SpaceB',
        projectId: 'space-b',
      },
      deps,
    );
    expect(renewed.credentials[0].binding).toEqual(binding);
    expect(renewed.credentials[0].renewalToken).toBe(credential.renewalToken);
    expect(renewed.credentials[0].renewalExpiresAt).toBe(credential.renewalExpiresAt);
    expect(Date.parse(renewed.credentials[0].iamCredentials.Expiration)).toBeGreaterThan(
      Date.parse(credential.iamCredentials.Expiration),
    );
    deps.advance(3 * 24 * 3600_000);
    await expect(
      authorizeAgentCredentialRequest(
        {
          action: 'renew-bedrock-credentials',
          renewalToken: credential.renewalToken,
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_EXPIRED' });
    const fresh = await authorizeAgentCredentialRequest(
      { grant: signAgentCredentialGrant(claims, secret, deps) },
      deps,
    );
    expect(fresh.credentials[0].binding).toEqual(binding);
    expect(fresh.credentials[0].renewalToken).not.toBe(credential.renewalToken);
    expect(deps.stsClient.send).toHaveBeenCalledTimes(3);
  });

  it('separates renewal from handoff and excludes API keys from the renewal authority', async () => {
    const deps = setup();
    deps.ssmClient.send.mockResolvedValue({ Parameter: { Value: 'inert-kiro' } });
    const grant = signAgentCredentialGrant(
      { ...claims, bindings: [...claims.bindings, { provider: 'kiro', source: 'platform' }] },
      secret,
      deps,
    );
    const first = await authorizeAgentCredentialRequest(
      { grant },
      { ...deps, env: { AGENT_SETTINGS_SSM_PREFIX: '/test' } },
    );
    const token = first.credentials.find((c) => c.binding.authType === 'iam').renewalToken;
    expect(verifyBedrockCredentialRenewal(token, secret, deps).bindings).toEqual([binding]);
    await expect(authorizeAgentCredentialRequest({ grant: token }, deps)).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_INVALID',
    });
    await expect(
      authorizeAgentCredentialRequest(
        { action: 'renew-bedrock-credentials', renewalToken: grant },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
  });
});
