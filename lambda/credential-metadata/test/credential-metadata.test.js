import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { AGENT_CREDENTIAL_METADATA_ACTIONS } from '../../shared/agent-credentials.js';
import { handler, inspectAgentCredentialMetadata } from '../index.js';

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const ssm = new SSMClient({});
const sts = new STSClient({});

describe('agent credential metadata broker', () => {
  beforeEach(() => {
    ssmMock.reset();
  });

  it('returns scope set-state without returning decrypted values', async () => {
    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [
        {
          Name: '/app/dev/users/u-1/agent-credentials/bedrock-bearer-token',
          Value: 'secret-bedrock',
        },
        { Name: '/app/dev/users/u-1/agent-credentials/kiro-api-key', Value: 'placeholder' },
      ],
    });

    const result = await inspectAgentCredentialMetadata(
      {
        action: AGENT_CREDENTIAL_METADATA_ACTIONS.READ_SCOPE_STATUS,
        source: 'user',
        userId: 'u-1',
      },
      { ssmClient: ssm, env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' } },
    );

    expect(result).toEqual({
      status: {
        bedrockBearerTokenSet: true,
        kiroApiKeySet: false,
        bedrockMode: 'bearer',
        bedrockRoleArn: null,
        bedrockExternalIdSet: false,
        // Null for a bearer binding, which carries no external ID. The bearer TOKEN
        // itself remains a real secret and is still asserted absent below.
        bedrockExternalId: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-bedrock');
    expect(ssmMock.commandCalls(GetParametersCommand)[0].args[0].input).toMatchObject({
      WithDecryption: true,
    });
  });

  it('returns effective source bindings without credential values', async () => {
    ssmMock.on(GetParametersCommand).callsFake((input) => ({
      Parameters: (input.Names ?? [])
        .filter((name) => {
          if (name.endsWith('/users/u-1/agent-credentials/kiro-api-key')) return true;
          if (name.endsWith('/projects/p-1/agent-credentials/bedrock-bearer-token')) return true;
          return false;
        })
        .map((Name) => ({ Name, Value: `secret:${Name}` })),
    }));

    const result = await inspectAgentCredentialMetadata(
      {
        action: AGENT_CREDENTIAL_METADATA_ACTIONS.RESOLVE_EFFECTIVE_BINDINGS,
        projectId: 'p-1',
        userId: 'u-1',
      },
      { ssmClient: ssm, env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' } },
    );

    expect(result).toEqual({
      bindings: {
        bedrock: { provider: 'bedrock', source: 'space' },
        kiro: { provider: 'kiro', source: 'user', userId: 'u-1' },
      },
      // The kind of value each effective binding holds, so a UI can name an IAM
      // role as a role instead of a "key". Descriptive metadata: no value, no role
      // ARN, no external ID — the assertion below still proves no secret escapes.
      credentialKinds: { bedrock: 'bearer', kiro: 'bearer' },
    });
    expect(JSON.stringify(result)).not.toContain('secret:');
  });

  it('reports a role-shaped bedrock binding as kind role, and an unset provider as null', async () => {
    const ROLE_VALUE = JSON.stringify({
      roleArn: 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference',
    });
    ssmMock.on(GetParametersCommand).callsFake((input) => ({
      Parameters: (input.Names ?? [])
        .filter((name) => name === '/app/dev/bedrock-bearer-token')
        .map((Name) => ({ Name, Value: ROLE_VALUE })),
    }));

    const result = await inspectAgentCredentialMetadata(
      {
        action: AGENT_CREDENTIAL_METADATA_ACTIONS.RESOLVE_EFFECTIVE_BINDINGS,
        projectId: 'p-1',
        userId: 'u-1',
      },
      { ssmClient: ssm, env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' } },
    );

    expect(result).toEqual({
      bindings: {
        bedrock: { provider: 'bedrock', source: 'platform' },
        kiro: null,
      },
      credentialKinds: { bedrock: 'role', kiro: null },
    });
    // The role ARN is tenant-identifying and no lower-privilege surface needs it,
    // so the kind must be the ONLY thing the mode disclosure adds here.
    expect(JSON.stringify(result)).not.toContain('aidlc-bedrock-inference');
  });

  it('rejects every action outside the metadata-only allowlist', async () => {
    await expect(
      inspectAgentCredentialMetadata(
        { action: 'resolve-agent-credentials', grant: 'attacker-controlled' },
        { ssmClient: ssm, env: { AGENT_SETTINGS_SSM_PREFIX: '/app/dev' } },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(ssmMock.commandCalls(GetParametersCommand)).toHaveLength(0);

    await expect(handler({ action: 'resolve-agent-credentials' })).resolves.toEqual({
      ok: false,
      code: 'INVALID_REQUEST',
    });
  });
});

// specs/bedrock-iam-role-credential-mode — req-binding-preflight.
//
// The preflight lives in THIS function rather than the settings API because this
// function shares the credential-broker execution role, which already holds the
// single sts:AssumeRole grant. So the settings API gains no STS permission, and the
// number of principals able to assume a customer role stays at one.
describe('bedrock role binding preflight action', () => {
  const ROLE_ARN = 'arn:aws:iam::444455556666:role/aidlc-bedrock-inference';
  const ENV = {
    AGENT_SETTINGS_SSM_PREFIX: '/app/dev',
    BEDROCK_ASSUMABLE_ROLE_ARNS: JSON.stringify(['arn:aws:iam::*:role/aidlc-bedrock-*']),
    CREDENTIAL_BROKER_ROLE_ARN: 'arn:aws:iam::111122223333:role/broker',
    PLATFORM_ACCOUNT_ID: '111122223333',
  };

  beforeEach(() => {
    stsMock.reset();
  });

  it('returns a verdict with no credentials and reads no credential parameter', async () => {
    stsMock.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: 'ASIA-must-not-leak',
        SecretAccessKey: 'secret-must-not-leak',
        SessionToken: 'token-must-not-leak',
      },
    });

    const result = await inspectAgentCredentialMetadata(
      {
        action: AGENT_CREDENTIAL_METADATA_ACTIONS.PREFLIGHT_BEDROCK_ROLE,
        roleArn: ROLE_ARN,
        externalId: 'ext',
        projectId: 'p-1',
      },
      { ssmClient: ssm, stsClient: sts, env: ENV },
    );

    expect(result.preflight).toMatchObject({ ok: true, cause: 'ok', sessionName: 'aidlc-p-1' });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    // The binding is not persisted yet, so the ARN comes from the request — which
    // means this action must never touch a stored credential to answer.
    expect(ssmMock.commandCalls(GetParametersCommand)).toHaveLength(0);
  });

  it('reports a denial as one trust-policy category naming the broker principal', async () => {
    stsMock
      .on(AssumeRoleCommand)
      .rejects(Object.assign(new Error('nope'), { name: 'AccessDenied' }));

    const { preflight } = await inspectAgentCredentialMetadata(
      {
        action: AGENT_CREDENTIAL_METADATA_ACTIONS.PREFLIGHT_BEDROCK_ROLE,
        roleArn: ROLE_ARN,
        externalId: 'ext',
        projectId: 'p-1',
      },
      { ssmClient: ssm, stsClient: sts, env: ENV },
    );

    expect(preflight.ok).toBe(false);
    expect(preflight.cause).toBe('trust-policy-rejected');
    expect(JSON.stringify(preflight)).toContain('arn:aws:iam::111122223333:role/broker');
    expect(JSON.stringify(preflight)).not.toContain('AccessDenied');
  });

  it('rejects a role outside the deployment allowlist without calling STS', async () => {
    const { preflight } = await inspectAgentCredentialMetadata(
      {
        action: AGENT_CREDENTIAL_METADATA_ACTIONS.PREFLIGHT_BEDROCK_ROLE,
        roleArn: 'arn:aws:iam::444455556666:role/unrelated',
        projectId: 'p-1',
      },
      { ssmClient: ssm, stsClient: sts, env: ENV },
    );

    expect(preflight.cause).toBe('role-not-allowlisted');
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });
});
