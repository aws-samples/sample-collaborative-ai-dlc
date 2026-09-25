import { describe, expect, it, vi } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { authorizeAgentCredentialRequest, RENEW_BEDROCK_CREDENTIALS } from '../index.js';
import { INFERENCE_SESSION_POLICY } from '../bedrock-iam.js';
import { normalizeConnection } from '../../shared/agent-auth-catalog.js';
import { connectionBinding } from '../../shared/agent-binding-selection.js';
import {
  signAgentCredentialGrant,
  verifyAgentCredentialGrant,
  verifyBedrockCredentialRenewal,
  signBedrockCredentialRenewal,
} from '../../shared/agent-credential-grants.js';
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
      return { Item: { ...connection, state: command.input.Key.sk === 'META' ? state : 'ready' } };
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
    expect(result.credentials[0].iamCredentials).toEqual({
      AccessKeyId: 'TARGET',
      SecretAccessKey: 'inert-secret',
      Token: 'inert-session',
      Expiration: new Date(START + HOUR).toISOString(),
    });
  });
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
          action: RENEW_BEDROCK_CREDENTIALS,
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
        { action: RENEW_BEDROCK_CREDENTIALS, renewalToken: renewed.renewalToken },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_EXPIRED' });
    expect(f.stsClient.send).toHaveBeenCalledTimes(2);
  });
  it('rejects handoff/renewal audience substitution, tampering and revoked connections', async () => {
    const f = fixture();
    const c = (await authorizeAgentCredentialRequest({ grant: f.grant }, f.deps)).credentials[0];
    expect(() =>
      verifyAgentCredentialGrant(c.renewalToken, SECRET, { now: () => START }),
    ).toThrow();
    expect(() => verifyBedrockCredentialRenewal(f.grant, SECRET, { now: () => START })).toThrow();
    const parts = c.renewalToken.split('.');
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims.bindings[0].configuration.roleArn = 'arn:aws:iam::333333333333:role/Other';
    parts[0] = Buffer.from(JSON.stringify(claims)).toString('base64url');
    await expect(
      authorizeAgentCredentialRequest(
        { action: RENEW_BEDROCK_CREDENTIALS, renewalToken: parts.join('.') },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
    f.revoke();
    f.advance(HOUR);
    await expect(
      authorizeAgentCredentialRequest(
        { action: RENEW_BEDROCK_CREDENTIALS, renewalToken: c.renewalToken },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_CONNECTION_UNAVAILABLE' });
    expect(f.stsClient.send).toHaveBeenCalledOnce();
  });
  it('verifies an unactivated role only for the signed verification purpose, without renewal authority', async () => {
    const f = fixture('verify-bedrock-iam');
    const c = (await authorizeAgentCredentialRequest({ grant: f.grant }, f.deps)).credentials[0];
    expect(c.renewalToken).toBeNull();
    expect(c.renewalExpiresAt).toBe(START + 300_000);
    expect(() =>
      signBedrockCredentialRenewal(
        verifyAgentCredentialGrant(f.grant, SECRET, { now: () => START }),
        SECRET,
      ),
    ).toThrow();
    expect(f.ddbClient.send.mock.calls).toHaveLength(1); // policy only, no untrusted connection lookup
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
