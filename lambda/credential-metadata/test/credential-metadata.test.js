import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AGENT_CREDENTIAL_METADATA_ACTIONS } from '../../shared/agent-credentials.js';
import { handler, inspectAgentCredentialMetadata } from '../index.js';

const ssmMock = mockClient(SSMClient);
const ssm = new SSMClient({});

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
      status: { bedrockBearerTokenSet: true, kiroApiKeySet: false },
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
    });
    expect(JSON.stringify(result)).not.toContain('secret:');
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
