import { describe, it, expect } from 'vitest';
import {
  normalizeTierModels,
  parseTierModels,
  mergeTierModels,
  TIER_MODEL_ROWS,
} from '../tier-models.js';

describe('normalizeTierModels', () => {
  it('accepts the flat-row shape and normalizes per-CLI values', () => {
    const res = normalizeTierModels({
      judgment: { claude: ' us.anthropic.claude-opus-4-6 ' },
      fallback: { kiro: 'claude-sonnet-4.5' },
      quorum: { opencode: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6' },
    });
    expect(res.valid).toBe(true);
    expect(res.value).toEqual({
      judgment: { claude: 'us.anthropic.claude-opus-4-6' },
      fallback: { kiro: 'claude-sonnet-4.5' },
      quorum: { opencode: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6' },
    });
  });

  it('accepts the nested authored shape ({ tiers: { … } }) and flattens it', () => {
    const res = normalizeTierModels({
      tiers: { balanced: { claude: 'us.anthropic.claude-sonnet-4-6' } },
      fallback: { claude: 'us.anthropic.claude-haiku-4-5' },
    });
    expect(res.valid).toBe(true);
    expect(res.value).toEqual({
      balanced: { claude: 'us.anthropic.claude-sonnet-4-6' },
      fallback: { claude: 'us.anthropic.claude-haiku-4-5' },
    });
  });

  it('accepts a JSON string', () => {
    const res = normalizeTierModels('{"templated":{"claude":"us.anthropic.claude-haiku-4-5"}}');
    expect(res.valid).toBe(true);
    expect(res.value.templated.claude).toBe('us.anthropic.claude-haiku-4-5');
  });

  it('rejects unknown rows and unknown tiers loudly (a typo must not silently configure nothing)', () => {
    const badRow = normalizeTierModels({ judgement: { claude: 'x' } }); // typo'd tier
    expect(badRow.valid).toBe(false);
    expect(badRow.issues[0].path).toBe('judgement');
    const badTier = normalizeTierModels({ tiers: { quorum: { claude: 'x' } } }); // quorum is not a tier
    expect(badTier.valid).toBe(false);
    expect(badTier.issues[0].path).toBe('tiers.quorum');
  });

  it('applies the per-CLI validation rules inside every row', () => {
    const res = normalizeTierModels({
      judgment: { opencode: 'us.anthropic.claude-opus-4-6' }, // missing amazon-bedrock/ prefix
      fallback: { cursor: 'nope' }, // unknown CLI
    });
    expect(res.valid).toBe(false);
    expect(res.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['judgment.opencode', 'fallback.cursor']),
    );
  });

  it('treats null/undefined/invalid JSON per the cli-models contract', () => {
    expect(normalizeTierModels(undefined)).toEqual({ valid: true, issues: [], value: {} });
    expect(normalizeTierModels(null)).toEqual({ valid: true, issues: [], value: {} });
    expect(normalizeTierModels('not json').valid).toBe(false);
    expect(normalizeTierModels([]).valid).toBe(false);
  });

  it('drops empty rows from the canonical value', () => {
    const res = normalizeTierModels({ judgment: {}, fallback: { claude: '' } });
    expect(res.valid).toBe(true);
    expect(res.value).toEqual({});
  });
});

describe('parseTierModels', () => {
  it('is lenient: whatever validates survives, the rest is dropped', () => {
    expect(
      parseTierModels('{"judgment":{"claude":"us.anthropic.claude-opus-4-6","cursor":"x"}}'),
    ).toEqual({ judgment: { claude: 'us.anthropic.claude-opus-4-6' } });
    expect(parseTierModels('broken')).toEqual({});
    expect(parseTierModels(null)).toEqual({});
  });
});

describe('mergeTierModels', () => {
  it('merges field-wise: the project value wins per row per CLI, global fills gaps', () => {
    const merged = mergeTierModels(
      { judgment: { claude: 'us.anthropic.claude-opus-4-6' }, quorum: { kiro: 'k-project' } },
      {
        judgment: { claude: 'us.anthropic.claude-sonnet-4-6', kiro: 'k-global' },
        fallback: { claude: 'us.anthropic.claude-haiku-4-5' },
      },
    );
    expect(merged).toEqual({
      judgment: { claude: 'us.anthropic.claude-opus-4-6', kiro: 'k-global' },
      fallback: { claude: 'us.anthropic.claude-haiku-4-5' },
      quorum: { kiro: 'k-project' },
    });
  });

  it('yields {} when neither side configures anything', () => {
    expect(mergeTierModels(null, undefined)).toEqual({});
    expect(mergeTierModels('broken', {})).toEqual({});
  });

  it('exports the canonical row order (three tiers + fallback + quorum)', () => {
    expect(TIER_MODEL_ROWS).toEqual(['judgment', 'balanced', 'templated', 'fallback', 'quorum']);
  });
});
