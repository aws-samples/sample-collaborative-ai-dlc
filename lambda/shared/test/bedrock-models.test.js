import { describe, it, expect, vi } from 'vitest';
import bedrockModels from '../bedrock-models.js';

const { listClaudeModels, listCodexModels, regionPrefix } = bedrockModels;

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

  it('defaults to BEDROCK_REGION over the deployment region', async () => {
    vi.stubEnv('AWS_REGION', 'eu-central-1');
    vi.stubEnv('BEDROCK_REGION', 'us-east-1');
    try {
      const models = await listClaudeModels({ listInferenceProfiles: async () => SUMMARIES });
      const ids = models.map((m) => m.id);
      expect(ids).toContain('us.anthropic.claude-sonnet-4-6');
      expect(ids).not.toContain('eu.anthropic.claude-sonnet-4-6');
    } finally {
      vi.unstubAllEnvs();
    }
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

describe('listCodexModels (Mantle catalogue for the inference region)', () => {
  const catalog = (...ids) => ({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model' })),
  });

  // Trimmed 2026-11-03 responses from the issue: us-east-1 serves GPT-6/5,
  // eu-central-1 serves only the GPT-OSS entries.
  const US_EAST = catalog(
    'openai.gpt-6.1-sol',
    'openai.gpt-6-sol',
    'openai.gpt-oss-120b-1:0',
    'anthropic.claude-sonnet-4-6',
    'google.gemma-3-27b-it',
  );
  const EU_CENTRAL = catalog('openai.gpt-oss-120b-1:0', 'anthropic.claude-sonnet-4-6');

  it('keeps only the openai namespace and leaves GPT-OSS out', async () => {
    const { models } = await listCodexModels({
      region: 'us-east-1',
      listModels: async () => US_EAST,
    });
    expect(models.map((m) => m.id)).toEqual(['openai.gpt-6-sol', 'openai.gpt-6.1-sol']);
  });

  it('reports a different catalogue for a region that serves different models', async () => {
    const byRegion = { 'us-east-1': US_EAST, 'eu-central-1': EU_CENTRAL };
    const listModels = async (region) => byRegion[region];
    const us = await listCodexModels({ region: 'us-east-1', listModels });
    const eu = await listCodexModels({ region: 'eu-central-1', listModels });
    expect(us.models.map((m) => m.id)).toContain('openai.gpt-6.1-sol');
    expect(eu.models).toEqual([]);
  });

  it('asks the loader for the region it was given', async () => {
    const seen = [];
    await listCodexModels({
      region: 'eu-central-1',
      listModels: async (region) => {
        seen.push(region);
        return EU_CENTRAL;
      },
    });
    expect(seen).toEqual(['eu-central-1']);
  });

  it('keeps a saved id the region no longer lists, ahead of the catalogue', async () => {
    const { models, source } = await listCodexModels({
      region: 'eu-central-1',
      listModels: async () => catalog('openai.gpt-6-sol'),
      savedIds: ['openai.gpt-7-preview'],
    });
    expect(source).toBe('catalog');
    expect(models.map((m) => m.id)).toEqual(['openai.gpt-7-preview', 'openai.gpt-6-sol']);
  });

  it('reports a failed lookup instead of an empty catalogue', async () => {
    const { models, source } = await listCodexModels({
      region: 'us-east-1',
      listModels: async () => {
        throw new Error('403');
      },
      savedIds: ['openai.gpt-5.5'],
    });
    expect(source).toBe('error');
    expect(models.map((m) => m.id)).toEqual(['openai.gpt-5.5']);
  });
});
