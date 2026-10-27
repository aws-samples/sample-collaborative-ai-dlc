// Handler-level regression for the PR #578 review: a CodeCommit bind or rebind
// outside the connection region is refused per repository with a 409, before
// STS and before any binding write, and the existing binding is left as is.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A chainable stand-in for the gremlin traversal: it records the steps and
// answers toList() from the step names (membership query vs repository query).
const graph = { role: 'owner', repos: [] };
const chain = (steps = []) =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'toList') {
          return async () => (steps.includes('outE') ? [graph.role] : graph.repos);
        }
        return () => chain([...steps, prop]);
      },
    },
  );

vi.mock('gremlin', () => ({
  default: {
    process: {
      AnonymousTraversalSource: { traversal: () => ({ withRemote: () => chain() }) },
      statics: chain(),
    },
    driver: {
      DriverRemoteConnection: class {
        async close() {}
      },
    },
  },
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({}),
}));
vi.mock('gremlin-aws-sigv4/lib/utils.js', () => ({
  getUrlAndHeaders: () => ({ url: 'wss://neptune.invalid/gremlin', headers: {} }),
}));
vi.mock('../../shared/git-providers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getProvider: (provider) =>
      provider === 'codecommit'
        ? { getRepositoryAccess: async () => ({ canRead: true, canWrite: true }) }
        : actual.getProvider(provider),
  };
});

const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
const { SSMClient } = await import('@aws-sdk/client-ssm');
const { STSClient } = await import('@aws-sdk/client-sts');
const { handler } = await import('../index.js');

const ROLE = 'arn:aws:iam::123456789012:role/aidlc-codecommit-access';
const EXTERNAL_ID = 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e';
const EU_REPO = 'arn:aws:codecommit:eu-west-1:123456789012:demo';
const US_REPO = 'arn:aws:codecommit:us-west-2:123456789012:demo';
const EXISTING = {
  projectId: 'p1',
  bindingKey: `codecommit#${EU_REPO}`,
  provider: 'codecommit',
  repo: EU_REPO,
  authType: 'codecommit-role',
  roleArn: ROLE,
  externalId: EXTERNAL_ID,
  region: 'eu-west-1',
  credentialRef: `codecommit-role#${ROLE}#${EXTERNAL_ID}`,
  status: 'active',
};

const putEvent = () => ({
  httpMethod: 'PUT',
  path: '/projects/p1/source-control',
  pathParameters: { projectId: 'p1' },
  requestContext: { authorizer: { claims: { sub: 'u1', name: 'Owner' } } },
  headers: {},
  body: JSON.stringify({ providers: { codecommit: { authType: 'codecommit-role' } } }),
});

describe('PUT /projects/{id}/source-control, CodeCommit region (review #578)', () => {
  let env;
  let writes;
  let stsCalls;

  beforeEach(() => {
    env = { ...process.env };
    process.env.CODECOMMIT_CONNECTION_PARAM = '/aidlc/dev/codecommit-connection';
    process.env.CODECOMMIT_EXTERNAL_ID = EXTERNAL_ID;
    process.env.SOURCE_CONTROL_BINDINGS_TABLE = 'bindings';
    writes = [];
    stsCalls = [];
    vi.spyOn(SSMClient.prototype, 'send').mockImplementation(async () => ({
      Parameter: { Value: JSON.stringify({ roleArn: ROLE, region: 'eu-west-1' }) },
    }));
    vi.spyOn(STSClient.prototype, 'send').mockImplementation(async (command) => {
      stsCalls.push(command);
      return {
        Credentials: {
          AccessKeyId: 'ASIA',
          SecretAccessKey: 's',
          SessionToken: 't',
          Expiration: new Date(Date.now() + 3600_000),
        },
        AssumedRoleUser: { Arn: 'arn:aws:sts::123456789012:assumed-role/x/y' },
      };
    });
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) => {
      if (command.constructor.name === 'QueryCommand') return { Items: [EXISTING] };
      writes.push(command);
      return {};
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = env;
  });

  it('refuses a rebind to another region with a 409, no STS call and no write', async () => {
    graph.repos = [{ repo: US_REPO, provider: 'codecommit' }];
    const result = await handler(putEvent(), {});
    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body);
    expect(body.code).toBe('SOURCE_CONTROL_VERIFICATION_FAILED');
    expect(body.repositories).toEqual([
      expect.objectContaining({ repo: US_REPO, code: 'CODECOMMIT_REGION_MISMATCH' }),
    ]);
    expect(stsCalls).toHaveLength(0);
    // The existing eu-west-1 binding is neither replaced nor deleted.
    expect(writes).toHaveLength(0);
  });

  it('binds a repository in the connection region with the same role', async () => {
    graph.repos = [{ repo: EU_REPO, provider: 'codecommit' }];
    const result = await handler(putEvent(), {});
    expect(result.statusCode).toBe(200);
    expect(stsCalls).toHaveLength(1);
    expect(writes.map((command) => command.constructor.name)).toEqual(['TransactWriteCommand']);
  });
});
