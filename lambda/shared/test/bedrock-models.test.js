import { describe, it, expect } from 'vitest';
import bedrockModels from '../bedrock-models.js';

const { listClaudeModels, regionPrefix } = bedrockModels;

const P = (id, extra = {}) => ({
  inferenceProfileId: id,
  inferenceProfileName: id,
  status: 'ACTIVE',
  ...extra,
});

// A trimmed real ListInferenceProfiles payload (mixed geos + a non-Claude + an
// inactive profile) to prove the filtering.
const SUMMARIES = [
  P('us.anthropic.claude-sonnet-4-6'),
  P('us.anthropic.claude-opus-4-8'),
  P('eu.anthropic.claude-sonnet-4-6'),
  P('apac.anthropic.claude-sonnet-4-6'),
  P('global.anthropic.claude-opus-4-6-v1'),
  P('us.anthropic.claude-3-sonnet-20240229-v1:0', { status: 'LEGACY' }),
  P('us.amazon.nova-pro-v1:0'), // non-Claude
];

describe('regionPrefix', () => {
  it('maps region to geo prefix', () => {
    expect(regionPrefix('us-east-1')).toBe('us');
    expect(regionPrefix('eu-west-1')).toBe('eu');
    expect(regionPrefix('ap-southeast-2')).toBe('apac');
    expect(regionPrefix('')).toBe('us');
  });
});

describe('listClaudeModels', () => {
  it('returns only region-geo + global ACTIVE Claude profiles (us-east-1)', async () => {
    const models = await listClaudeModels({
      listInferenceProfiles: async () => SUMMARIES,
      region: 'us-east-1',
    });
    const ids = models.map((m) => m.id);
    expect(ids).toContain('us.anthropic.claude-sonnet-4-6');
    expect(ids).toContain('us.anthropic.claude-opus-4-8');
    expect(ids).toContain('global.anthropic.claude-opus-4-6-v1');
    // Wrong geo, non-Claude, and inactive are all excluded.
    expect(ids).not.toContain('eu.anthropic.claude-sonnet-4-6');
    expect(ids).not.toContain('apac.anthropic.claude-sonnet-4-6');
    expect(ids).not.toContain('us.amazon.nova-pro-v1:0');
    expect(ids).not.toContain('us.anthropic.claude-3-sonnet-20240229-v1:0');
  });

  it('picks the eu geo in an eu region', async () => {
    const models = await listClaudeModels({
      listInferenceProfiles: async () => SUMMARIES,
      region: 'eu-west-1',
    });
    const ids = models.map((m) => m.id);
    expect(ids).toContain('eu.anthropic.claude-sonnet-4-6');
    expect(ids).toContain('global.anthropic.claude-opus-4-6-v1');
    expect(ids).not.toContain('us.anthropic.claude-sonnet-4-6');
  });

  it('sorts region-own geo before global', async () => {
    const models = await listClaudeModels({
      listInferenceProfiles: async () => SUMMARIES,
      region: 'us-east-1',
    });
    const lastOwn = models.findLastIndex((m) => !m.id.startsWith('global.'));
    const firstGlobal = models.findIndex((m) => m.id.startsWith('global.'));
    expect(lastOwn).toBeLessThan(firstGlobal);
  });

  it('returns [] when the lookup throws (never crashes the endpoint)', async () => {
    const models = await listClaudeModels({
      listInferenceProfiles: async () => {
        throw new Error('AccessDenied');
      },
      region: 'us-east-1',
    });
    expect(models).toEqual([]);
  });
});
