import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  EXECUTION_DATA_LEASE_SECONDS,
  signAgentCredentialGrant,
  signExecutionDataGrant,
  verifyAgentCredentialGrant,
  verifyExecutionDataGrant,
} from '../agent-credential-grants.js';

const SECRET = 'g'.repeat(48);
const NOW = Date.parse('2026-09-01T12:00:00.000Z');

describe.each([
  {
    name: 'agent credential',
    sign: (secret) =>
      signAgentCredentialGrant(
        { purpose: 'execution', bindings: [{ provider: 'bedrock', source: 'platform' }] },
        secret,
        { now: () => NOW },
      ),
    verify: verifyAgentCredentialGrant,
    invalidCode: 'AGENT_CREDENTIAL_GRANT_INVALID',
  },
  {
    name: 'execution data',
    sign: (secret) => signExecutionDataGrant({ executionId: 'A' }, secret, { now: () => NOW }),
    verify: verifyExecutionDataGrant,
    invalidCode: 'EXECUTION_DATA_GRANT_INVALID',
  },
])('$name signed grant validation', ({ sign, verify, invalidCode }) => {
  it.each([null, '', 'body', '.signature', 'body.', 'a.b.c', 'a'.repeat(8193)])(
    'rejects malformed token %# with its grant-specific error',
    (token) => {
      expect(() => verify(token, SECRET, { now: () => NOW })).toThrow(
        expect.objectContaining({ code: invalidCode }),
      );
    },
  );

  it('rejects incorrect signatures of both matching and different lengths', () => {
    const [body] = sign(SECRET).split('.');
    for (const signature of ['AA', Buffer.alloc(32).toString('base64url')]) {
      expect(() => verify(`${body}.${signature}`, SECRET, { now: () => NOW })).toThrow(
        expect.objectContaining({ code: invalidCode }),
      );
    }
    expect(() => verify(sign('x'.repeat(48)), SECRET, { now: () => NOW })).toThrow(
      expect.objectContaining({ code: invalidCode }),
    );
  });

  it.each(['not JSON', 'null', '[]', '{"version":2,"audience":"wrong"}'])(
    'rejects signed invalid claims: %s',
    (claims) => {
      const body = Buffer.from(claims).toString('base64url');
      const signature = createHmac('sha256', SECRET).update(body).digest('base64url');
      expect(() => verify(`${body}.${signature}`, SECRET, { now: () => NOW })).toThrow(
        expect.objectContaining({ code: invalidCode }),
      );
    },
  );

  it('preserves signing-key configuration errors', () => {
    expect(() => verify(sign(SECRET), 'short', { now: () => NOW })).toThrow(
      expect.objectContaining({ code: 'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED' }),
    );
  });
});

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

  it('rejects execution data grants signed with the same trusted key', () => {
    const token = signExecutionDataGrant({ executionId: 'A' }, SECRET, { now: () => NOW });
    expect(() => verifyAgentCredentialGrant(token, SECRET, { now: () => NOW })).toThrow(
      expect.objectContaining({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' }),
    );
  });
});

const issuedAt = Date.parse('2026-09-29T12:00:00Z');
const now = () => issuedAt;

describe('execution data authorization', () => {
  it('authorizes initial/draft execution creation without metadata or model bindings', () => {
    const token = signExecutionDataGrant({ executionId: 'draft-A' }, SECRET, { now });
    expect(verifyExecutionDataGrant(token, SECRET, { now })).toEqual({
      executionId: 'draft-A',
      expiresAt: issuedAt / 1000 + EXECUTION_DATA_LEASE_SECONDS,
    });
  });

  it('permits renewal after one hour but cannot extend its fixed eight-hour lease', () => {
    const token = signExecutionDataGrant({ executionId: 'A' }, SECRET, { now });
    expect(
      verifyExecutionDataGrant(token, SECRET, { now: () => issuedAt + 3600_000 }).executionId,
    ).toBe('A');
    expect(() =>
      verifyExecutionDataGrant(token, SECRET, {
        now: () => issuedAt + EXECUTION_DATA_LEASE_SECONDS * 1000,
      }),
    ).toThrow('invalid or expired');
    const resumed = signExecutionDataGrant({ executionId: 'A' }, SECRET, {
      now: () => issuedAt + EXECUTION_DATA_LEASE_SECONDS * 1000,
    });
    expect(
      verifyExecutionDataGrant(resumed, SECRET, {
        now: () => issuedAt + EXECUTION_DATA_LEASE_SECONDS * 1000,
      }).executionId,
    ).toBe('A');
  });

  it.each(['executionId', 'expiresAt', 'audience'])('rejects tampered %s', (field) => {
    const token = signExecutionDataGrant({ executionId: 'A' }, SECRET, { now });
    const [body, sig] = token.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    claims[field] = field === 'expiresAt' ? claims.expiresAt + 3600 : 'B';
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect(() => verifyExecutionDataGrant(forged, SECRET, { now })).toThrow('invalid or expired');
  });

  it.each(['*', 'A#B', '', null])('rejects invalid partition identifiers: %s', (executionId) => {
    expect(() => signExecutionDataGrant({ executionId }, SECRET, { now })).toThrow();
  });

  it('rejects model grants even when signed with the same trusted key', () => {
    const modelGrant = signAgentCredentialGrant(
      {
        purpose: 'execution',
        executionId: 'A',
        projectId: 'p1',
        bindings: [{ provider: 'bedrock', source: 'platform' }],
      },
      SECRET,
      { now },
    );
    expect(() => verifyExecutionDataGrant(modelGrant, SECRET, { now })).toThrow();
  });
});
