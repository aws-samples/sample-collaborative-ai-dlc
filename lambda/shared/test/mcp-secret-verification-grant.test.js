import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  signMcpSecretVerificationGrant,
  verifyMcpSecretVerificationGrant,
} from '../mcp-secret-verification-grant.js';
import { normalizeMcpSecretConfig } from '../mcp-secret-config.js';

const secret = 'test-mcp-verification-key'.repeat(3);
const now = () => 1_800_000_000_000;
const config = {
  global: {
    overridden: { command: 'npx', env: { K: '${DROP}' } },
    g: { command: 'npx', env: { K: '${GK}' } },
  },
  project: { overridden: { command: 'uvx', env: { K: '${PK}' } } },
};
const sign = (options = {}) =>
  signMcpSecretVerificationGrant({ projectId: 'p1', mcpServersByTier: config }, secret, {
    now,
    ...options,
  });
const rewrite = (token, changes) => {
  const claims = { ...JSON.parse(Buffer.from(token.split('.')[0], 'base64url')), ...changes };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
};

describe('MCP verification capability', () => {
  it('binds canonical full configuration and surviving tier refs, never values', () => {
    const token = sign();
    const claims = verifyMcpSecretVerificationGrant(token, secret, { now });
    expect(claims).toMatchObject({
      audience: 'aidlc-mcp-secret-verification',
      purpose: 'verify-mcp',
      projectId: 'p1',
      overrideTier: 'project',
      allowedRefs: { global: ['GK'], project: ['PK'] },
      expiresAt: now() / 1000 + 300,
    });
    expect(JSON.stringify(claims)).not.toContain('DROP');
    expect(JSON.stringify(claims)).not.toContain('npx');
    const reordered = {
      project: config.project,
      global: { g: config.global.g, overridden: config.global.overridden },
    };
    const other = signMcpSecretVerificationGrant(
      { projectId: 'p1', mcpServersByTier: reordered },
      secret,
      { now },
    );
    expect(verifyMcpSecretVerificationGrant(other, secret, { now }).configDigest).toBe(
      claims.configDigest,
    );
  });
  it.each([
    { audience: 'aidlc-agent-credential-broker' },
    { purpose: 'capabilities' },
    { overrideTier: 'global' },
    { projectId: '../p2' },
    { configDigest: 'bad' },
    { grantId: '' },
    { extra: true },
    { allowedRefs: { global: ['a/b'], project: [] } },
    { allowedRefs: { global: ['A', 'A'], project: [] } },
    { allowedRefs: { global: [], project: [], other: [] } },
    { issuedAt: now() / 1000 + 1 },
    { expiresAt: now() / 1000 + 301 },
  ])('rejects malformed signed claims %j', (changes) => {
    expect(() =>
      verifyMcpSecretVerificationGrant(rewrite(sign(), changes), secret, { now }),
    ).toThrow('MCP_VERIFICATION_GRANT_INVALID');
  });
  it('rejects expiration, signature tampering, wrong key and overlong TTL', () => {
    expect(() =>
      verifyMcpSecretVerificationGrant(sign(), secret, { now: () => now() + 300_000 }),
    ).toThrow('MCP_VERIFICATION_GRANT_EXPIRED');
    expect(() => verifyMcpSecretVerificationGrant(`${sign()}x`, secret, { now })).toThrow(
      'MCP_VERIFICATION_GRANT_INVALID',
    );
    expect(() =>
      verifyMcpSecretVerificationGrant(sign(), 'different-key'.repeat(4), { now }),
    ).toThrow('MCP_VERIFICATION_GRANT_INVALID');
    expect(() => sign({ ttlSeconds: 301 })).toThrow('MCP_VERIFICATION_GRANT_INVALID');
  });
  it('global verification cannot include a project tier', () => {
    expect(() =>
      signMcpSecretVerificationGrant({ mcpServersByTier: config }, secret, { now }),
    ).toThrow('MCP_VERIFICATION_GRANT_INVALID');
  });
  it.each([
    { global: {}, project: {}, prefix: '/other' },
    JSON.parse('{"global":{"__proto__":{"command":"npx"}}}'),
    { project: { p: { command: 'npx', env: { K: '${../p2/KEY}' } } } },
    { project: { p: { command: 'npx', parameterName: '/other' } } },
    { project: { p: { command: 'npx', env: { K: 'x'.repeat(128 * 1024) } } } },
  ])('rejects invalid/oversized config without echoing its fields', (input) => {
    expect(() => normalizeMcpSecretConfig(input)).toThrow(/^MCP_SECRET_CONFIG_INVALID$/);
  });
});
