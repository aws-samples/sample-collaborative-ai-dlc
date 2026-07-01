import { describe, it, expect } from 'vitest';
import { resolveModelId, resolveStageModel } from '../model-resolver.js';

describe('resolveModelId', () => {
  it('passes a full id through untouched', () => {
    expect(resolveModelId('us.anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6');
    expect(resolveModelId('amazon-bedrock/eu.anthropic.claude-opus-4-6')).toBe(
      'amazon-bedrock/eu.anthropic.claude-opus-4-6',
    );
  });

  it('resolves bare tier aliases with the region geo prefix', () => {
    expect(resolveModelId('opus', { env: { AWS_REGION: 'us-east-1' } })).toBe(
      'us.anthropic.claude-opus-4-6-v1',
    );
    expect(resolveModelId('sonnet', { env: { AWS_REGION: 'eu-central-1' } })).toBe(
      'eu.anthropic.claude-sonnet-4-6',
    );
    expect(resolveModelId('haiku', { env: { AWS_REGION: 'ap-southeast-2' } })).toBe(
      'apac.anthropic.claude-haiku-4-5-20251001',
    );
  });

  it('defaults to the us geo when region is unknown/absent', () => {
    expect(resolveModelId('opus', { env: {} })).toBe('us.anthropic.claude-opus-4-6-v1');
  });

  it('passes an unknown bare token through (CLI decides)', () => {
    expect(resolveModelId('some-future-tier', { env: {} })).toBe('some-future-tier');
  });

  it('honors an AIDLC_MODEL_ALIASES override', () => {
    const env = {
      AWS_REGION: 'us-east-1',
      AIDLC_MODEL_ALIASES: '{"opus":"anthropic.claude-opus-4-8"}',
    };
    expect(resolveModelId('opus', { env })).toBe('us.anthropic.claude-opus-4-8');
  });

  it('returns undefined for empty input', () => {
    expect(resolveModelId('', { env: {} })).toBeUndefined();
    expect(resolveModelId(null, { env: {} })).toBeUndefined();
  });
});

describe('resolveStageModel — precedence (project cliModels wins)', () => {
  const agentBlock = { modelOverride: 'opus' };
  const env = { AWS_REGION: 'us-east-1', BEDROCK_MODEL: 'us.anthropic.claude-haiku-4-5-20251001' };

  it('project cliModels[cli] beats the agent override', () => {
    expect(
      resolveStageModel({
        cliModels: { claude: 'us.anthropic.claude-sonnet-4-6' },
        agentBlock,
        cli: 'claude',
        env,
      }),
    ).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('agent override (alias-resolved) when no project model for the CLI', () => {
    expect(resolveStageModel({ cliModels: { kiro: 'x' }, agentBlock, cli: 'claude', env })).toBe(
      'us.anthropic.claude-opus-4-6-v1',
    );
  });

  it('env default when neither project nor agent set a model', () => {
    expect(resolveStageModel({ cliModels: {}, agentBlock: null, cli: 'claude', env })).toBe(
      'us.anthropic.claude-haiku-4-5-20251001',
    );
  });
});

describe('resolveStageModel — Kiro uses its OWN model namespace (not Bedrock)', () => {
  // BEDROCK_MODEL is a Bedrock inference profile the kiro CLI rejects; it must not
  // leak into a kiro run.
  const env = { AWS_REGION: 'us-east-1', BEDROCK_MODEL: 'us.anthropic.claude-sonnet-4-6' };

  it('passes a kiro-native model through verbatim (no alias/region resolution)', () => {
    expect(resolveStageModel({ cliModels: { kiro: 'claude-sonnet-4.6' }, cli: 'kiro', env })).toBe(
      'claude-sonnet-4.6',
    );
    expect(resolveStageModel({ cliModels: { kiro: 'auto' }, cli: 'kiro', env })).toBe('auto');
  });

  it('returns undefined when no kiro model is selected (driver omits --model → kiro default)', () => {
    // The Bedrock BEDROCK_MODEL env + a bare-alias agent override must NOT apply.
    expect(
      resolveStageModel({ cliModels: {}, agentBlock: { modelOverride: 'opus' }, cli: 'kiro', env }),
    ).toBeUndefined();
    expect(
      resolveStageModel({
        cliModels: { claude: 'us.anthropic.claude-sonnet-4-6' },
        cli: 'kiro',
        env,
      }),
    ).toBeUndefined();
  });
});
