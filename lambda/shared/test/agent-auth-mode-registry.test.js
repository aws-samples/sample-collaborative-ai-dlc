import { describe, expect, it } from 'vitest';
import { AUTH_MECHANISMS } from '../agent-auth-protocol.js';
import {
  createAuthModeRegistry,
  defineAuthMode,
  normalizeConfigurationFields,
} from '../agent-auth-mode-registry.js';
import {
  KEYS_MODE,
  PLANNED_IAM_MODE,
  PLANNED_LITELLM_MODE,
  normalizeKiroConfiguration,
} from '../agent-auth-builtin-modes.js';
import { AGENT_AUTH_MODE_DESCRIPTORS } from '../agent-auth-modes.js';
import { AGENT_AUTH_MODES_CATALOG, authModeDescriptor } from '../agent-auth-providers.js';
import { bindingIdentity, normalizeConnection } from '../agent-auth-contracts.js';
import { normalizeAuthAction } from '../agent-auth-actions.js';
import { DEFAULT_AUTH_POLICY, normalizeAuthPolicy } from '../agent-connection-repository.js';

const mode = (overrides = {}) => ({
  id: 'fixture-mode',
  label: 'Fixture',
  backend: 'bedrock',
  mechanisms: ['oauth-machine'],
  normalizeConfiguration: (configuration) =>
    normalizeConfigurationFields(configuration, { region: 'string' }),
  ...overrides,
});
const failure = (evaluate) => {
  try {
    evaluate();
  } catch ({ code, message }) {
    return { code, message };
  }
  return null;
};
const invalid = (message) => ({ code: 'AGENT_AUTH_INVALID', message });
const ROLE_ARN = 'arn:aws:iam::123456789012:role/aidlc-bedrock';

describe('normalizeConfigurationFields', () => {
  const fields = { region: 'string', endpoint: 'endpoint', scopes: 'scopes' };

  it('trims strings, normalizes endpoints and scopes, and keeps the input key order', () => {
    const out = normalizeConfigurationFields(
      { scopes: ['b', 'a', 'b'], endpoint: 'https://gw.example.com/v1/', region: ' eu-west-1 ' },
      fields,
    );
    expect(JSON.stringify(out)).toBe(
      '{"scopes":["a","b"],"endpoint":"https://gw.example.com/v1","region":"eu-west-1"}',
    );
    expect(normalizeConfigurationFields(undefined, fields)).toEqual({});
  });

  it('rejects the shape before any field value', () => {
    for (const configuration of [null, [], 'region', { region: '', accessToken: 'secret' }]) {
      expect(failure(() => normalizeConfigurationFields(configuration, fields))).toEqual(
        invalid('Connection configuration contains unsupported fields'),
      );
    }
    // Inherited keys of the field table are not declarations.
    expect(
      failure(() => normalizeConfigurationFields({ toString: 'x' }, { region: 'string' })),
    ).toEqual(invalid('Connection configuration contains unsupported fields'));
  });

  it('names the first invalid field in input order', () => {
    expect(failure(() => normalizeConfigurationFields({ region: ' ' }, fields))).toEqual(
      invalid('region is invalid'),
    );
    expect(
      failure(() => normalizeConfigurationFields({ endpoint: 7, region: '' }, fields)),
    ).toEqual(invalid('endpoint is invalid'));
    expect(
      failure(() => normalizeConfigurationFields({ endpoint: 'http://gw.example.com' }, fields)),
    ).toEqual(invalid('endpoint must be an HTTPS URL without credentials, query or fragment'));
    for (const scopes of ['a', ['a', ''], ['a', 1]]) {
      expect(failure(() => normalizeConfigurationFields({ scopes }, fields))).toEqual(
        invalid('OAuth scopes are invalid'),
      );
    }
  });

  it('refuses an undeclared field kind', () => {
    expect(() => normalizeConfigurationFields({}, { region: 'text' })).toThrow(TypeError);
  });
});

describe('defineAuthMode and createAuthModeRegistry', () => {
  it('freezes a validated descriptor', () => {
    const descriptor = defineAuthMode(mode({ defaultConnectionId: 'fixture-platform' }));
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.mechanisms)).toBe(true);
    expect(descriptor).toMatchObject({ id: 'fixture-mode', planned: false });
    expect(descriptor.defaultConnectionId).toBe('fixture-platform');
    expect(descriptor.normalizeConfiguration({ region: ' r ' }, { mechanism: 'x' })).toEqual({
      region: 'r',
    });
  });

  it.each([
    ['an invalid id', { id: 'bad id' }, 'Authentication mode id is invalid'],
    ['a missing label', { label: ' ' }, 'requires a label'],
    ['an invalid backend', { backend: '' }, 'backend is invalid'],
    ['no mechanisms', { mechanisms: [] }, 'known authentication mechanisms'],
    ['an unknown mechanism', { mechanisms: ['password'] }, 'known authentication mechanisms'],
    ['a repeated mechanism', { mechanisms: ['api-key', 'api-key'] }, 'unique'],
    ['a non-boolean planned flag', { planned: 'yes' }, 'non-boolean planned'],
    ['a misspelled planned flag', { plannned: true }, 'unsupported fields: plannned'],
    ['unknown model discovery', { modelDiscovery: 'control-plane' }, 'model discovery'],
    ['an invalid default connection', { defaultConnectionId: 'a b' }, 'defaultConnectionId'],
    [
      'a missing normalizeConfiguration',
      { normalizeConfiguration: undefined },
      'normalizeConfiguration',
    ],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => defineAuthMode(mode(overrides))).toThrow(message);
    expect(() => createAuthModeRegistry([mode(overrides)])).toThrow(message);
  });

  it('rejects duplicate ids and a non-list', () => {
    expect(() => createAuthModeRegistry([mode(), mode({ label: 'Other' })])).toThrow(
      'Authentication mode fixture-mode is registered twice',
    );
    expect(() => createAuthModeRegistry({ keys: KEYS_MODE })).toThrow('must be a list');
  });

  it('projects a catalog in registration order with availability from planned', () => {
    const registry = createAuthModeRegistry([
      mode({ id: 'second', planned: true, modelDiscovery: 'runtime' }),
      mode({ id: 'first', defaultConnectionId: 'first-platform' }),
    ]);
    expect(registry.catalog).toStrictEqual([
      {
        id: 'second',
        label: 'Fixture',
        backend: 'bedrock',
        mechanisms: ['oauth-machine'],
        available: false,
        modelDiscovery: 'runtime',
      },
      {
        id: 'first',
        label: 'Fixture',
        backend: 'bedrock',
        mechanisms: ['oauth-machine'],
        available: true,
      },
    ]);
    expect(Object.isFrozen(registry.catalog)).toBe(true);
    expect(registry.catalog.every(Object.isFrozen)).toBe(true);
    expect(registry.get('first').defaultConnectionId).toBe('first-platform');
    for (const id of ['missing', 'constructor', '__proto__', null, undefined]) {
      expect(registry.get(id)).toBeNull();
    }
  });
});

describe('built-in modes', () => {
  it('serves the keys default connection the repository seeds', () => {
    expect(KEYS_MODE.defaultConnectionId).toBe(DEFAULT_AUTH_POLICY.defaultConnectionId);
    expect(
      KEYS_MODE.normalizeConfiguration({ region: ' eu-west-1 ' }, { mechanism: 'api-key' }),
    ).toEqual({ region: 'eu-west-1' });
  });

  it('normalizes kiro configuration as region-only', () => {
    expect(normalizeKiroConfiguration({ region: ' eu-west-1 ' })).toEqual({ region: 'eu-west-1' });
    expect(normalizeKiroConfiguration(undefined)).toEqual({});
    expect(failure(() => normalizeKiroConfiguration({ roleArn: ROLE_ARN }))).toEqual(
      invalid('Connection configuration contains unsupported fields'),
    );
  });

  it('routes only kiro api-key connections through the kiro normalizer', () => {
    const kiro = {
      id: 'kiro-platform',
      revision: 3,
      backend: 'kiro',
      mechanism: 'api-key',
      source: 'platform',
    };
    for (const declaredMode of [undefined, 'kiro']) {
      expect(
        normalizeConnection({
          ...kiro,
          mode: declaredMode,
          configuration: { region: ' eu-west-1 ' },
        }),
      ).toMatchObject({ mode: 'kiro', configuration: { region: 'eu-west-1' } });
    }
    expect(failure(() => normalizeConnection({ ...kiro, configuration: { bad: 1 } }))).toEqual(
      invalid('Connection configuration contains unsupported fields'),
    );
    // assume-role allows the platform scope, so only the mechanism check refuses it.
    expect(
      failure(() =>
        normalizeConnection({
          ...kiro,
          mechanism: 'assume-role',
          configuration: { region: 'eu-west-1' },
        }),
      ),
    ).toEqual(invalid('Connection backend and authentication mechanism do not match its mode'));
    // Byte-identical to the identity the pre-registry normalizer produced.
    expect(
      bindingIdentity({
        version: 2,
        provider: 'kiro',
        source: 'space',
        projectId: 'p1',
        connectionId: 'kiro-space',
        connectionRevision: 3,
        policyRevision: 2,
        backend: 'kiro',
        mechanism: 'api-key',
        configuration: { region: ' eu-west-1 ' },
      }),
    ).toBe(
      '{"version":2,"provider":"kiro","source":"space","connectionId":"kiro-space","connectionRevision":3,"policyRevision":2,"mode":"kiro","backend":"kiro","mechanism":"api-key","configuration":{"region":"eu-west-1"},"projectId":"p1"}',
    );
  });

  it('tolerates an externalId on planned IAM and keeps its loose role check', () => {
    const normalize = (configuration) =>
      PLANNED_IAM_MODE.normalizeConfiguration(configuration, { mechanism: 'assume-role' });
    expect(
      JSON.stringify(normalize({ externalId: ' ext-1 ', region: 'eu-west-1', roleArn: ROLE_ARN })),
    ).toBe(`{"externalId":"ext-1","region":"eu-west-1","roleArn":"${ROLE_ARN}"}`);
    for (const configuration of [
      { roleArn: ROLE_ARN },
      { region: 'eu-west-1' },
      { region: 'eu-west-1', roleArn: 'arn:aws:iam::1234:role/short-account' },
    ]) {
      expect(failure(() => normalize(configuration))).toEqual(
        invalid('IAM role ARN and region are required'),
      );
    }
    expect(
      failure(() => normalize({ region: 'eu-west-1', roleArn: ROLE_ARN, token: 'x' })),
    ).toEqual(invalid('Connection configuration contains unsupported fields'));
  });

  it('keeps the LiteLLM gateway and OAuth checks after the field loop', () => {
    const normalize = (mechanism, configuration) =>
      PLANNED_LITELLM_MODE.normalizeConfiguration(configuration, { mechanism });
    const machine = {
      endpoint: 'https://gw.example.com/v1',
      audience: 'inference',
      clientId: 'aidlc',
    };
    expect(failure(() => normalize('oauth-machine', machine))).toEqual(
      invalid('OAuth issuer, clientId and audience are required'),
    );
    expect(
      failure(() => normalize('oauth-user', { ...machine, issuer: 'https://idp.example.com' })),
    ).toBeNull();
    expect(normalize('api-key', { endpoint: 'https://gw.example.com/' })).toEqual({
      endpoint: 'https://gw.example.com',
    });
    expect(failure(() => normalize('api-key', {}))).toEqual(
      invalid('Gateway endpoint is required'),
    );
    // Field errors win over the gateway check, as before the registry.
    expect(failure(() => normalize('api-key', { audience: '' }))).toEqual(
      invalid('audience is invalid'),
    );
  });
});

// Invariants over whatever the real root registers, so a provider line never edits this suite.
describe('shared mode registration', () => {
  it('builds the host views from the root', () => {
    expect(AGENT_AUTH_MODES_CATALOG).toStrictEqual(
      createAuthModeRegistry(AGENT_AUTH_MODE_DESCRIPTORS).catalog,
    );
    expect(Object.isFrozen(AGENT_AUTH_MODE_DESCRIPTORS)).toBe(true);
    for (const { id } of AGENT_AUTH_MODES_CATALOG) {
      expect(authModeDescriptor(id)).toMatchObject({ id });
    }
  });

  it('registers known mechanisms and unique ids, keeps kiro uncatalogued and keys available', () => {
    for (const descriptor of AGENT_AUTH_MODE_DESCRIPTORS) {
      for (const mechanism of descriptor.mechanisms) {
        expect(Object.keys(AUTH_MECHANISMS)).toContain(mechanism);
      }
    }
    const ids = AGENT_AUTH_MODES_CATALOG.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('kiro');
    expect(authModeDescriptor('kiro')).toBeNull();
    expect(AGENT_AUTH_MODES_CATALOG.find(({ id }) => id === 'keys')?.available).toBe(true);
  });

  it('keeps every registered id parseable in a stored policy', () => {
    for (const { id } of AGENT_AUTH_MODES_CATALOG) {
      expect(normalizeAuthPolicy({ mode: id, revision: 1, defaultConnectionId: 'c1' }).mode).toBe(
        id,
      );
    }
    expect(() =>
      normalizeAuthPolicy({
        mode: 'unregistered-test-mode',
        revision: 1,
        defaultConnectionId: 'c1',
      }),
    ).toThrow('Unsupported authentication mode');
  });

  it('refuses a policy change to any planned mode', async () => {
    const repository = { getConnection: async () => null };
    for (const { id } of AGENT_AUTH_MODES_CATALOG.filter(({ available }) => !available)) {
      await expect(
        normalizeAuthAction(
          { kind: 'policy-change', mode: id, defaultConnectionId: 'c1' },
          repository,
        ),
      ).rejects.toMatchObject({ code: 'AGENT_AUTH_MODE_UNAVAILABLE' });
    }
  });
});
