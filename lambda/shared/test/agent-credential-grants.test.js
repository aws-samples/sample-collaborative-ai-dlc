import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  signAgentCredentialGrant,
  verifyAgentCredentialGrant,
} from '../agent-credential-grants.js';

const SECRET = 'g'.repeat(48);
const NOW = Date.parse('2026-09-01T12:00:00.000Z');

describe('agent credential grants', () => {
  it('round-trips an exact, short-lived binding authorization', () => {
    const token = signAgentCredentialGrant(
      {
        purpose: 'discussion',
        projectId: 'p-1',
        executionId: 'e-1',
        bindings: [{ provider: 'kiro', source: 'user', userId: 'u-1' }],
      },
      SECRET,
      {
        now: () => NOW,
        randomId: () => 'grant-1234567890',
        ttlSeconds: 120,
      },
    );

    expect(verifyAgentCredentialGrant(token, SECRET, { now: () => NOW + 60_000 })).toEqual({
      version: 1,
      audience: 'aidlc-agent-credential-broker',
      grantId: 'grant-1234567890',
      purpose: 'discussion',
      projectId: 'p-1',
      executionId: 'e-1',
      bindings: [{ provider: 'kiro', source: 'user', userId: 'u-1' }],
      issuedAt: 1788264000,
      expiresAt: 1788264120,
    });
  });

  it('rejects tampered and expired grants', () => {
    const token = signAgentCredentialGrant(
      {
        purpose: 'execution',
        projectId: 'p-1',
        executionId: 'e-1',
        bindings: [{ provider: 'bedrock', source: 'space' }],
      },
      SECRET,
      { now: () => NOW, randomId: () => 'grant-1234567890', ttlSeconds: 60 },
    );
    const [claims, signature] = token.split('.');

    expect(() =>
      verifyAgentCredentialGrant(`${claims.slice(0, -1)}A.${signature}`, SECRET, {
        now: () => NOW,
      }),
    ).toThrow('Agent credential grant is invalid');
    try {
      verifyAgentCredentialGrant(token, SECRET, { now: () => NOW + 61_000 });
      throw new Error('expected the grant to expire');
    } catch (error) {
      expect(error).toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_EXPIRED' });
    }
  });

  it('requires a project for space-scoped credentials', () => {
    expect(() =>
      signAgentCredentialGrant(
        {
          purpose: 'capabilities',
          bindings: [{ provider: 'kiro', source: 'space' }],
        },
        SECRET,
      ),
    ).toThrow('Space credential grants require a projectId');
  });

  describe('connection verification', () => {
    const connection = {
      version: 2,
      provider: 'bedrock',
      backend: 'bedrock',
      mode: 'keys',
      mechanism: 'api-key',
      source: 'platform',
      connectionId: 'keys-verification-1',
      connectionRevision: 1,
      policyRevision: 3,
      configuration: {},
    };
    const resign = (token, changes) => {
      const claims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      const encoded = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url');
      return `${encoded}.${createHmac('sha256', SECRET).update(encoded).digest('base64url')}`;
    };
    const verification = (overrides) => ({
      purpose: 'verify-connection',
      bindings: [connection],
      ...overrides,
    });

    it('round-trips a grant for exactly one unsaved connection', () => {
      const token = signAgentCredentialGrant(verification(), SECRET, {
        now: () => NOW,
        randomId: () => 'grant-verify-123456',
      });

      expect(verifyAgentCredentialGrant(token, SECRET, { now: () => NOW })).toMatchObject({
        version: 2,
        purpose: 'verify-connection',
        executionId: null,
        bindings: [connection],
      });
    });

    it.each([
      ['an execution', verification({ executionId: 'e-1' })],
      [
        'a second binding',
        verification({ bindings: [connection, { provider: 'kiro', source: 'platform' }] }),
      ],
      [
        'a version-one binding',
        verification({ bindings: [{ provider: 'bedrock', source: 'platform' }] }),
      ],
    ])('rejects a verification grant carrying %s at signing and verification', (_label, input) => {
      const message =
        'Connection verification grants require exactly one connection and no execution';
      expect(() => signAgentCredentialGrant(input, SECRET)).toThrow(message);
      // A validly signed token relabelled as verification must still fail the claims rule.
      const token = signAgentCredentialGrant({ ...input, purpose: 'capabilities' }, SECRET, {
        now: () => NOW,
      });
      expect(() =>
        verifyAgentCredentialGrant(resign(token, { purpose: 'capabilities' }), SECRET, {
          now: () => NOW,
        }),
      ).not.toThrow();
      expect(() =>
        verifyAgentCredentialGrant(resign(token, { purpose: 'verify-connection' }), SECRET, {
          now: () => NOW,
        }),
      ).toThrow(message);
    });
  });
});
