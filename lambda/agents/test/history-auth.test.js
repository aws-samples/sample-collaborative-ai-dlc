import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { GetProductsCommand, PricingClient } from '@aws-sdk/client-pricing';
import { mockClient } from 'aws-sdk-client-mock';

const PARTITION = `t-${randomUUID()}`;
const ddbMock = mockClient(DynamoDBDocumentClient);
const lambdaMock = mockClient(LambdaClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);
const ssmMock = mockClient(SSMClient);
const bedrockMock = mockClient(BedrockClient);
const pricingMock = mockClient(PricingClient);
const parameterNotFound = () =>
  Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
let credentialMetadataHandler;

let handler;
let conn;
let g;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  vi.stubEnv('AGENT_OUTPUTS_TABLE', 'agent-outputs-test');
  vi.stubEnv('QUESTIONS_TABLE', 'agent-questions-test');
  vi.stubEnv('V2_PROCESS_TABLE', 'process-table');
  vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/collab/dev');
  vi.stubEnv('AGENT_CREDENTIAL_METADATA_FUNCTION', 'credential-metadata-test');
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
  ddbMock.on(GetCommand).resolves({});
  lambdaMock.reset();
  agentcoreMock.reset();
  ssmMock.reset();
  ssmMock.on(GetParameterCommand).rejects(parameterNotFound());
  bedrockMock.reset();
  bedrockMock.on(ListInferenceProfilesCommand).resolves({ inferenceProfileSummaries: [] });
  pricingMock.reset();
  pricingMock.on(GetProductsCommand).resolves({ PriceList: [] });
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

  it('reports admin-disabled CLIs as unavailable', async () => {
    const caller = `u-${randomUUID()}`;
    const { projectId } = await seedProject(caller);
    ssmMock
      .on(GetParameterCommand, { Name: '/collab/dev/disabled-clis' })
      .resolves({ Parameter: { Value: '["codex"]' } });
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: {
        transformToString: async () =>
          JSON.stringify({
            ok: true,
            clis: [
              { cli: 'kiro', installed: true, authed: true, available: true },
              { cli: 'codex', installed: true, authed: true, available: true },
            ],
            kiroModels: { models: [], default: null },
          }),
      },
    });

    const response = await handler(
      event({ path: `/projects/${projectId}/agent-capabilities`, projectId, sub: caller }),
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.available).toEqual(['kiro']);
    expect(body.disabledClis).toEqual(['codex']);
    expect(body.runtimeClis).toEqual([
      expect.objectContaining({ cli: 'kiro', enabled: true, available: true }),
      expect.objectContaining({ cli: 'codex', enabled: false, available: false, installed: true }),
    ]);
  });
});

// Model lists and prices come from AWS at run time; each test loads its own
// handler module so no list or price table cached by another test is in play.
describe('picker models and prices', () => {
  const PRICE_LIST = JSON.parse(
    readFileSync(
      new URL('../../shared/test/fixtures/price-list-sample.json', import.meta.url),
      'utf8',
    ),
  );
  const PRICING_PARAMETER = '/collab/dev/model-pricing';
  const model = (id) => ({ id, name: id, description: null });
  const profile = (id) => ({ inferenceProfileId: id, inferenceProfileName: id, status: 'ACTIVE' });
  let fresh;

  beforeEach(async () => {
    vi.stubEnv('BEDROCK_REGION', 'us-east-1');
    vi.resetModules();
    ({ handler: fresh } = await import('../index.js'));
  });

  const runtimeAnswers = (codexModels) =>
    agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
      response: {
        transformToString: async () =>
          JSON.stringify({
            ok: true,
            clis: [{ cli: 'codex', installed: true, authed: true, available: true }],
            kiroModels: { models: [], default: null },
            ...(codexModels ? { codexModels } : {}),
          }),
      },
    });
  const pickerModels = async () => {
    const caller = `u-${randomUUID()}`;
    const { projectId } = await seedProject(caller);
    const request = event({
      path: `/projects/${projectId}/agent-capabilities`,
      projectId,
      sub: caller,
    });
    return {
      request: { ...request, queryStringParameters: { models: '1' } },
      response: await fresh({ ...request, queryStringParameters: { models: '1' } }),
    };
  };
  const storedTable = async () => {
    const { refreshPricing, serializePriceTable } = await import('../../shared/model-pricing.js');
    return serializePriceTable(
      await refreshPricing({ getProducts: async () => PRICE_LIST, region: 'us-east-1' }),
    );
  };

  it('returns every list as read and marks only the models that have no price', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: PRICING_PARAMETER })
      .resolves({ Parameter: { Value: await storedTable() } });
    // The region lists more inference profiles than one page holds.
    bedrockMock
      .on(ListInferenceProfilesCommand)
      .resolves({
        inferenceProfileSummaries: [profile('us.anthropic.claude-sonnet-4-6')],
        nextToken: 'page-2',
      })
      .on(ListInferenceProfilesCommand, { nextToken: 'page-2' })
      .resolves({ inferenceProfileSummaries: [profile('us.anthropic.claude-opus-9')] });
    runtimeAnswers({
      source: 'catalog',
      models: [model('openai.gpt-6.1-terra'), model('openai.gpt-9-unlisted')],
    });

    const { response } = await pickerModels();

    expect(response.statusCode).toBe(200);
    const { models } = JSON.parse(response.body);
    expect(models.codexSource).toBe('catalog');
    expect(models.codex).toEqual([
      model('openai.gpt-6.1-terra'),
      { ...model('openai.gpt-9-unlisted'), priced: false },
    ]);
    expect(models.claude).toEqual([
      {
        id: 'us.anthropic.claude-opus-9',
        name: 'us.anthropic.claude-opus-9',
        description: null,
        priced: false,
      },
      {
        id: 'us.anthropic.claude-sonnet-4-6',
        name: 'us.anthropic.claude-sonnet-4-6',
        description: null,
      },
    ]);
    expect(models.opencode.map((m) => [m.id, m.priced])).toEqual([
      ['amazon-bedrock/us.anthropic.claude-opus-9', false],
      ['amazon-bedrock/us.anthropic.claude-sonnet-4-6', undefined],
    ]);
  });

  it('answers with the lists and no price marks when pricing is unavailable', async () => {
    ssmMock.on(GetParameterCommand, { Name: PRICING_PARAMETER }).rejects(new Error('Throttled'));
    pricingMock.on(GetProductsCommand).rejects(new Error('Rate exceeded'));
    bedrockMock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [profile('us.anthropic.claude-sonnet-4-6')] });
    runtimeAnswers({ source: 'catalog', models: [model('openai.gpt-9-unlisted')] });

    const { response } = await pickerModels();

    expect(response.statusCode).toBe(200);
    const { models } = JSON.parse(response.body);
    expect(models.codex).toEqual([model('openai.gpt-9-unlisted')]);
    expect(models.claude).toEqual([
      {
        id: 'us.anthropic.claude-sonnet-4-6',
        name: 'us.anthropic.claude-sonnet-4-6',
        description: null,
      },
    ]);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('marks every model as unpriced while no price table exists', async () => {
    runtimeAnswers({ source: 'catalog', models: [model('openai.gpt-6.1-terra')] });

    const { response } = await pickerModels();

    expect(JSON.parse(response.body).models.codex).toEqual([
      { ...model('openai.gpt-6.1-terra'), priced: false },
    ]);
  });

  it('offers no built-in Codex list after a failed catalogue lookup, then the last list read', async () => {
    runtimeAnswers({ source: 'error', models: [] });
    const first = await pickerModels();
    expect(JSON.parse(first.response.body).models).toMatchObject({
      codex: [],
      codexSource: 'error',
    });

    runtimeAnswers({ source: 'catalog', models: [model('openai.gpt-6.1-terra')] });
    expect(JSON.parse((await fresh(first.request)).body).models.codexSource).toBe('catalog');

    runtimeAnswers({ source: 'error', models: [] });
    const cached = JSON.parse((await fresh(first.request)).body).models;
    expect(cached.codexSource).toBe('cached');
    expect(cached.codex.map((m) => m.id)).toEqual(['openai.gpt-6.1-terra']);
  });

  it('does not bring back models that a later successful, empty answer removed', async () => {
    const kiroAnswers = (models) =>
      agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
        response: {
          transformToString: async () =>
            JSON.stringify({
              ok: true,
              clis: [{ cli: 'kiro', installed: true, authed: true, available: true }],
              kiroModels: { models, default: null },
              codexModels: {
                source: 'catalog',
                models: models.map((m) => model(`openai.${m.id}`)),
              },
            }),
        },
      });
    const read = async (request) => JSON.parse((await fresh(request)).body).models;

    // Successful populated list.
    kiroAnswers([{ id: 'auto', name: 'Auto' }]);
    const { request, response } = await pickerModels();
    expect(JSON.parse(response.body).models.kiro).toEqual([{ id: 'auto', name: 'Auto' }]);

    // Successful empty list.
    kiroAnswers([]);
    expect(await read(request)).toMatchObject({ kiro: [], codex: [] });

    // Failed runtime probe: the last successful answer was "no models".
    agentcoreMock.on(InvokeAgentRuntimeCommand).rejects(new Error('runtime unreachable'));
    expect(await read(request)).toMatchObject({ kiro: [], codex: [] });
  });

  it('reports the runtime lists as failed when the probe fails, and keeps the Claude list', async () => {
    bedrockMock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [profile('us.anthropic.claude-sonnet-4-6')] });
    agentcoreMock.on(InvokeAgentRuntimeCommand).rejects(new Error('runtime unreachable'));

    const { response } = await pickerModels();

    expect(response.statusCode).toBe(200);
    const { models } = JSON.parse(response.body);
    expect(models).toMatchObject({ codex: [], codexSource: 'error', kiro: [] });
    expect(models.sources).toEqual({
      claude: 'catalog',
      opencode: 'catalog',
      kiro: 'error',
      codex: 'error',
    });
    expect(models.claude.map((m) => m.id)).toEqual(['us.anthropic.claude-sonnet-4-6']);
  });

  it('answers with an empty Claude list when the profile lookup fails', async () => {
    bedrockMock.on(ListInferenceProfilesCommand).rejects(new Error('ThrottlingException'));
    runtimeAnswers({ source: 'catalog', models: [model('openai.gpt-6.1-terra')] });

    const { response } = await pickerModels();

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).models).toMatchObject({ claude: [], opencode: [] });
  });

  it('rebuilds the price table from the Price List on the scheduled event', async () => {
    pricingMock
      .on(GetProductsCommand)
      .resolves({ PriceList: [] })
      .on(GetProductsCommand, {
        Filters: [
          { Type: 'TERM_MATCH', Field: 'provider', Value: 'Anthropic' },
          { Type: 'TERM_MATCH', Field: 'regionCode', Value: 'us-east-1' },
          { Type: 'TERM_MATCH', Field: 'feature', Value: 'On-demand Inference' },
        ],
      })
      .resolves({
        PriceList: PRICE_LIST.filter((row) => row.product.attributes.provider === 'Anthropic').map(
          // The SDK returns lazy JSON String objects.
          (row) => new String(JSON.stringify(row)),
        ),
        NextToken: 'more',
      })
      .on(GetProductsCommand, { NextToken: 'more' })
      .resolves({ PriceList: [] })
      .on(GetProductsCommand, {
        Filters: [
          { Type: 'TERM_MATCH', Field: 'provider', Value: 'OpenAI' },
          { Type: 'TERM_MATCH', Field: 'regionCode', Value: 'us-east-1' },
          { Type: 'TERM_MATCH', Field: 'feature', Value: 'On-demand Inference' },
        ],
      })
      .resolves({
        PriceList: PRICE_LIST.filter((row) => row.product.attributes.provider === 'OpenAI'),
      });
    ssmMock.on(PutParameterCommand).resolves({});

    const result = await fresh({ action: 'refresh-model-pricing' });

    expect(result).toEqual({ refreshed: true });
    for (const call of pricingMock.commandCalls(GetProductsCommand)) {
      expect(call.args[0].input.ServiceCode).toBe('AmazonBedrockFoundationModels');
    }
    const [put] = ssmMock.commandCalls(PutParameterCommand);
    expect(put.args[0].input).toMatchObject({
      Name: PRICING_PARAMETER,
      Type: 'String',
      Tier: 'Intelligent-Tiering',
      Overwrite: true,
    });
    const { parsePriceTable } = await import('../../shared/model-pricing.js');
    const written = parsePriceTable(put.args[0].input.Value);
    expect(written.region).toBe('us-east-1');
    expect(written.prices).toEqual(parsePriceTable(await storedTable()).prices);
    expect(put.args[0].input.Value.length).toBeLessThan(4096);
  });

  it.each([
    ['is throttled', () => pricingMock.on(GetProductsCommand).rejects(new Error('Rate exceeded'))],
    [
      'fails on a later page',
      () =>
        pricingMock
          .on(GetProductsCommand)
          .resolves({ PriceList: PRICE_LIST, NextToken: 'more' })
          .on(GetProductsCommand, { NextToken: 'more' })
          .rejects(new Error('Rate exceeded')),
    ],
    ['returns no product', () => pricingMock.on(GetProductsCommand).resolves({ PriceList: [] })],
  ])('leaves the stored table alone when the Price List %s', async (_label, arrange) => {
    arrange();

    expect(await fresh({ action: 'refresh-model-pricing' })).toEqual({ refreshed: false });
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
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
