import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteParameterCommand,
  SSMClient,
  GetParameterCommand,
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
  // The account this deployment runs in. Set explicitly so a role ARN in the same
  // account is recognised as same-account and no external ID is generated
  // (dec-external-id-scope); without it the handler would fall back to
  // sts:GetCallerIdentity.
  process.env.PLATFORM_ACCOUNT_ID = '111122223333';
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
      // Phase 2 mode-aware fields: a user scope stays bearer-only
      // (dec-user-scope-role-deferred), so mode can never be role here.
      bedrockMode: null,
      bedrockExternalIdSet: false,
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

  // specs/bedrock-iam-role-credential-mode — req-role-credential-mode,
  // dec-user-scope-role-deferred. This endpoint is gated only on authentication,
  // so any member could otherwise name a role ARN for the platform to assume.
  it('rejects a role binding at user scope without writing SSM', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    const response = await handler(
      personalEvent('PUT', {
        bedrockBearerToken: JSON.stringify({
          roleArn: 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference',
        }),
      }),
    );
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('BEDROCK_ROLE_SCOPE_UNSUPPORTED');
    expect(body.error).toContain('user scope');
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('still accepts a bearer token at user scope', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    const response = await handler(
      personalEvent('PUT', { bedrockBearerToken: 'ABSKQmVkcm9jaw==' }),
    );
    expect(response.statusCode).toBe(200);
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input.Value).toBe(
      'ABSKQmVkcm9jaw==',
    );
  });
});

// specs/bedrock-iam-role-credential-mode — req-single-parameter-encoding.
// Validation lives on the write path so a malformed value can never reach a stage.
describe('platform bedrock role binding', () => {
  const ROLE_VALUE = JSON.stringify({
    roleArn: 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference',
  });

  it('stores a valid role binding in the existing bedrock parameter', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    const response = await handler(
      event('PUT', { bedrockBearerToken: ROLE_VALUE }, 'platform-admin'),
    );
    expect(response.statusCode).toBe(200);
    // No new SSM path and no new IAM pattern: the same parameter, a different value.
    expect(ssmMock.commandCalls(PutParameterCommand)[0].args[0].input).toMatchObject({
      Name: '/collab/dev/bedrock-bearer-token',
      Value: ROLE_VALUE,
      Type: 'SecureString',
      Overwrite: true,
    });
  });

  it.each([
    ['a non-IAM ARN', JSON.stringify({ roleArn: 'arn:aws:sts::111122223333:role/x' })],
    ['a short account id', JSON.stringify({ roleArn: 'arn:aws:iam::123:role/x' })],
    ['unparseable JSON', '{ "roleArn": '],
    [
      'an external id outside the STS charset',
      JSON.stringify({
        roleArn: 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference',
        externalId: 'has space',
      }),
    ],
  ])('rejects %s with a 400 and writes nothing', async (_label, value) => {
    ssmMock.on(PutParameterCommand).resolves({});
    const response = await handler(event('PUT', { bedrockBearerToken: value }, 'platform-admin'));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('BEDROCK_ROLE_BINDING_INVALID');
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('leaves the bearer path unchanged, including the placeholder clear', async () => {
    ssmMock.on(PutParameterCommand).resolves({});
    await handler(event('PUT', { bedrockBearerToken: 'ABSKQmVkcm9jaw==' }, 'platform-admin'));
    await handler(event('PUT', { bedrockBearerToken: '' }, 'platform-admin'));
    expect(
      ssmMock.commandCalls(PutParameterCommand).map((call) => call.args[0].input.Value),
    ).toEqual(['ABSKQmVkcm9jaw==', 'placeholder']);
  });
});

// specs/bedrock-iam-role-credential-mode — req-configured-semantics,
// req-external-id-lifecycle, req-same-and-cross-account.
//
// GET /agents/settings carries no platform-admin gate: any authenticated user can
// call it, which is deliberate because the UI needs to know whether credentials
// exist at all. Neither the external ID nor the role ARN may travel on it. Both
// are non-secret per dec-external-id-not-secret, but both are tenant-identifying
// and no lower-privilege surface needs them.
describe('the ungated settings read exposes no binding detail', () => {
  it('returns mode and set-state but neither the role ARN nor the external ID', async () => {
    const ROLE_ARN = 'arn:aws:iam::444455556666:role/aidlc-bedrock-cross';
    const EXTERNAL_ID = 'super-distinctive-external-id';
    credentialMetadataHandler = () => ({
      ok: true,
      // A broker that volunteers MORE than the reader should expose: the reader
      // must drop it rather than pass it through.
      status: {
        bedrockBearerTokenSet: false,
        kiroApiKeySet: false,
        bedrockMode: 'role',
        bedrockRoleArn: ROLE_ARN,
        bedrockExternalIdSet: true,
        externalId: EXTERNAL_ID,
      },
    });
    ssmMock.on(GetParametersCommand).resolves({ Parameters: [] });

    // No cognito:groups claim — an ordinary authenticated user.
    const response = await handler(event('GET'));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.bedrockMode).toBe('role');
    expect(body.bedrockExternalIdSet).toBe(true);
    expect(body.bedrockRoleArn).toBeUndefined();
    expect(response.body).not.toContain(ROLE_ARN);
    expect(response.body).not.toContain(EXTERNAL_ID);
  });
});

// specs/bedrock-iam-role-credential-mode — req-external-id-lifecycle,
// req-same-and-cross-account, req-configured-semantics.
//
// The bootstrap order is generate → surface → operator writes the trust policy →
// save → preflight, so the save response is what hands the operator the value they
// must paste. It is returned here because this route is platform-admin gated — the
// same principal that may overwrite the binding.
describe('platform cross-account role binding external ID', () => {
  const CROSS_ACCOUNT = 'arn:aws:iam::444455556666:role/aidlc-bedrock-inference';
  const externalIdPath = '/collab/dev/bedrock-external-id';
  const bindingPath = '/collab/dev/bedrock-bearer-token';

  const writtenByName = () =>
    Object.fromEntries(
      ssmMock
        .commandCalls(PutParameterCommand)
        .map(({ args }) => [args[0].input.Name, args[0].input]),
    );

  it('generates, stores and returns an external ID, and copies it into the binding', async () => {
    ssmMock
      .on(GetParameterCommand)
      .rejects(Object.assign(new Error('missing'), { name: 'ParameterNotFound' }));
    ssmMock.on(PutParameterCommand).resolves({});

    const response = await handler(
      event(
        'PUT',
        { bedrockBearerToken: JSON.stringify({ roleArn: CROSS_ACCOUNT }) },
        'platform-admin',
      ),
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.bedrockRoleArn).toBe(CROSS_ACCOUNT);
    expect(body.bedrockExternalId).toBeTruthy();

    const written = writtenByName();
    // Stored in its own parameter so it survives a rejected save, and copied into
    // the binding so the broker reads it at resolution time.
    expect(written[externalIdPath]).toMatchObject({ Type: 'SecureString' });
    expect(written[externalIdPath].Value).toBe(body.bedrockExternalId);
    expect(JSON.parse(written[bindingPath].Value)).toStrictEqual({
      roleArn: CROSS_ACCOUNT,
      externalId: body.bedrockExternalId,
    });
  });

  it('reuses the stored value on a later save rather than rotating it', async () => {
    // This is what makes the bootstrap converge: the operator writes the trust
    // policy against the first value, and the retry must present the same one.
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'already-generated-value' } });
    ssmMock.on(PutParameterCommand).resolves({});

    const response = await handler(
      event(
        'PUT',
        { bedrockBearerToken: JSON.stringify({ roleArn: CROSS_ACCOUNT }) },
        'platform-admin',
      ),
    );

    expect(JSON.parse(response.body).bedrockExternalId).toBe('already-generated-value');
    expect(writtenByName()[externalIdPath]).toBeUndefined();
    expect(JSON.parse(writtenByName()[bindingPath].Value).externalId).toBe(
      'already-generated-value',
    );
  });

  it('refuses a client-supplied external ID without writing anything', async () => {
    const response = await handler(
      event(
        'PUT',
        {
          bedrockBearerToken: JSON.stringify({
            roleArn: CROSS_ACCOUNT,
            externalId: 'operator-invented',
          }),
        },
        'platform-admin',
      ),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe('BEDROCK_EXTERNAL_ID_NOT_ACCEPTED');
    expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('returns the value to a platform admin on a later read, and to nobody else', async () => {
    credentialMetadataHandler = () => ({
      ok: true,
      status: {
        bedrockBearerTokenSet: false,
        kiroApiKeySet: false,
        bedrockMode: 'role',
        bedrockRoleArn: CROSS_ACCOUNT,
        bedrockExternalIdSet: true,
        // What the BINDING carries, i.e. what the broker will send to STS.
        bedrockExternalId: 'the-stored-external-id',
      },
    });
    ssmMock.on(GetParametersCommand).resolves({ Parameters: [] });
    // The staging parameter holds a DIFFERENT value on purpose. It is only the
    // pre-first-save bootstrap source, and it outlives a rebind to a role that
    // sends a different external ID or none at all — so once a binding exists the
    // binding wins, and reading the display off this parameter would hand the
    // operator an sts:ExternalId condition the binding can never satisfy.
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'stale-staged-value' } });

    const admin = JSON.parse((await handler(event('GET', undefined, 'platform-admin'))).body);
    expect(admin.bedrockExternalId).toBe('the-stored-external-id');
    expect(admin.bedrockRoleArn).toBe(CROSS_ACCOUNT);

    const ordinary = await handler(event('GET'));
    const body = JSON.parse(ordinary.body);
    expect(body.bedrockExternalIdSet).toBe(true);
    expect(body.bedrockExternalId).toBeUndefined();
    expect(body.bedrockRoleArn).toBeUndefined();
    expect(ordinary.body).not.toContain('the-stored-external-id');
    expect(ordinary.body).not.toContain(CROSS_ACCOUNT);
  });

  // The regression this pairs with: a scope rebound from a cross-account role to a
  // same-account one sends NO external ID, but the staging parameter survives. The
  // response must report null rather than the stale staged value.
  it('reports no external ID for a role binding that sends none, despite a staged value', async () => {
    credentialMetadataHandler = () => ({
      ok: true,
      status: {
        bedrockBearerTokenSet: false,
        kiroApiKeySet: false,
        bedrockMode: 'role',
        bedrockRoleArn: 'arn:aws:iam::111122223333:role/aidlc-bedrock-inference',
        bedrockExternalIdSet: false,
        bedrockExternalId: null,
      },
    });
    ssmMock.on(GetParametersCommand).resolves({ Parameters: [] });
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'stale-staged-value' } });

    const admin = JSON.parse((await handler(event('GET', undefined, 'platform-admin'))).body);
    expect(admin.bedrockExternalId).toBeNull();
    expect(JSON.stringify(admin)).not.toContain('stale-staged-value');
  });
});

// specs/bedrock-iam-role-credential-mode — req-binding-preflight.
//
// Saving a role binding attempts an AssumeRole through the broker and refuses to
// persist a binding that cannot be assumed, converting a mid-stage failure into an
// input-validation error.
describe('platform role binding preflight', () => {
  const CROSS_ACCOUNT = 'arn:aws:iam::444455556666:role/aidlc-bedrock-inference';
  const saveRole = () =>
    handler(
      event(
        'PUT',
        { bedrockBearerToken: JSON.stringify({ roleArn: CROSS_ACCOUNT }) },
        'platform-admin',
      ),
    );

  beforeEach(() => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'stable-external-id' } });
    ssmMock.on(PutParameterCommand).resolves({});
  });

  it('refuses to persist a binding the broker cannot assume, and still returns the external ID', async () => {
    credentialMetadataHandler = (request) =>
      request.action === 'preflight-bedrock-role-binding'
        ? {
            ok: true,
            preflight: {
              ok: false,
              cause: 'trust-policy-rejected',
              sessionName: 'aidlc-preflight',
              candidates: [{ candidate: 'principal-not-trusted', detail: 'trust the broker' }],
            },
          }
        : { ok: true, status: { bedrockBearerTokenSet: false, kiroApiKeySet: false } };

    const response = await saveRole();

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.code).toBe('BEDROCK_ROLE_PREFLIGHT_FAILED');
    expect(body.preflight.cause).toBe('trust-policy-rejected');
    // The binding itself must NOT be persisted.
    const written = ssmMock.commandCalls(PutParameterCommand).map(({ args }) => args[0].input.Name);
    expect(written).not.toContain('/collab/dev/bedrock-bearer-token');
    // But the external ID must still come back: the operator cannot write the very
    // trust policy this preflight is checking until they have it, and it is stable
    // across retries so their trust policy stays valid.
    expect(body.bedrockExternalId).toBe('stable-external-id');
  });

  it('persists the binding when the preflight passes', async () => {
    credentialMetadataHandler = (request) =>
      request.action === 'preflight-bedrock-role-binding'
        ? { ok: true, preflight: { ok: true, cause: 'ok', sessionName: 'aidlc-preflight' } }
        : { ok: true, status: { bedrockBearerTokenSet: false, kiroApiKeySet: false } };

    const response = await saveRole();

    expect(response.statusCode).toBe(200);
    expect(
      ssmMock.commandCalls(PutParameterCommand).map(({ args }) => args[0].input.Name),
    ).toContain('/collab/dev/bedrock-bearer-token');
  });

  it('persists the binding when the preflight itself could not run', async () => {
    // Fail-open, deliberately: the preflight is an input check, not a security
    // control. Resolution re-checks the binding on every stage, so refusing a
    // legitimate save because the checker is unreachable would be the worse failure.
    credentialMetadataHandler = (request) => {
      if (request.action === 'preflight-bedrock-role-binding') return { ok: false, code: 'BOOM' };
      return { ok: true, status: { bedrockBearerTokenSet: false, kiroApiKeySet: false } };
    };

    const response = await saveRole();

    expect(response.statusCode).toBe(200);
    expect(
      ssmMock.commandCalls(PutParameterCommand).map(({ args }) => args[0].input.Name),
    ).toContain('/collab/dev/bedrock-bearer-token');
  });
});
