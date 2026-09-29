import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { handler } from '../index.js';
import { authorizeAgentCredentialRequest } from '../agent-authentication.js';
import {
  BASE_AGENT_CREDENTIAL_ERROR_CODES,
  RESOLVE_AGENT_CREDENTIALS,
  createAgentProviderContext,
  createBrokerProviderRegistry,
  isAgentCredentialAction,
  loggableAgentCredentialErrorCode,
} from '../agent-provider-registry.js';
import { KEY_BROKER_PROVIDER } from '../key-broker-provider.js';
import { signRenewal, verifyRenewal } from '../agent-credential-renewal.js';
import { apiKeyLease } from '../../shared/agent-credential-lease.js';
import {
  AGENT_CREDENTIAL_GRANT_AUDIENCE,
  signAgentCredentialGrant,
  signCredentialToken,
  verifyAgentCredentialGrant,
} from '../../shared/agent-credential-grants.js';
import { normalizeConnection } from '../../shared/agent-auth-contracts.js';
import { createAuthModeRegistry } from '../../shared/agent-auth-mode-registry.js';
import { legacyConnection } from '../../shared/agent-connection-repository.js';
import { connectionBinding } from '../../shared/agent-binding-selection.js';
import { TEST_CONNECTION_MODE } from '../../shared/test/helpers/auth-modes.js';
import {
  FIXTURE_ADAPTER_KEY,
  FIXTURE_BROKER_PROVIDER,
  FIXTURE_DENIED,
  FIXTURE_MATERIAL_TYPE,
  FIXTURE_RENEWAL,
  createFixtureBrokerProvider,
} from './helpers/fixture-broker-provider.js';

vi.mock('../../shared/agent-auth-modes.js', async (importOriginal) =>
  (await import('../../shared/test/helpers/auth-modes.js')).withAuthModes(importOriginal),
);
vi.mock('../agent-broker-providers.js', async (importOriginal) =>
  (await import('./helpers/fixture-broker-provider.js')).withBrokerProviders(importOriginal),
);

const SECRET = 'fixture-signing-secret-'.repeat(3);
const START = Date.parse('2026-09-24T10:00:00Z');
const MINUTE = 60_000;
const CEILING = START + FIXTURE_RENEWAL.ttlSeconds * 1000;
const INVALID = 'AGENT_CREDENTIAL_GRANT_INVALID';
const connection = normalizeConnection({
  id: 'test-1',
  revision: 1,
  mode: TEST_CONNECTION_MODE.id,
  backend: TEST_CONNECTION_MODE.backend,
  mechanism: TEST_CONNECTION_MODE.mechanisms[0],
  source: 'space',
  projectId: 'p',
  configuration: { region: 'eu-west-1' },
});
const binding = connectionBinding(connection, 3);
const kiro = connectionBinding(legacyConnection('legacy-space-kiro-p'), 3);
const kiroCredential = { lease: apiKeyLease('kiro-key'), binding: kiro, value: 'kiro-key' };

const rowFor = ({ pk, sk }, state = 'ready') => {
  if (pk === 'AGENTAUTH#POLICY')
    return { mode: 'keys', revision: 4, defaultConnectionId: 'legacy-platform-bedrock' };
  if (pk === 'EXEC#e') return { projectId: 'p', credentialBinding: binding, status: 'RUNNING' };
  if (pk === `AGENTAUTH#CONNECTION#${connection.id}`)
    return { ...connection, state: sk === 'META' ? state : 'ready' };
  return undefined;
};
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
const denied = () =>
  Object.assign(new Error('User: arn:aws:sts::111111111111:assumed-role/x is not authorized'), {
    name: 'AccessDeniedException',
  });
const failing = { issue: async () => Promise.reject(denied()) };

// tokenClient: undefined injects a recording client per request; null leaves the provider's own.
const harness = ({ registry, tokenClient, ssmSend } = {}) => {
  let time = START;
  let state = 'ready';
  const issue = vi.fn(async () => ({ token: 'inert-token', expiresAt: time + 15 * MINUTE }));
  const ddbClient = { send: vi.fn(async ({ input }) => ({ Item: rowFor(input.Key, state) })) };
  const ssmClient = {
    send: vi.fn(ssmSend ?? (async () => ({ Parameter: { Value: 'kiro-key' } }))),
  };
  const client = tokenClient === undefined ? { issue } : tokenClient;
  const deps = (extra) => ({
    ddbClient,
    ssmClient,
    secret: SECRET,
    env: { V2_PROCESS_TABLE: 'process', AGENT_SETTINGS_SSM_PREFIX: '/app' },
    now: () => time,
    ...(client ? { tokenClient: client } : {}),
    ...(registry ? { registry } : {}),
    ...extra,
  });
  const authorize = (event, extra = {}) => authorizeAgentCredentialRequest(event, deps(extra));
  return {
    issue,
    ssmClient,
    authorize,
    renew: (token, extra) =>
      authorize({ action: FIXTURE_RENEWAL.action, [FIXTURE_RENEWAL.tokenField]: token }, extra),
    grant: (purpose, bindings = [binding]) =>
      signAgentCredentialGrant(
        { purpose, projectId: 'p', executionId: purpose === 'execution' ? 'e' : null, bindings },
        SECRET,
        { now: () => START, randomId: () => 'grant-fixture-0001' },
      ),
    advance: (ms) => {
      time += ms;
    },
    revoke: () => {
      state = 'revoked';
    },
  };
};

describe('host-owned renewal and lease composition', () => {
  it('mints a binding-scoped renewal token that preserves grantId beside a keys binding', async () => {
    const h = harness();
    const [fixture, key] = (await h.authorize({ grant: h.grant('capabilities', [kiro, binding]) }))
      .credentials;

    const token = fixture.lease.renewal.grant;
    expect(fixture).toEqual({
      testRenewalToken: token,
      lease: {
        version: 1,
        material: { type: FIXTURE_MATERIAL_TYPE, token: 'inert-token' },
        expiresAt: START + 15 * MINUTE,
        authorizationExpiresAt: CEILING,
        renewal: { grant: token, action: FIXTURE_RENEWAL.action, tokenField: 'grant' },
      },
      binding,
    });
    expect(claimsOf(token)).toEqual({
      version: 2,
      audience: FIXTURE_RENEWAL.audience,
      grantId: 'grant-fixture-0001',
      purpose: 'capabilities',
      projectId: 'p',
      executionId: null,
      bindings: [binding],
      issuedAt: START / 1000,
      expiresAt: START / 1000 + FIXTURE_RENEWAL.ttlSeconds,
    });
    expect(key).toEqual(kiroCredential);
    expect(h.issue).toHaveBeenCalledExactlyOnceWith({
      connectionId: 'test-1',
      grantId: 'grant-fixture-0001',
      request: 'resolve',
    });
  });

  it('renews with the presented token under the authorization deadline fixed at handoff', async () => {
    const h = harness();
    const grant = h.grant('execution');
    const token = (await h.authorize({ grant })).credentials[0].lease.renewal.grant;
    h.advance(20 * MINUTE);
    await expect(h.authorize({ grant })).rejects.toMatchObject({
      code: 'AGENT_CREDENTIAL_GRANT_EXPIRED',
    });

    const renewed = await h.renew(token);
    expect(renewed).toMatchObject({ purpose: 'execution', projectId: 'p', executionId: 'e' });
    expect(renewed.credentials).toEqual([
      {
        testRenewalToken: token,
        lease: {
          version: 1,
          material: { type: FIXTURE_MATERIAL_TYPE, token: 'inert-token' },
          expiresAt: START + 35 * MINUTE,
          authorizationExpiresAt: CEILING,
          renewal: { grant: token, action: FIXTURE_RENEWAL.action, tokenField: 'grant' },
        },
        binding,
      },
    ]);
    expect(h.issue).toHaveBeenLastCalledWith(expect.objectContaining({ request: 'renew' }));

    h.advance(30 * MINUTE);
    const late = (await h.renew(token)).credentials[0].lease;
    expect(late.renewal.grant).toBe(token);
    expect(late.authorizationExpiresAt).toBe(CEILING);
    expect(late.expiresAt).toBe(CEILING);

    h.advance(10 * MINUTE);
    await expect(h.renew(token)).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_EXPIRED' });
    expect(h.issue).toHaveBeenCalledTimes(3);
  });

  it('keeps handoff and renewal audiences apart and rejects tampered or revoked renewals', async () => {
    const h = harness();
    const grant = h.grant('execution');
    const token = (await h.authorize({ grant })).credentials[0].lease.renewal.grant;

    await expect(h.authorize({ grant: token })).rejects.toMatchObject({ code: INVALID });
    await expect(h.renew(grant)).rejects.toMatchObject({ code: INVALID });
    expect(() => verifyAgentCredentialGrant(token, SECRET, { now: () => START })).toThrow();
    const policy = FIXTURE_RENEWAL;
    expect(() =>
      verifyRenewal({ token: grant, key: SECRET, policy, owns: () => true, now: () => START }),
    ).toThrow();

    const claims = claimsOf(token);
    claims.bindings[0].configuration.region = 'eu-north-1';
    const tampered = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${token.split('.')[1]}`;
    await expect(h.renew(tampered)).rejects.toMatchObject({ code: INVALID });

    h.revoke();
    await expect(h.renew(token)).rejects.toMatchObject({
      code: 'AGENT_AUTH_CONNECTION_UNAVAILABLE',
    });
    expect(h.issue).toHaveBeenCalledOnce();
  });

  it('renews only a single binding owned by the renewing provider', async () => {
    const h = harness();
    const claims = verifyAgentCredentialGrant(h.grant('capabilities', [kiro, binding]), SECRET, {
      now: () => START,
    });
    const policy = FIXTURE_RENEWAL;
    const foreign = signRenewal({ claims, binding: kiro, policy, key: SECRET });
    const both = signCredentialToken(
      { ...claims, expiresAt: claims.issuedAt + policy.ttlSeconds },
      SECRET,
      policy.audience,
    );

    for (const token of [foreign, both])
      await expect(h.renew(token)).rejects.toMatchObject({ code: INVALID });
    expect(() =>
      signRenewal({ claims, binding: { provider: 'kiro', source: 'space' }, policy, key: SECRET }),
    ).toThrow();
    expect(h.ssmClient.send).not.toHaveBeenCalled();
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('creates provider dependencies lazily, once, beneath per-request overrides', async () => {
    const issue = vi.fn(async () => ({ token: 'from-dependencies', expiresAt: null }));
    const createDependencies = vi.fn(() => ({ tokenClient: { issue } }));
    const registry = createBrokerProviderRegistry([
      KEY_BROKER_PROVIDER,
      createFixtureBrokerProvider({ createDependencies }),
    ]);
    const h = harness({ registry, tokenClient: null });

    await h.authorize({ grant: h.grant('discussion', [kiro]) });
    expect(createDependencies).not.toHaveBeenCalled();

    const first = (await h.authorize({ grant: h.grant('execution') })).credentials[0].lease;
    expect(first.material.token).toBe('from-dependencies');
    const override = { issue: vi.fn(async () => ({ token: 'per-request', expiresAt: null })) };
    const renewed = (await h.renew(first.renewal.grant, { tokenClient: override })).credentials[0];
    expect(renewed.lease.material.token).toBe('per-request');
    expect(createDependencies).toHaveBeenCalledOnce();
    expect(issue).toHaveBeenCalledOnce();
  });
});

describe('adapter results', () => {
  const withProvider = (overrides) =>
    harness({
      registry: createBrokerProviderRegistry([
        KEY_BROKER_PROVIDER,
        createFixtureBrokerProvider(overrides),
      ]),
    });
  const withAdapter = (adapter) => withProvider({ adapters: { [FIXTURE_ADAPTER_KEY]: adapter } });
  const material = { type: FIXTURE_MATERIAL_TYPE, token: 'inert-token' };

  it('mints no renewal authority for null material', async () => {
    const h = withAdapter(async () => ({ material: null }));
    expect((await h.authorize({ grant: h.grant('execution') })).credentials).toEqual([
      {
        testRenewalToken: null,
        lease: {
          version: 1,
          material: null,
          expiresAt: CEILING,
          authorizationExpiresAt: CEILING,
          renewal: null,
        },
        binding,
        value: null,
      },
    ]);
  });

  // The host composes renewal and the authorization deadline, so a provider cannot supply either.
  it.each([
    ['no result', undefined],
    ['neither lease nor material', {}],
    [
      'a lease with renewal authority',
      {
        lease: {
          version: 1,
          material,
          expiresAt: START + 15 * MINUTE,
          authorizationExpiresAt: CEILING,
          renewal: { grant: 'provider-token' },
        },
      },
    ],
    [
      'a lease with an authorization deadline',
      { lease: { version: 1, material, expiresAt: null, authorizationExpiresAt: CEILING } },
    ],
  ])('refuses an adapter returning %s', async (_, result) => {
    const h = withAdapter(async () => result);
    await expect(h.authorize({ grant: h.grant('execution') })).rejects.toMatchObject({
      code: 'AGENT_AUTH_LEASE_INVALID',
    });
  });

  it.each(['binding', 'lease', 'value', 'error'])(
    'refuses a legacyResponse that sets %s',
    async (field) => {
      const h = withProvider({ legacyResponse: () => ({ [field]: 'provider-value' }) });
      await expect(h.authorize({ grant: h.grant('execution') })).rejects.toMatchObject({
        code: 'AGENT_AUTH_LEASE_INVALID',
      });
    },
  );
});

describe('provider error scoping', () => {
  it("maps the owning adapter's error to its declared code without provider text", async () => {
    const h = harness({ tokenClient: failing });
    const error = await h.authorize({ grant: h.grant('execution') }).catch((thrown) => thrown);
    expect(error.code).toBe(FIXTURE_DENIED);
    expect(error.message).not.toContain('arn:aws');
    expect(loggableAgentCredentialErrorCode(error)).toBe(FIXTURE_DENIED);
  });

  it('leaves SSM denials on key and signing-key reads unclassified', async () => {
    const h = harness({ ssmSend: async () => Promise.reject(denied()) });
    const keyRead = await h
      .authorize({ grant: h.grant('capabilities', [kiro, binding]) })
      .catch((thrown) => thrown);
    const signingKeyRead = await h
      .authorize(
        { grant: h.grant('execution') },
        { secret: null, env: { AGENT_CREDENTIAL_GRANT_SECRET_PARAM: '/app/grant-secret' } },
      )
      .catch((thrown) => thrown);
    for (const error of [keyRead, signingKeyRead]) {
      expect(error.name).toBe('AccessDeniedException');
      expect(loggableAgentCredentialErrorCode(error)).toBe('AGENT_CREDENTIAL_BROKER_FAILED');
    }
  });

  it('falls back when a classifier names a code the provider did not declare', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    const h = harness({ tokenClient: { issue: async () => Promise.reject(throttled) } });
    await expect(h.authorize({ grant: h.grant('execution') })).rejects.toBe(throttled);
    expect(loggableAgentCredentialErrorCode(throttled)).toBe('AGENT_CREDENTIAL_BROKER_FAILED');
  });
});

describe('capability discovery isolation', () => {
  it('isolates an opted-in provider only for the capabilities purpose', async () => {
    const h = harness({ tokenClient: failing });
    expect(
      (await h.authorize({ grant: h.grant('capabilities', [kiro, binding]) })).credentials,
    ).toEqual([{ binding, error: FIXTURE_DENIED }, kiroCredential]);
    for (const purpose of ['execution', 'compose', 'discussion'])
      await expect(h.authorize({ grant: h.grant(purpose) })).rejects.toMatchObject({
        code: FIXTURE_DENIED,
      });
  });

  it('never isolates a renewal', async () => {
    const h = harness();
    const [fixture] = (await h.authorize({ grant: h.grant('capabilities', [kiro, binding]) }))
      .credentials;
    await expect(
      h.renew(fixture.lease.renewal.grant, { tokenClient: failing }),
    ).rejects.toMatchObject({ code: FIXTURE_DENIED });
  });

  it('fails closed for providers that do not opt in', async () => {
    const registry = createBrokerProviderRegistry([
      KEY_BROKER_PROVIDER,
      createFixtureBrokerProvider({ isolateCapabilityFailures: false }),
    ]);
    const optedOut = harness({ registry, tokenClient: failing });
    await expect(
      optedOut.authorize({ grant: optedOut.grant('capabilities', [kiro, binding]) }),
    ).rejects.toMatchObject({ code: FIXTURE_DENIED });
    const keys = harness({ ssmSend: async () => Promise.reject(new Error('SSM unavailable')) });
    await expect(
      keys.authorize({ grant: keys.grant('capabilities', [kiro, binding]) }),
    ).rejects.toThrow('SSM unavailable');
  });
});

describe('broker provider registry', () => {
  const second = (overrides = {}) =>
    createFixtureBrokerProvider({
      id: 'second-provider',
      adapters: { 'litellm:oauth-machine': async () => ({ material: null }) },
      renewal: {
        ...FIXTURE_RENEWAL,
        action: 'renew-second-credentials',
        audience: 'aidlc-second-renewal',
      },
      errorCodes: ['SECOND_PROVIDER_DENIED'],
      ...overrides,
    });

  it('composes providers with disjoint registrations', () => {
    const registry = createBrokerProviderRegistry([
      KEY_BROKER_PROVIDER,
      FIXTURE_BROKER_PROVIDER,
      second(),
    ]);
    expect(registry.errorCodes).toEqual([
      ...BASE_AGENT_CREDENTIAL_ERROR_CODES,
      FIXTURE_DENIED,
      'SECOND_PROVIDER_DENIED',
    ]);
    expect(registry.renewalProvider('renew-second-credentials').id).toBe('second-provider');
    expect(registry.renewalProvider(RESOLVE_AGENT_CREDENTIALS)).toBeNull();
    expect(registry.ownerOf(binding).id).toBe('test-provider');
    expect(registry.ownerOf(kiro).id).toBe('keys');
    expect(registry.ownerOf({ provider: 'kiro', source: 'space' })).toBeNull();
    expect(Object.keys(FIXTURE_BROKER_PROVIDER.adapters)).toEqual([FIXTURE_ADAPTER_KEY]);
  });

  const renewal = (overrides) => ({ renewal: { ...FIXTURE_RENEWAL, ...overrides } });
  it.each([
    [
      'a duplicate provider id',
      [FIXTURE_BROKER_PROVIDER, second({ id: 'test-provider' })],
      /test-provider is registered twice/,
    ],
    [
      'a duplicate adapter key',
      [KEY_BROKER_PROVIDER, second({ adapters: KEY_BROKER_PROVIDER.adapters })],
      /bedrock:api-key is registered twice/,
    ],
    [
      'a duplicate renewal action',
      [FIXTURE_BROKER_PROVIDER, second(renewal({ audience: 'aidlc-second-renewal' }))],
      /renew-test-credentials is registered twice/,
    ],
    [
      'a duplicate renewal audience',
      [FIXTURE_BROKER_PROVIDER, second(renewal({ action: 'renew-second-credentials' }))],
      /aidlc-test-renewal is registered twice/,
    ],
    [
      'a duplicate error code',
      [FIXTURE_BROKER_PROVIDER, second({ errorCodes: [FIXTURE_DENIED] })],
      /TEST_PROVIDER_DENIED is already declared/,
    ],
    ['a redeclared base code', [second({ errorCodes: [INVALID] })], /already declared/],
    [
      'the broker failure code',
      [second({ errorCodes: ['AGENT_CREDENTIAL_BROKER_FAILED'] })],
      /already declared/,
    ],
    [
      'renewal on the resolve action',
      [second(renewal({ action: RESOLVE_AGENT_CREDENTIALS }))],
      /reserved action/,
    ],
    [
      'renewal on the source-control action',
      [second(renewal({ action: 'source-control' }))],
      /reserved action/,
    ],
    [
      'the grant audience for renewal',
      [second(renewal({ audience: AGENT_CREDENTIAL_GRANT_AUDIENCE }))],
      /distinct from the grant audience/,
    ],
    [
      'an unbounded renewal lifetime',
      [second(renewal({ ttlSeconds: 86_401 }))],
      /renewal lifetime/,
    ],
    ['a zero renewal lifetime', [second(renewal({ ttlSeconds: 0 }))], /renewal lifetime/],
    ['an unsupported token field', [second(renewal({ tokenField: 'token' }))], /token field/],
    [
      'an unknown mechanism',
      [second({ adapters: { 'litellm:password': async () => ({}) } })],
      /unknown mechanism/,
    ],
    ['a misspelled field', [second({ isolateCapabilityFailure: true })], /unsupported fields/],
    ['a classifier without codes', [second({ errorCodes: [] })], /without declaring codes/],
  ])('rejects %s', (_, providers, message) => {
    expect(() => createBrokerProviderRegistry(providers)).toThrow(message);
  });

  it('refuses unknown actions and tokens outside the declared field before loading the key', async () => {
    const ssmClient = { send: vi.fn() };
    const env = { AGENT_CREDENTIAL_GRANT_SECRET_PARAM: '/app/grant-secret' };
    for (const event of [
      { action: 'renew-unknown-credentials', grant: 'token' },
      { action: FIXTURE_RENEWAL.action, renewalToken: 'token' },
    ])
      await expect(createAgentProviderContext(event, { ssmClient, env })).rejects.toMatchObject({
        code: INVALID,
      });
    expect(ssmClient.send).not.toHaveBeenCalled();
  });
});

describe('the unchanged Lambda entry point', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const ssmMock = mockClient(SSMClient);
  beforeEach(() => {
    ddbMock.reset();
    ssmMock.reset();
    vi.stubEnv('AGENT_CREDENTIAL_GRANT_SECRET', SECRET);
    vi.stubEnv('V2_PROCESS_TABLE', 'process');
    vi.stubEnv('AGENT_SETTINGS_SSM_PREFIX', '/app');
    ddbMock.on(GetCommand).callsFake((input) => ({ Item: rowFor(input.Key) }));
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'kiro-key' } });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes a provider-declared renewal action and reports its declared codes', async () => {
    expect(isAgentCredentialAction(RESOLVE_AGENT_CREDENTIALS)).toBe(true);
    expect(isAgentCredentialAction(FIXTURE_RENEWAL.action)).toBe(true);
    expect(isAgentCredentialAction('source-control')).toBe(false);
    const grant = signAgentCredentialGrant(
      { purpose: 'capabilities', projectId: 'p', bindings: [kiro, binding] },
      SECRET,
    );

    const resolved = await handler({ action: RESOLVE_AGENT_CREDENTIALS, grant });
    expect(resolved).toMatchObject({ ok: true, credentials: [{ binding }, kiroCredential] });
    const token = resolved.credentials[0].lease.renewal.grant;
    expect(await handler({ action: FIXTURE_RENEWAL.action, grant: token })).toMatchObject({
      ok: true,
      purpose: 'capabilities',
      credentials: [
        { binding, lease: { material: { token: 'token-test-1' }, renewal: { grant: token } } },
      ],
    });
    expect(await handler({ action: FIXTURE_RENEWAL.action, grant })).toEqual({
      ok: false,
      code: INVALID,
    });
    expect(loggableAgentCredentialErrorCode({ code: FIXTURE_DENIED })).toBe(FIXTURE_DENIED);
  });
});

describe('registration invariants over the real roots', () => {
  it('gives every available shared mode a broker adapter for each of its mechanisms', async () => {
    const { AGENT_AUTH_MODE_DESCRIPTORS } = await vi.importActual(
      '../../shared/agent-auth-modes.js',
    );
    const { AGENT_BROKER_PROVIDERS } = await vi.importActual('../agent-broker-providers.js');
    const registry = createBrokerProviderRegistry(AGENT_BROKER_PROVIDERS);
    const available = createAuthModeRegistry(AGENT_AUTH_MODE_DESCRIPTORS).catalog.filter(
      (mode) => mode.available,
    );
    expect(available.length).toBeGreaterThan(0);
    for (const { id, backend, mechanisms } of available)
      for (const mechanism of mechanisms)
        expect(
          registry.ownerOf({ version: 2, backend, mechanism }),
          `${id} ${mechanism}`,
        ).not.toBeNull();
    // Kiro keys are an uncatalogued pseudo-mode that stays redeemable.
    expect(registry.ownerOf({ version: 2, backend: 'kiro', mechanism: 'api-key' })).not.toBeNull();
  });
});
