import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteParameterCommand,
  SSMClient,
  GetParametersCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const ssmMock = mockClient(SSMClient);
const lambdaMock = mockClient(LambdaClient);
let credentialMetadataHandler;
let handler;

const event = (method, body, groups = null) => ({
  httpMethod: method,
  path: '/agents/settings',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  requestContext: {
    authorizer: {
      claims: {
        sub: 'user-1',
        ...(groups ? { 'cognito:groups': groups } : {}),
      },
    },
  },
});

beforeAll(async () => {
  process.env.AGENT_SETTINGS_SSM_PREFIX = '/collab/dev';
  process.env.AGENT_CREDENTIAL_METADATA_FUNCTION = 'credential-metadata-test';
  ({ handler } = await import('../index.js'));
});

beforeEach(() => {
  ssmMock.reset();
  lambdaMock.reset();
  credentialMetadataHandler = () => ({
    ok: true,
    status: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
  });
  lambdaMock.on(InvokeCommand).callsFake((input) => {
    const request = JSON.parse(Buffer.from(input.Payload).toString());
    return {
      Payload: Buffer.from(JSON.stringify(credentialMetadataHandler(request))),
    };
  });
});

describe('platform PR strategy settings', () => {
  it('reads pr-per-unit and fails safely to intent-pr for an unknown value', async () => {
    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [{ Name: '/collab/dev/pr-strategy', Value: 'pr-per-unit' }],
    });
    const configured = await handler(event('GET'));
    expect(configured.statusCode).toBe(200);
    expect(JSON.parse(configured.body).prStrategy).toBe('pr-per-unit');
    expect(
      ssmMock
        .commandCalls(GetParametersCommand)
        .flatMap((call) => call.args[0].input.Names ?? [])
        .filter((name) => name.endsWith('/bedrock-bearer-token') || name.endsWith('/kiro-api-key')),
    ).toEqual([]);

    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [{ Name: '/collab/dev/pr-strategy', Value: 'stacked' }],
    });
    const fallback = await handler(event('GET'));
    expect(JSON.parse(fallback.body).prStrategy).toBe('intent-pr');
  });

  it('allows only platform admins to update the strategy', async () => {
    const denied = await handler(event('PUT', { prStrategy: 'pr-per-unit' }));
    expect(denied.statusCode).toBe(403);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);

    ssmMock.on(PutParameterCommand).resolves({});
    const allowed = await handler(event('PUT', { prStrategy: 'pr-per-unit' }, 'platform-admin'));
    expect(allowed.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/dev/pr-strategy',
      Value: 'pr-per-unit',
      Type: 'String',
      Overwrite: true,
    });
  });

  it('rejects removed and unknown strategies without writing SSM', async () => {
    const response = await handler(event('PUT', { prStrategy: 'stacked' }, 'platform-admin'));
    expect(response.statusCode).toBe(400);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });
});

describe('native execution debug archive preferences', () => {
  const enabledPath = '/collab/dev/native-debug-archives-enabled';
  const daysPath = '/collab/dev/native-debug-archive-retention-days';

  const useStoredSettings = (entries = []) => {
    const stored = new Map(entries);
    ssmMock.on(GetParametersCommand).callsFake(({ Names }) => ({
      Parameters: Names.filter((name) => stored.has(name)).map((Name) => ({
        Name,
        Value: stored.get(Name),
      })),
    }));
    ssmMock.on(PutParameterCommand).callsFake(({ Name, Value }) => {
      stored.set(Name, Value);
      return {};
    });
    return stored;
  };

  it('defaults old installations to off and seven days without writing any settings', async () => {
    useStoredSettings([['/collab/dev/pr-strategy', 'pr-per-unit']]);
    const result = await handler(event('GET'));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      nativeDebugArchivesEnabled: false,
      nativeDebugArchiveRetentionDays: 7,
      prStrategy: 'pr-per-unit',
    });
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it.each(['', '0', '-1', '1.5', '1e2', 'seven', '9007199254740992'])(
    'fails safely for invalid stored retention %j and a non-boolean enablement value',
    async (days) => {
      useStoredSettings([
        [enabledPath, 'enabled'],
        [daysPath, days],
      ]);
      const result = await handler(event('GET'));
      expect(JSON.parse(result.body)).toMatchObject({
        nativeDebugArchivesEnabled: false,
        nativeDebugArchiveRetentionDays: 7,
      });
    },
  );

  it('round-trips both preferences and preserves days when disabling, plus unrelated settings', async () => {
    const stored = useStoredSettings([
      ['/collab/dev/pr-strategy', 'pr-per-unit'],
      ['/collab/dev/stage-skipping', 'enabled'],
      ['/collab/dev/custom-mcp-servers', '{"example":{"url":"https://example.test/mcp"}}'],
    ]);
    const legacy = [...stored];
    const result = await handler(
      event(
        'PUT',
        { nativeDebugArchivesEnabled: true, nativeDebugArchiveRetentionDays: 14 },
        'platform-admin',
      ),
    );
    expect(result.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand).map((call) => call.args[0].input)).toEqual([
      { Name: enabledPath, Value: 'true', Type: 'String', Overwrite: true },
      { Name: daysPath, Value: '14', Type: 'String', Overwrite: true },
    ]);
    expect(JSON.parse((await handler(event('GET'))).body)).toMatchObject({
      nativeDebugArchivesEnabled: true,
      nativeDebugArchiveRetentionDays: 14,
      prStrategy: 'pr-per-unit',
      stageSkipping: 'enabled',
    });

    const disabled = await handler(
      event('PUT', { nativeDebugArchivesEnabled: false }, 'platform-admin'),
    );
    expect(disabled.statusCode).toBe(200);
    expect(JSON.parse((await handler(event('GET'))).body)).toMatchObject({
      nativeDebugArchivesEnabled: false,
      nativeDebugArchiveRetentionDays: 14,
    });
    expect([...stored].filter(([name]) => name !== enabledPath && name !== daysPath)).toEqual(
      legacy,
    );
  });

  it('allows retention-only edits while disabled, and legacy edits leave debug preferences intact', async () => {
    const stored = useStoredSettings([
      [enabledPath, 'false'],
      [daysPath, '7'],
    ]);
    const updated = await handler(
      event('PUT', { nativeDebugArchiveRetentionDays: 30 }, 'platform-admin'),
    );
    expect(updated.statusCode).toBe(200);
    expect(stored.get(enabledPath)).toBe('false');
    const legacyUpdate = await handler(
      event('PUT', { prStrategy: 'pr-per-unit' }, 'platform-admin'),
    );
    expect(legacyUpdate.statusCode).toBe(200);
    expect(JSON.parse((await handler(event('GET'))).body)).toMatchObject({
      nativeDebugArchivesEnabled: false,
      nativeDebugArchiveRetentionDays: 30,
      prStrategy: 'pr-per-unit',
    });
    expect(
      ssmMock.commandCalls(PutParameterCommand).map((call) => call.args[0].input.Name),
    ).toEqual([daysPath, '/collab/dev/pr-strategy']);
  });

  it.each([null, 'member', 'project-admin'])(
    'rejects changes from %j even when the body claims admin authority',
    async (group) => {
      const result = await handler(
        event(
          'PUT',
          {
            nativeDebugArchivesEnabled: true,
            nativeDebugArchiveRetentionDays: 14,
            isPlatformAdmin: true,
            'cognito:groups': 'platform-admin',
          },
          group,
        ),
      );
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body).code).toBe('PLATFORM_ADMIN_REQUIRED');
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    },
  );

  it.each(['true', 1, null, {}, []])('rejects a non-boolean enabled value %j', async (value) => {
    const result = await handler(
      event(
        'PUT',
        {
          prStrategy: 'pr-per-unit',
          nativeDebugArchivesEnabled: value,
          nativeDebugArchiveRetentionDays: 14,
        },
        'platform-admin',
      ),
    );
    expect(result.statusCode).toBe(400);
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it.each([0, -1, 1.5, '7', null, true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid retention %j before writing even an otherwise valid update',
    async (value) => {
      const result = await handler(
        event(
          'PUT',
          {
            prStrategy: 'pr-per-unit',
            nativeDebugArchivesEnabled: true,
            nativeDebugArchiveRetentionDays: value,
          },
          'platform-admin',
        ),
      );
      expect(result.statusCode).toBe(400);
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    },
  );

  it('reports failed persistence instead of claiming the preferences were saved', async () => {
    ssmMock.on(PutParameterCommand).rejects(new Error('Test store unavailable'));
    const result = await handler(
      event('PUT', { nativeDebugArchivesEnabled: false }, 'platform-admin'),
    );
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).not.toHaveProperty('saved', true);
  });
});

describe('personal agent credentials', () => {
  const personalEvent = (method, body) => ({
    ...event(method, body),
    path: '/users/me/agent-credentials',
  });

  it('returns set-state only for the authenticated user', async () => {
    credentialMetadataHandler = (request) => ({
      ok: true,
      status: {
        bedrockBearerTokenSet: request.source === 'user',
        kiroApiKeySet: false,
      },
    });
    const response = await handler(personalEvent('GET'));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      bedrockBearerTokenSet: true,
      kiroApiKeySet: false,
    });
    expect(ssmMock.commandCalls(GetParametersCommand)).toHaveLength(0);
  });

  it('writes and clears only the caller-scoped parameters', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    ssmMock.on(DeleteParameterCommand).resolves({});
    const response = await handler(
      personalEvent('PUT', {
        bedrockBearerToken: 'new-token',
        kiroApiKey: '',
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/dev/users/user-1/agent-credentials/bedrock-bearer-token',
      Value: 'new-token',
      Type: 'SecureString',
    });
    expect(ssmMock.commandCalls(DeleteParameterCommand)[0].args[0].input).toEqual({
      Name: '/collab/dev/users/user-1/agent-credentials/kiro-api-key',
    });
  });
});
