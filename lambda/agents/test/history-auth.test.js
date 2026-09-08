import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { mockClient } from 'aws-sdk-client-mock';

const PARTITION = `t-${randomUUID()}`;
const ddbMock = mockClient(DynamoDBDocumentClient);
const lambdaMock = mockClient(LambdaClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);
const ssmMock = mockClient(SSMClient);
let credentialMetadataHandler;

let handler;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('AGENT_OUTPUTS_TABLE', 'agent-outputs-test');
  vi.stubEnv('QUESTIONS_TABLE', 'agent-questions-test');
  vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/dev');
  vi.stubEnv('AGENT_CREDENTIAL_METADATA_FUNCTION', 'credential-metadata-test');
  // Same account as the role ARNs used below, so those bindings are same-account
  // and generate no external ID (dec-external-id-scope).
  vi.stubEnv('PLATFORM_ACCOUNT_ID', '111122223333');
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
  lambdaMock.reset();
  agentcoreMock.reset();
  ssmMock.reset();
  ssmMock.on(PutParameterCommand).resolves({});
  credentialMetadataHandler = () => ({
    ok: true,
    bindings: {
      bedrock: { provider: 'bedrock', source: 'platform' },
      kiro: { provider: 'kiro', source: 'platform' },
    },
  });
  lambdaMock.on(InvokeCommand).callsFake((input) => {
    const request = JSON.parse(Buffer.from(input.Payload).toString());
    return { Payload: Buffer.from(JSON.stringify(credentialMetadataHandler(request))) };
  });
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
    credentialMetadataHandler = (request) => ({
      ok: true,
      bindings: {
        bedrock: { provider: 'bedrock', source: request.projectId ? 'space' : 'platform' },
        kiro: { provider: 'kiro', source: request.projectId ? 'space' : 'platform' },
      },
    });
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
      // This broker mock returns `bindings` with NO `credentialKinds`, which is
      // exactly an older credential-metadata Lambda during a mixed-version deploy.
      // The kind is descriptive, so it must degrade to null and leave capabilities
      // working — never throw and 500 a route over a badge label.
      credentialKinds: { bedrock: null, kiro: null },
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

  // A binding is a POINTER and is forwarded VERBATIM to the runtime here, signed
  // into a credential grant, and persisted as an execution's durable snapshot. The
  // credential KIND belongs to none of those: it describes the stored value and is
  // re-read every invocation. So it travels in a sibling map, and these assertions
  // are what stop it from being reintroduced onto the binding itself.
  it('reports the credential kind per CLI without putting it on the binding', async () => {
    const caller = `u-${randomUUID()}`;
    const { projectId } = await seedProject(caller);
    credentialMetadataHandler = () => ({
      ok: true,
      bindings: {
        bedrock: { provider: 'bedrock', source: 'platform' },
        kiro: { provider: 'kiro', source: 'platform' },
      },
      credentialKinds: { bedrock: 'role', kiro: 'bearer' },
    });
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
    const body = JSON.parse(response.body);
    expect(body.credentialKinds).toEqual({ bedrock: 'role', kiro: 'bearer' });
    // Per-CLI, derived from the provider map: the three Bedrock CLIs report the
    // role, Kiro reports its key. This is what makes the compose badge read
    // "Platform IAM role" on Claude Code and "Platform key" on Kiro.
    expect(
      Object.fromEntries(body.runtimeClis.map((cli) => [cli.cli, cli.credentialKind])),
    ).toEqual({ kiro: 'bearer', claude: 'role', opencode: 'role', codex: 'role' });

    const payload = JSON.parse(
      Buffer.from(
        agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)[0].args[0].input.payload,
      ).toString(),
    );
    // The runtime receives the RAW binding map, so a kind added to the binding
    // object would silently appear here. It must not.
    expect(payload.credentialBindings).toEqual({
      bedrock: { provider: 'bedrock', source: 'platform' },
      kiro: { provider: 'kiro', source: 'platform' },
    });
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

// specs/bedrock-iam-role-credential-mode — req-role-credential-mode,
// req-single-parameter-encoding. The space scope is where a role binding is
// actually expected to be set, so its write path needs the same validation the
// user and platform paths have. This uses the real membership graph because the
// endpoint is gated on an owner/admin role.
describe('space agent credentials write validation', () => {
  const putEvent = (projectId, sub, body) => ({
    httpMethod: 'PUT',
    path: `/projects/${projectId}/agent-credentials`,
    pathParameters: { projectId },
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub } } },
  });

  it('accepts a valid role binding from a space owner', async () => {
    const member = `u-${randomUUID()}`;
    const { projectId } = await seedProject(member);
    const roleArn = 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference';

    const response = await handler(
      putEvent(projectId, member, { bedrockBearerToken: JSON.stringify({ roleArn }) }),
    );

    expect(response.statusCode).toBe(200);
    const written = ssmMock.commandCalls(PutParameterCommand)[0].args[0].input;
    expect(written.Name).toBe(
      `/collab/dev/projects/${projectId}/agent-credentials/bedrock-bearer-token`,
    );
    expect(written.Type).toBe('SecureString');
    expect(JSON.parse(written.Value).roleArn).toBe(roleArn);
  });

  it('rejects a malformed role binding at space scope without writing SSM', async () => {
    const member = `u-${randomUUID()}`;
    const { projectId } = await seedProject(member);

    const response = await handler(
      putEvent(projectId, member, { bedrockBearerToken: '{"roleArn":"not-an-arn"}' }),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('BEDROCK_ROLE_BINDING_INVALID');
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('still accepts a bearer token at space scope', async () => {
    const member = `u-${randomUUID()}`;
    const { projectId } = await seedProject(member);

    const response = await handler(
      putEvent(projectId, member, { bedrockBearerToken: 'ABSKQmVkcm9jaw==' }),
    );

    expect(response.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input.Value).toBe(
      'ABSKQmVkcm9jaw==',
    );
  });
});
