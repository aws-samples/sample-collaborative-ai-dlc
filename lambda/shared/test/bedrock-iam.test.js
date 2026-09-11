import { describe, expect, it } from 'vitest';
import { generateBedrockIamSetup, normalizeBedrockIam } from '../bedrock-iam.js';
import {
  signAgentCredentialGrant,
  verifyAgentCredentialGrant,
} from '../agent-credential-grants.js';

const brokerRoleArn = 'arn:aws:iam::111111111111:role/collaborative-broker';
const config = {
  roleArn: 'arn:aws:iam::222222222222:role/teams/BedrockInference',
  region: 'eu-west-1',
  externalId: 'collaborative-space-one',
};

describe('Bedrock IAM setup', () => {
  it('generates both sides of cross-account access and both inference APIs', () => {
    const setup = generateBedrockIamSetup({ brokerRoleArn, config });
    expect(setup.trustPolicy.Statement).toEqual([
      {
        Effect: 'Allow',
        Principal: { AWS: brokerRoleArn },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'sts:ExternalId': config.externalId } },
      },
    ]);
    expect(setup.assumeRolePolicy.Statement).toEqual([
      {
        Effect: 'Allow',
        Action: 'sts:AssumeRole',
        Resource: config.roleArn,
      },
    ]);
    const actions = setup.inferencePolicy.Statement.flatMap((s) => s.Action);
    expect(actions).toContain('bedrock:InvokeModelWithResponseStream');
    expect(actions).toContain('bedrock-mantle:CreateInference');
    expect(actions.some((action) => action.startsWith('iam:'))).toBe(false);
    expect(setup.inferenceCommands).toContain("--path '/teams/'");
    expect(setup.inferenceCommands).toContain("'222222222222'");
    expect(setup.applicationCommands).toContain("'111111111111'");
    expect(setup.applicationCommands).toContain("--role-name 'collaborative-broker'");
    expect(JSON.stringify(setup)).not.toContain('AccessKeyId');
  });

  it.each([
    { ...config, roleArn: `${config.roleArn}\ncredential_process=bad` },
    { ...config, region: 'eu-west-1; echo bad' },
    { ...config, externalId: '$(echo bad)' },
    { ...config, region: 'cn-north-1' },
  ])('rejects configuration and shell injection or a partition mismatch', (input) => {
    expect(() => normalizeBedrockIam(input)).toThrow();
  });

  it('signs the exact IAM role, region, and external ID into invocation grants', () => {
    const binding = { provider: 'bedrock', source: 'space', authType: 'iam', iam: config };
    const secret = 's'.repeat(48);
    const grant = signAgentCredentialGrant(
      {
        purpose: 'execution',
        executionId: 'execution',
        projectId: 'space',
        bindings: [binding],
      },
      secret,
    );
    expect(verifyAgentCredentialGrant(grant, secret).bindings).toEqual([binding]);
    expect(() =>
      signAgentCredentialGrant(
        {
          purpose: 'execution',
          bindings: [{ ...binding, source: 'user', userId: 'user' }],
        },
        secret,
      ),
    ).toThrow();
  });
});
