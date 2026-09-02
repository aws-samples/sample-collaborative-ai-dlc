import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { mockClient } from 'aws-sdk-client-mock';

const PARTITION = `t-${randomUUID()}`;
const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);

let handler;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('AGENT_OUTPUTS_TABLE', 'agent-outputs-test');
  vi.stubEnv('QUESTIONS_TABLE', 'agent-questions-test');
  vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/dev');
  vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', 'g'.repeat(48));
  vi.stubEnv('AGENTCORE_RUNTIME_ARN', 'arn:aws:bedrock-agentcore:eu:1:runtime/test');
  ({ handler } = await import('../index.js'));

  const url = `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`;
  conn = new gremlin.driver.DriverRemoteConnection(url);
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await conn?.close();
});

beforeEach(async () => {
  ddbMock.reset();
  ssmMock.reset();
  agentcoreMock.reset();
  await g.V().drop().next();
});

const event = ({ path, projectId, taskId, sprintId, executionId, sub }) => ({
  httpMethod: 'GET',
  path,
  pathParameters: {
    ...(projectId ? { projectId } : {}),
    ...(taskId ? { taskId } : {}),
  },
  queryStringParameters: {
    ...(sprintId ? { sprintId } : {}),
    ...(executionId ? { executionId } : {}),
  },
  requestContext: { authorizer: { claims: { sub } } },
});

const seedProject = async (memberId, { executionId = `exec-${randomUUID()}` } = {}) => {
  const projectId = `p-${randomUUID()}`;
  const sprintId = `s-${randomUUID()}`;
  const executionArn = `arn:aws:ecs:eu-west-1:123456789012:task/${randomUUID()}`;
  await g.addV('Project').property('id', projectId).next();
  await g.addV('User').property('id', memberId).next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .V()
    .has('User', 'id', memberId)
    .as('u')
    .addE('HAS_MEMBER')
    .from_('p')
    .to('u')
    .property('role', 'owner')
    .next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .as('p')
    .addV('Sprint')
    .property('id', sprintId)
    .property('current_execution_id', executionId)
    .property('current_execution_arn', executionArn)
    .property('current_agent_status', 'running')
    .as('s')
    .addE('HAS_SPRINT')
    .from_('p')
    .to('s')
    .next();
  await g
    .V()
    .has('Sprint', 'id', sprintId)
    .as('s')
    .addV('Task')
    .property('id', `task-${randomUUID()}`)
    .property('title', 'Private task')
    .property('status', 'todo')
    .property('task_execution_id', executionId)
    .property('task_execution_arn', executionArn)
    .as('t')
    .addE('CONTAINS')
    .from_('s')
    .to('t')
    .next();
  return { projectId, sprintId, executionId, executionArn };
};

describe('legacy project agent history authorization', () => {
  it('rejects non-members and project/sprint scope confusion', async () => {
    const caller = `u-${randomUUID()}`;
    const own = await seedProject(caller);
    const foreign = await seedProject(`u-${randomUUID()}`);

    const denied = await handler(
      event({
        path: `/projects/${foreign.projectId}/agents/tasks`,
        projectId: foreign.projectId,
        sprintId: foreign.sprintId,
        sub: caller,
      }),
    );
    expect(denied.statusCode).toBe(403);

    const mismatched = await handler(
      event({
        path: `/projects/${own.projectId}/agents/tasks`,
        projectId: own.projectId,
        sprintId: foreign.sprintId,
        sub: caller,
      }),
    );
    expect(mismatched.statusCode).toBe(404);
  });

  it('authorizes before lazy status reconciliation can mutate a sprint', async () => {
    const caller = `u-${randomUUID()}`;
    const foreign = await seedProject(`u-${randomUUID()}`);

    const denied = await handler(
      event({
        path: `/projects/${foreign.projectId}/agents`,
        projectId: foreign.projectId,
        sprintId: foreign.sprintId,
        sub: caller,
      }),
    );
    expect(denied.statusCode).toBe(403);

    const status = await g
      .V()
      .has('Sprint', 'id', foreign.sprintId)
      .values('current_agent_status')
      .next();
    expect(status.value).toBe('running');
  });
});

describe('project agent capabilities', () => {
  it('passes the project id so AgentCore can resolve space-scoped credentials', async () => {
    const caller = `u-${randomUUID()}`;
    const { projectId } = await seedProject(caller);
    const bedrockPath = `/collab/dev/projects/${projectId}/agent-credentials/bedrock-bearer-token`;
    const kiroPath = `/collab/dev/projects/${projectId}/agent-credentials/kiro-api-key`;
    ssmMock.on(GetParametersCommand).callsFake((input) => ({
      Parameters: (input.Names ?? [])
        .filter((name) => name === bedrockPath || name === kiroPath)
        .map((Name) => ({ Name, Value: `${Name}-value` })),
    }));
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: {
        transformToString: async () =>
          JSON.stringify({
            ok: true,
            clis: [
              { cli: 'kiro', installed: true, authed: true, available: true },
              { cli: 'claude', installed: true, authed: true, available: true },
              { cli: 'opencode', installed: true, authed: true, available: true },
              { cli: 'codex', installed: true, authed: true, available: true },
            ],
            kiroModels: { models: [], default: null },
          }),
      },
    });

    const response = await handler(
      event({
        path: `/projects/${projectId}/agent-capabilities`,
        projectId,
        sub: caller,
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      available: ['kiro', 'claude', 'opencode', 'codex'],
      credentialSources: { bedrock: 'space', kiro: 'space' },
    });
    const payload = JSON.parse(
      Buffer.from(
        agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input.payload,
      ).toString(),
    );
    expect(payload).toMatchObject({
      command: 'capabilities',
      projectId,
      credentialBindings: {
        bedrock: { provider: 'bedrock', source: 'space' },
        kiro: { provider: 'kiro', source: 'space' },
      },
    });
    expect(typeof payload.agentCredentialGrant).toBe('string');
  });
});

describe('direct agent history authorization', () => {
  it('blocks cross-project output reads', async () => {
    const caller = `u-${randomUUID()}`;
    const foreignMember = `u-${randomUUID()}`;
    const foreign = await seedProject(foreignMember);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          executionId: foreign.executionId,
          projectId: foreign.projectId,
          status: 'completed',
          outputText: 'private output',
        },
      ],
    });

    const denied = await handler(
      event({
        path: `/agents/${foreign.executionId}`,
        taskId: foreign.executionId,
        sub: caller,
      }),
    );
    expect(denied.statusCode).toBe(403);

    const allowed = await handler(
      event({
        path: `/agents/${foreign.executionId}`,
        taskId: foreign.executionId,
        sub: foreignMember,
      }),
    );
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body).outputText).toBe('private output');
  });

  it('blocks cross-project questions and strips internal callback fields', async () => {
    const caller = `u-${randomUUID()}`;
    const foreignMember = `u-${randomUUID()}`;
    const foreign = await seedProject(foreignMember);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          questionId: 'q-1',
          agentTaskId: foreign.executionId,
          projectId: foreign.projectId,
          sprintId: foreign.sprintId,
          taskToken: 'internal-step-functions-token',
          questions: [{ text: 'Private decision?' }],
          status: 'pending',
          createdAt: 1,
        },
      ],
    });

    const denied = await handler(
      event({
        path: `/agents/${foreign.executionId}/questions`,
        taskId: foreign.executionId,
        sub: caller,
      }),
    );
    expect(denied.statusCode).toBe(403);

    const allowed = await handler(
      event({
        path: `/agents/${foreign.executionId}/questions`,
        taskId: foreign.executionId,
        sub: foreignMember,
      }),
    );
    expect(allowed.statusCode).toBe(200);
    const [question] = JSON.parse(allowed.body).questions;
    expect(question).toMatchObject({ questionId: 'q-1', status: 'pending' });
    expect(question).not.toHaveProperty('taskToken');
    expect(question).not.toHaveProperty('projectId');
    expect(question).not.toHaveProperty('sprintId');
  });

  it('uses graph ownership after an output row expires', async () => {
    const member = `u-${randomUUID()}`;
    const owned = await seedProject(member);
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const allowed = await handler(
      event({
        path: `/agents/${encodeURIComponent(owned.executionArn)}`,
        taskId: owned.executionArn,
        executionId: owned.executionId,
        sub: member,
      }),
    );
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(allowed.body)).toMatchObject({ status: 'FAILED' });
  });
});
