import { describe, expect, it } from 'vitest';
import {
  signAgentCredentialGrant,
  signBedrockRoleRefreshGrant,
  verifyAgentCredentialGrant,
  verifyBedrockRoleRefreshGrant,
} from '../agent-credential-grants.js';

const SECRET = 'g'.repeat(48);
const NOW = Date.parse('2026-09-01T12:00:00.000Z');

const refreshClaims = (overrides = {}) => ({
  projectId: 'p-1',
  executionId: 'e-1',
  stageInstanceId: 'si-1',
  stageCallbackId: 'cb-1',
  binding: { provider: 'bedrock', source: 'space' },
  kind: 'role',
  expiresAt: Math.floor(NOW / 1000) + 3600,
  ...overrides,
});

const signRefreshGrant = (overrides = {}) =>
  signBedrockRoleRefreshGrant(refreshClaims(overrides), SECRET, {
    now: () => NOW,
    randomId: () => 'refresh-grant-1234',
  });

describe('bedrock role refresh grants', () => {
  it('round-trips authorization pinned to one stage attempt', () => {
    const token = signRefreshGrant();

    expect(verifyBedrockRoleRefreshGrant(token, SECRET, { now: () => NOW + 60_000 })).toEqual({
      version: 1,
      audience: 'aidlc-bedrock-role-refresh',
      grantId: 'refresh-grant-1234',
      projectId: 'p-1',
      executionId: 'e-1',
      stageInstanceId: 'si-1',
      stageCallbackId: 'cb-1',
      binding: { provider: 'bedrock', source: 'space' },
      kind: 'role',
      issuedAt: 1788264000,
      expiresAt: 1788267600,
    });
  });

  it('keeps invocation and refresh audiences mutually exclusive', () => {
    const invocationToken = signAgentCredentialGrant(
      {
        purpose: 'execution',
        projectId: 'p-1',
        executionId: 'e-1',
        bindings: [{ provider: 'bedrock', source: 'space' }],
      },
      SECRET,
      { now: () => NOW, randomId: () => 'invocation-grant-1' },
    );
    const refreshToken = signRefreshGrant();

    expect(() =>
      verifyBedrockRoleRefreshGrant(invocationToken, SECRET, { now: () => NOW }),
    ).toThrow('Bedrock role refresh grant is invalid');
    expect(() => verifyAgentCredentialGrant(refreshToken, SECRET, { now: () => NOW })).toThrow(
      'Agent credential grant is invalid',
    );
  });

  it('expires at the absolute stage callback boundary', () => {
    const token = signRefreshGrant({ expiresAt: Math.floor(NOW / 1000) + 60 });
    let thrown;

    try {
      verifyBedrockRoleRefreshGrant(token, SECRET, { now: () => NOW + 60_000 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_EXPIRED' });
  });

  it('refuses bearer credentials and grants without a stage attempt', () => {
    expect(() => signRefreshGrant({ kind: 'bearer' })).toThrow(
      'Bedrock role refresh grant credential kind is invalid',
    );
    expect(() => signRefreshGrant({ stageInstanceId: null })).toThrow(
      'stageInstanceId is required',
    );
  });
});
