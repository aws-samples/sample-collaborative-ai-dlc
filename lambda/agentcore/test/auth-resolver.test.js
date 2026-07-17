import { describe, it, expect } from 'vitest';
import { resolveAgentAuth } from '../auth-resolver.js';

describe('resolveAgentAuth', () => {
  it('loads the bearer token + kiro key from their SSM paths into env', async () => {
    const env = {
      BEDROCK_BEARER_TOKEN_SSM_PATH: '/p/bedrock',
      KIRO_API_KEY_SSM_PATH: '/p/kiro',
      AWS_REGION: 'us-east-1',
    };
    const store = { '/p/bedrock': 'bearer-xyz', '/p/kiro': 'kiro-abc' };
    const resolved = await resolveAgentAuth({ env, getParam: async (n) => store[n] ?? '' });
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('bearer-xyz');
    expect(env.KIRO_API_KEY).toBe('kiro-abc');
    expect(resolved.toSorted()).toEqual(['AWS_BEARER_TOKEN_BEDROCK', 'KIRO_API_KEY']);
  });

  it('never overwrites an already-set env var', async () => {
    const env = {
      AWS_BEARER_TOKEN_BEDROCK: 'preset',
      BEDROCK_BEARER_TOKEN_SSM_PATH: '/p/bedrock',
    };
    const resolved = await resolveAgentAuth({ env, getParam: async () => 'from-ssm' });
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('preset');
    expect(resolved).not.toContain('AWS_BEARER_TOKEN_BEDROCK');
  });

  it('skips a target whose SSM path is not configured', async () => {
    const env = { KIRO_API_KEY_SSM_PATH: '/p/kiro' }; // no bedrock path
    const resolved = await resolveAgentAuth({ env, getParam: async () => 'k' });
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(resolved).toEqual(['KIRO_API_KEY']);
  });

  it('skips a path that resolves empty (SSM miss/error) without throwing', async () => {
    const env = { BEDROCK_BEARER_TOKEN_SSM_PATH: '/p/missing' };
    const resolved = await resolveAgentAuth({ env, getParam: async () => '' });
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(resolved).toEqual([]);
  });
});
