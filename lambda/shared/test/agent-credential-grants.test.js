import { describe, expect, it } from 'vitest';
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
});
