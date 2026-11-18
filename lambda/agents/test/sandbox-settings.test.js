import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { handler } from '../index.js';
import { DEFAULT_SANDBOX_CONFIG } from '../../shared/sandbox-settings.js';

const ddb = mockClient(DynamoDBDocumentClient);
const ssm = mockClient(SSMClient);
const event = (sandbox, groups = 'platform-admin') => ({
  httpMethod: 'PUT',
  path: '/agents/settings',
  body: JSON.stringify({ sandbox }),
  requestContext: { authorizer: { claims: { sub: 'admin-1', 'cognito:groups': groups } } },
});
beforeEach(() => {
  vi.stubEnv('V2_PROCESS_TABLE', 'process-test');
  ddb.reset();
  ssm.reset();
  ddb.on(GetCommand).resolves({});
  ddb.on(TransactWriteCommand).resolves({});
});
afterEach(() => vi.unstubAllEnvs());

describe('sandbox settings API', () => {
  const update = () => ({
    action: 'draft',
    expectedRevision: 0,
    config: JSON.stringify(DEFAULT_SANDBOX_CONFIG.settings),
  });

  it.each(['', 'space-admin', 'project-admin'])(
    'denies %s before reading or writing settings',
    async (group) => {
      expect((await handler(event(update(), group))).statusCode).toBe(403);
      expect(ddb.calls()).toHaveLength(0);
    },
  );

  it.each(['draft', 'apply'])(
    'validates and saves a %s without modifying other settings',
    async (action) => {
      const response = await handler(event({ ...update(), action }));
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).sandbox).toMatchObject({ revision: 1, enabled: false });
      expect(ssm.calls()).toHaveLength(0);
      const writes = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems;
      expect(writes).toHaveLength(action === 'apply' ? 2 : 1);
    },
  );

  it.each(['{', '[]', '{"network":{},"filesystem":{}}'])(
    'never saves invalid JSON or SRT settings',
    async (config) => {
      const response = await handler(event({ ...update(), config }));
      expect(response.statusCode).toBe(400);
      expect(ddb.calls()).toHaveLength(0);
    },
  );

  it.each(['draft', 'apply'])('saves proxy and violation settings on %s', async (action) => {
    const config = structuredClone(DEFAULT_SANDBOX_CONFIG.settings);
    config.network.parentProxy = {
      http: 'http://proxy.example.com:8080',
      noProxy: 'internal.example.com',
    };
    config.ignoreViolations = { '*': ['/tmp/noisy-path'] };
    const response = await handler(event({ ...update(), action, config: JSON.stringify(config) }));
    expect(response.statusCode).toBe(200);
    const sandbox = JSON.parse(response.body).sandbox;
    expect(sandbox.draft).toEqual(config);
    if (action === 'apply') expect(sandbox.applied.settings).toEqual(config);
    const writes = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems;
    expect(writes[0].Put.Item.draft).toEqual(config);
    if (action === 'apply') expect(writes[1].Put.Item.settings).toEqual(config);
  });

  it.each(['draft', 'apply'])(
    'rejects proxy authentication before %s persistence',
    async (action) => {
      const config = structuredClone(DEFAULT_SANDBOX_CONFIG.settings);
      config.network.parentProxy = { https: 'https://user:password@proxy.example.com' };
      const response = await handler(
        event({ ...update(), action, config: JSON.stringify(config) }),
      );
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).issues).toContainEqual({
        path: 'network.parentProxy.https',
        message: 'Parent proxy authentication is not supported',
      });
      expect(response.body).not.toContain(config.network.parentProxy.https);
      expect(ddb.calls()).toHaveLength(0);
    },
  );

  it('reports unknown fields and leaves the last saved configuration intact', async () => {
    const config = structuredClone(DEFAULT_SANDBOX_CONFIG.settings);
    config.network.strictAllowList = true;
    const response = await handler(event({ ...update(), config: JSON.stringify(config) }));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).issues).toContainEqual(
      expect.objectContaining({ path: 'network.strictAllowList' }),
    );
    expect(ddb.calls()).toHaveLength(0);
  });

  it('rejects stale updates', async () => {
    expect((await handler(event({ ...update(), expectedRevision: 99 }))).statusCode).toBe(409);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('enables the starter configuration without a separate Apply request', async () => {
    const response = await handler(event({ action: 'toggle', enabled: true, expectedRevision: 0 }));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).sandbox).toMatchObject({
      enabled: true,
      applied: { version: 1, settings: DEFAULT_SANDBOX_CONFIG.settings, appliedBy: 'admin-1' },
    });
    const writes = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems;
    expect(writes).toHaveLength(2);
    expect(writes[0].Put.Item.enabled).toBe(true);
    expect(writes[1].Put.Item.settings).toEqual(DEFAULT_SANDBOX_CONFIG.settings);
  });

  it('does not accept combined operations or enable values disguised as strings', async () => {
    expect(
      (await handler(event({ action: 'toggle', enabled: 'false', expectedRevision: 0 })))
        .statusCode,
    ).toBe(400);
    const request = event(update());
    request.body = JSON.stringify({ sandbox: update(), deriveEnrichment: 'llm' });
    expect((await handler(request)).statusCode).toBe(400);
    expect(ddb.calls()).toHaveLength(0);
    expect(ssm.calls()).toHaveLength(0);
  });
});
