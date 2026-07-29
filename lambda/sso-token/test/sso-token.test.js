import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateSsoRoles, parseClaimValues } from '../../shared/sso-roles.js';
import { handler } from '../index.js';

const config = {
  providers: {
    EnterpriseOIDC: {
      roleMappings: {
        'platform-admin': ['aidlc-admin'],
      },
      requiredClaimValues: ['aidlc-user'],
    },
  },
};

const identities = JSON.stringify([
  { providerName: 'EnterpriseOIDC', providerType: 'OIDC', userId: 'user-1' },
]);

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('claim normalization', () => {
  it('parses Cognito encoded bracket values', () => {
    expect(parseClaimValues('[%22aidlc-user%22,%22team%20admin%22]')).toEqual([
      'aidlc-user',
      'team admin',
    ]);
  });

  it('parses arrays and JSON arrays without duplicates', () => {
    expect(parseClaimValues(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(parseClaimValues('["a","b"]')).toEqual(['a', 'b']);
  });

  it('preserves encoded commas inside quoted claim values', () => {
    expect(parseClaimValues('[%22team%2Cadmin%22,%22aidlc-user%22]')).toEqual([
      'team,admin',
      'aidlc-user',
    ]);
  });
});

describe('SSO role evaluation', () => {
  it('leaves local users outside SSO role evaluation', () => {
    expect(evaluateSsoRoles({ email: 'local@example.com' }, config)).toMatchObject({
      federated: false,
      admitted: true,
    });
  });

  it('maps exact external values to known platform roles', () => {
    expect(
      evaluateSsoRoles({ identities, 'custom:sso_roles': '[aidlc-user,aidlc-admin]' }, config),
    ).toMatchObject({
      federated: true,
      admitted: true,
      roles: ['platform-admin'],
    });
  });

  it('admits a non-admin with the required claim', () => {
    expect(
      evaluateSsoRoles({ identities, 'custom:sso_roles': 'aidlc-user' }, config),
    ).toMatchObject({
      admitted: true,
      roles: [],
    });
  });

  it('denies users without the required claim or a mapped role', () => {
    expect(evaluateSsoRoles({ identities, 'custom:sso_roles': 'other' }, config)).toMatchObject({
      admitted: false,
      reason: 'required-claim-missing',
    });
  });

  it('does not let a mapped role bypass the access gate', () => {
    expect(
      evaluateSsoRoles({ identities, 'custom:sso_roles': 'aidlc-admin' }, config),
    ).toMatchObject({
      admitted: false,
      roles: ['platform-admin'],
      reason: 'required-claim-missing',
    });
  });

  it('fails closed for an unknown provider', () => {
    const unknown = JSON.stringify([{ providerName: 'Unknown', providerType: 'OIDC' }]);
    expect(evaluateSsoRoles({ identities: unknown }, config)).toMatchObject({
      admitted: false,
      reason: 'provider-not-configured',
    });
  });
});

describe('pre-token handler', () => {
  it('preserves a local token unchanged', async () => {
    vi.stubEnv('SSO_ROLE_CONFIG', JSON.stringify(config));
    const event = { request: { userAttributes: { email: 'local@example.com' } }, response: {} };
    expect(await handler(event)).toBe(event);
    expect(event.response).toEqual({});
  });

  it('replaces federated Cognito groups with mapped roles', async () => {
    vi.stubEnv('SSO_ROLE_CONFIG', JSON.stringify(config));
    const event = {
      request: {
        userAttributes: {
          identities,
          'custom:sso_roles': '[aidlc-user,aidlc-admin]',
        },
        groupConfiguration: { groupsToOverride: ['manually-assigned'] },
      },
      response: {},
    };
    await handler(event);
    expect(event.response.claimsOverrideDetails).toEqual({
      claimsToAddOrOverride: {
        'custom:identity_provider': 'EnterpriseOIDC',
        'custom:role_source': 'sso',
      },
      groupOverrideDetails: {
        groupsToOverride: ['platform-admin'],
      },
    });
  });

  it('rejects a federated user who fails the access gate', async () => {
    vi.stubEnv('SSO_ROLE_CONFIG', JSON.stringify(config));
    await expect(
      handler({
        request: { userAttributes: { identities, 'custom:sso_roles': 'other' } },
        response: {},
      }),
    ).rejects.toThrow('SSO_ACCESS_DENIED');
  });
});
