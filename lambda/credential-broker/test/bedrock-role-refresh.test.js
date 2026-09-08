import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BEDROCK_ROLE_BINDING_CHANGED,
  BEDROCK_ROLE_REFRESH_STAGE_NOT_ACTIVE,
  refreshBedrockRoleCredentials,
} from '../index.js';
import { signBedrockRoleRefreshGrant } from '../../shared/agent-credential-grants.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const sts = new STSClient({});

const SECRET = 'g'.repeat(48);
const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const PROJECT_ID = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
const EXECUTION_ID = 'e-refresh';
const STAGE_INSTANCE_ID = 'si-refresh';
const STAGE_CALLBACK_ID = 'cb-refresh';
const ROLE_ARN = 'arn:aws:iam::111122223333:role/aidlc-bedrock-refresh';
const REPLACEMENT_ROLE_ARN = 'arn:aws:iam::111122223333:role/aidlc-bedrock-replacement';
const SESSION_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: '*' }],
});
const DEFAULT_ENV = {
  V2_PROCESS_TABLE: 'process',
  AGENT_SETTINGS_SSM_PREFIX: '/app/dev',
  BEDROCK_SESSION_POLICY: SESSION_POLICY,
};
const BINDING = { provider: 'bedrock', source: 'platform' };
const ACTIVE_EXECUTION = {
  executionId: EXECUTION_ID,
  projectId: PROJECT_ID,
  status: 'RUNNING',
  credentialBinding: BINDING,
  agentCli: 'claude',
};
const ACTIVE_STAGE = {
  executionId: EXECUTION_ID,
  stageInstanceId: STAGE_INSTANCE_ID,
  stageCallbackId: STAGE_CALLBACK_ID,
  state: 'RUNNING',
};
const STS_CREDENTIALS = {
  AccessKeyId: 'ASIAREFRESH00000001',
  SecretAccessKey: 'refresh-secret-access-key',
  SessionToken: 'refresh-session-token',
  Expiration: new Date('2026-09-01T13:00:00.000Z'),
};

const grantFor = (overrides = {}) =>
  signBedrockRoleRefreshGrant(
    {
      projectId: PROJECT_ID,
      executionId: EXECUTION_ID,
      stageInstanceId: STAGE_INSTANCE_ID,
      stageCallbackId: STAGE_CALLBACK_ID,
      binding: BINDING,
      kind: 'role',
      expiresAt: Math.floor(NOW / 1000) + 3600,
      ...overrides,
    },
    SECRET,
    { now: () => NOW, randomId: () => 'refresh-grant-1234' },
  );

const stubState = ({
  execution = ACTIVE_EXECUTION,
  stage = ACTIVE_STAGE,
  storedValues = [JSON.stringify({ roleArn: ROLE_ARN })],
} = {}) => {
  ddbMock.on(GetCommand, { TableName: 'process' }).callsFake((input) => {
    if (input.Key.pk !== `EXEC#${EXECUTION_ID}`) return {};
    if (input.Key.sk === 'META') return { Item: execution ?? undefined };
    if (input.Key.sk === `STAGE#${STAGE_INSTANCE_ID}`) return { Item: stage ?? undefined };
    return {};
  });
  let readIndex = 0;
  ssmMock.on(GetParameterCommand).callsFake((input) => {
    if (input.Name !== '/app/dev/bedrock-bearer-token') return {};
    const value = storedValues[Math.min(readIndex, storedValues.length - 1)];
    readIndex += 1;
    return value === undefined ? {} : { Parameter: { Name: input.Name, Value: value } };
  });
};

const refresh = (grant, { env = {}, now = () => NOW } = {}) =>
  refreshBedrockRoleCredentials(
    { grant },
    {
      ddbClient: ddb,
      ssmClient: ssm,
      stsClient: sts,
      secret: SECRET,
      env: { ...DEFAULT_ENV, ...env },
      now,
    },
  );

describe('bedrock role credential refresh authorization', () => {
  beforeEach(() => {
    ddbMock.reset();
    ssmMock.reset();
    stsMock.reset();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['missing execution', null],
    ['project mismatch', { ...ACTIVE_EXECUTION, projectId: 'another-project' }],
  ])('refuses an %s before reading stage or credential state', async (_label, execution) => {
    stubState({ execution });

    await expect(refresh(grantFor())).rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('refuses a grant for a different execution before reading stage or credential state', async () => {
    stubState();

    await expect(refresh(grantFor({ executionId: 'another-execution' }))).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('revokes outstanding grants when the execution is cancelled', async () => {
    stubState({ execution: { ...ACTIVE_EXECUTION, status: 'CANCELLED' } });

    await expect(refresh(grantFor())).rejects.toMatchObject({ code: 'EXECUTION_NOT_ACTIVE' });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it.each([
    ['stage instance', grantFor({ stageInstanceId: 'replacement-stage' })],
    ['stage callback', grantFor({ stageCallbackId: 'replacement-attempt' })],
  ])('pins refresh authority to the signed %s', async (_label, grant) => {
    stubState();

    await expect(refresh(grant)).rejects.toMatchObject({
      code: BEDROCK_ROLE_REFRESH_STAGE_NOT_ACTIVE,
    });
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('refuses a grant whose binding no longer matches the execution snapshot', async () => {
    stubState({
      execution: {
        ...ACTIVE_EXECUTION,
        credentialBinding: { provider: 'bedrock', source: 'space' },
      },
    });

    await expect(refresh(grantFor())).rejects.toMatchObject({ code: BEDROCK_ROLE_BINDING_CHANGED });
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('rejects an expired refresh grant before reading execution state', async () => {
    const grant = grantFor({ expiresAt: Math.floor(NOW / 1000) + 60 });

    await expect(refresh(grant, { now: () => NOW + 60_000 })).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_EXPIRED',
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it('supports repeated refreshes with one bounded grant', async () => {
    stubState();
    stsMock.on(AssumeRoleCommand).resolves({ Credentials: STS_CREDENTIALS });
    const grant = grantFor();

    const first = await refresh(grant);
    const second = await refresh(grant);

    expect(first).toEqual(second);
    expect(first).toEqual({
      AccessKeyId: STS_CREDENTIALS.AccessKeyId,
      SecretAccessKey: STS_CREDENTIALS.SecretAccessKey,
      SessionToken: STS_CREDENTIALS.SessionToken,
      Expiration: STS_CREDENTIALS.Expiration.toISOString(),
    });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(4);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(2);
  });

  it('reloads a changed role binding on the next refresh', async () => {
    stubState({
      storedValues: [
        JSON.stringify({ roleArn: ROLE_ARN }),
        JSON.stringify({ roleArn: REPLACEMENT_ROLE_ARN, externalId: 'replacement-external-id' }),
      ],
    });
    stsMock.on(AssumeRoleCommand).resolves({ Credentials: STS_CREDENTIALS });
    const grant = grantFor();

    await refresh(grant);
    await refresh(grant);

    const calls = stsMock.commandCalls(AssumeRoleCommand);
    expect(calls.map((call) => call.args[0].input.RoleArn)).toEqual([
      ROLE_ARN,
      REPLACEMENT_ROLE_ARN,
    ]);
    expect(calls[1].args[0].input.ExternalId).toBe('replacement-external-id');
  });

  it('revalidates the mandatory session ceiling on every refresh', async () => {
    stubState();
    stsMock.on(AssumeRoleCommand).resolves({ Credentials: STS_CREDENTIALS });
    const grant = grantFor();

    await refresh(grant);
    await expect(
      refresh(grant, {
        env: {
          BEDROCK_SESSION_POLICY: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
          }),
        },
      }),
    ).rejects.toMatchObject({ code: 'BEDROCK_ROLE_RESOLUTION_FAILED' });
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });

  it('refuses to redeem a bearer binding and never returns its secret', async () => {
    stubState({ storedValues: ['bearer-secret-must-not-be-returned'] });

    await expect(refresh(grantFor())).rejects.toMatchObject({ code: BEDROCK_ROLE_BINDING_CHANGED });
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });
});
