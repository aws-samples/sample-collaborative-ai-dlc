import { describe, expect, it } from 'vitest';
import { bindingIdentity, normalizeConnection } from '../agent-auth-contracts.js';
import { connectionBinding } from '../agent-auth-selection-strategies.js';
import { normalizeBedrockIam } from '../agent-auth-bedrock-iam-schema.js';

// Signed grants, eight-hour renewal tokens and pinned executions compare these strings
// byte-for-byte, so they are never edited. Every expectation was captured once from #488 at
// 76e18e1 by evaluating the same inputs with its agent-auth-contracts.js normalizeConnection,
// agent-binding-selection.js connectionBinding and agent-auth-bedrock-iam-schema.js.
const ROLE = 'arn:aws:iam::222222222222:role/teams/BedrockInference';
const EXTERNAL_ID = 'collaborative-space-one';
const POLICY_REVISION = 3;
const iam = (source, configuration) => ({
  id: `iam-${source}`,
  revision: 1,
  mode: 'iam',
  backend: 'bedrock',
  mechanism: 'assume-role',
  source,
  ...(source === 'space' ? { projectId: 'p1' } : {}),
  configuration,
});
const IDENTITIES = [
  {
    name: 'a platform role without an external ID ({ region, roleArn })',
    input: iam('platform', { region: 'eu-west-1', roleArn: ROLE }),
    normalized:
      '{"id":"iam-platform","revision":1,"mode":"iam","backend":"bedrock","mechanism":"assume-role","source":"platform","state":"ready","configuration":{"roleArn":"arn:aws:iam::222222222222:role/teams/BedrockInference","region":"eu-west-1"}}',
    identity:
      '{"version":2,"provider":"bedrock","source":"platform","connectionId":"iam-platform","connectionRevision":1,"policyRevision":3,"mode":"iam","backend":"bedrock","mechanism":"assume-role","configuration":{"roleArn":"arn:aws:iam::222222222222:role/teams/BedrockInference","region":"eu-west-1"}}',
  },
  {
    name: 'a space role with an external ID ({ roleArn, region, externalId })',
    input: iam('space', { roleArn: ROLE, region: 'eu-west-1', externalId: EXTERNAL_ID }),
    normalized:
      '{"id":"iam-space","revision":1,"mode":"iam","backend":"bedrock","mechanism":"assume-role","source":"space","state":"ready","projectId":"p1","configuration":{"roleArn":"arn:aws:iam::222222222222:role/teams/BedrockInference","region":"eu-west-1","externalId":"collaborative-space-one"}}',
    identity:
      '{"version":2,"provider":"bedrock","source":"space","connectionId":"iam-space","connectionRevision":1,"policyRevision":3,"mode":"iam","backend":"bedrock","mechanism":"assume-role","configuration":{"roleArn":"arn:aws:iam::222222222222:role/teams/BedrockInference","region":"eu-west-1","externalId":"collaborative-space-one"},"projectId":"p1"}',
  },
  {
    name: 'the same space role in another key order ({ externalId, region, roleArn })',
    input: iam('space', { externalId: EXTERNAL_ID, region: 'eu-west-1', roleArn: ROLE }),
    normalized:
      '{"id":"iam-space","revision":1,"mode":"iam","backend":"bedrock","mechanism":"assume-role","source":"space","state":"ready","projectId":"p1","configuration":{"roleArn":"arn:aws:iam::222222222222:role/teams/BedrockInference","region":"eu-west-1","externalId":"collaborative-space-one"}}',
    identity:
      '{"version":2,"provider":"bedrock","source":"space","connectionId":"iam-space","connectionRevision":1,"policyRevision":3,"mode":"iam","backend":"bedrock","mechanism":"assume-role","configuration":{"roleArn":"arn:aws:iam::222222222222:role/teams/BedrockInference","region":"eu-west-1","externalId":"collaborative-space-one"},"projectId":"p1"}',
  },
];
const CONFIGURATION_REJECTIONS = [
  [null, 'A Bedrock IAM role and region are required'],
  [[], 'A Bedrock IAM role and region are required'],
  [ROLE, 'A Bedrock IAM role and region are required'],
  [{ region: 'eu-west-1' }, 'Enter a valid IAM role ARN'],
  [
    { roleArn: `${ROLE}\ncredential_process=bad`, region: 'eu-west-1' },
    'Enter a valid IAM role ARN',
  ],
  [
    { roleArn: 'arn:aws:iam::22222222222:role/Short', region: 'eu-west-1' },
    'Enter a valid IAM role ARN',
  ],
  [
    { roleArn: `arn:aws:iam::222222222222:role/${'r'.repeat(65)}`, region: 'eu-west-1' },
    'Enter a valid IAM role ARN',
  ],
  [{ roleArn: ROLE }, 'Enter a valid AWS region'],
  [{ roleArn: ROLE, region: 'eu-west-1; echo bad' }, 'Enter a valid AWS region'],
  [{ roleArn: ROLE, region: 'cn-north-1' }, 'The role and region must use the same AWS partition'],
  [
    { roleArn: 'arn:aws-us-gov:iam::222222222222:role/Inference', region: 'eu-west-1' },
    'The role and region must use the same AWS partition',
  ],
  [
    { roleArn: ROLE, region: 'eu-west-1', externalId: '$(echo bad)' },
    'The external ID contains unsupported characters or has an invalid length',
  ],
  [
    { roleArn: ROLE, region: 'eu-west-1', externalId: 'x' },
    'The external ID contains unsupported characters or has an invalid length',
  ],
];
const CONNECTION_REJECTIONS = [
  [
    { roleArn: ROLE, region: 'eu-west-1', sessionPolicy: '*' },
    'Connection configuration contains unsupported fields',
  ],
  [{ roleArn: ROLE, region: ' ' }, 'region is invalid'],
  [{ roleArn: ROLE, region: 'eu-west-1', externalId: 7 }, 'externalId is invalid'],
  [{ roleArn: ROLE, region: 'cn-north-1' }, 'The role and region must use the same AWS partition'],
  [
    { roleArn: ROLE, region: 'eu-west-1', externalId: '$(echo bad)' },
    'The external ID contains unsupported characters or has an invalid length',
  ],
];
const failure = (evaluate) => {
  try {
    evaluate();
  } catch ({ code, message }) {
    return { code, message };
  }
  return null;
};

describe('golden Bedrock IAM binding identities', () => {
  it.each(IDENTITIES)('pins $name', ({ input, normalized, identity }) => {
    const connection = normalizeConnection(input);
    expect(JSON.stringify(connection)).toBe(normalized);
    expect(bindingIdentity(connectionBinding(connection, POLICY_REVISION))).toBe(identity);
    expect(JSON.stringify(normalizeConnection(JSON.parse(normalized)))).toBe(normalized);
  });

  it.each(CONFIGURATION_REJECTIONS)('rejects the configuration %j', (input, message) => {
    expect(failure(() => normalizeBedrockIam(input))).toStrictEqual({
      code: 'AGENT_AUTH_INVALID',
      message,
    });
  });

  it.each(CONNECTION_REJECTIONS)('rejects a connection configured as %j', (input, message) => {
    expect(failure(() => normalizeConnection(iam('platform', input)))).toStrictEqual({
      code: 'AGENT_AUTH_INVALID',
      message,
    });
  });
});
