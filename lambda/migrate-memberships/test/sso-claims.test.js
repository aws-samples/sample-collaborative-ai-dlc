import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createMembershipStore } from '../../shared/space-membership.js';
import { createTestMembershipStore } from '../../../test/membership-store.js';
import { backfillSsoClaims } from '../sso-claims.js';

const federated = (sub, claims) => ({
  Attributes: [
    { Name: 'sub', Value: sub },
    {
      Name: 'identities',
      Value: JSON.stringify([{ providerName: 'Entra', providerType: 'OIDC', userId: sub }]),
    },
    { Name: 'custom:sso_roles', Value: claims },
  ],
});

let fixture;
beforeAll(async () => {
  fixture = await createTestMembershipStore(createMembershipStore);
});
afterAll(() => fixture?.cleanup?.());

describe('SSO claims backfill', () => {
  it('copies every federated user once and keeps claims recorded at sign-in', async () => {
    const { store } = fixture;
    const [newcomer, signedIn, local] = [randomUUID(), randomUUID(), randomUUID()];
    await store.recordSsoClaims({
      subject: signedIn,
      providerName: 'Entra',
      claimValues: ['Architects'],
    });
    const pages = [
      { Users: [federated(newcomer, '[Engineering]')], PaginationToken: 'page-2' },
      {
        Users: [
          { Attributes: [{ Name: 'sub', Value: local }] },
          federated(signedIn, '[Engineering]'),
        ],
      },
    ];
    const requests = [];
    const cognito = {
      send: async (command) => {
        requests.push(command.input);
        return pages[requests.length - 1];
      },
    };

    const result = await backfillSsoClaims({ cognito, userPoolId: 'pool', store });

    expect(result).toEqual({ backfilled: true, scanned: 3, written: 1, kept: 1 });
    expect(requests.map(({ PaginationToken }) => PaginationToken)).toEqual([undefined, 'page-2']);
    expect(await store.getSsoClaims(newcomer)).toMatchObject({
      providerName: 'Entra',
      claimValues: ['Engineering'],
      source: 'backfill',
    });
    expect(await store.getSsoClaims(signedIn)).toMatchObject({
      claimValues: ['Architects'],
      source: 'sign-in',
    });
    expect(await store.getSsoClaims(local)).toBeNull();
    // The record is not a membership: the by-user index does not list it.
    expect((await store.listUserSpaces(newcomer)).items).toEqual([]);
  });

  it('fails instead of reporting success when the directory cannot be read', async () => {
    const cognito = { send: async () => Promise.reject(new Error('Throttled')) };
    await expect(
      backfillSsoClaims({ cognito, userPoolId: 'pool', store: fixture.store }),
    ).rejects.toThrow('Throttled');
  });
});
