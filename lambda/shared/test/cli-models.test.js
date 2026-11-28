import { describe, it, expect } from 'vitest';
import {
  normalizeCliModels,
  parseCliModels,
  mergeCliModels,
  patchCliModels,
  describeCliModelsChange,
} from '../cli-models.js';

describe('normalizeCliModels', () => {
  it('trims supported model keys and omits empty values', () => {
    expect(normalizeCliModels({ kiro: ' kiro-model ', opencode: '' })).toEqual({
      valid: true,
      issues: [],
      value: { kiro: 'kiro-model' },
    });
  });

  it('rejects unknown model keys', () => {
    expect(normalizeCliModels({ cursor: 'not-supported' })).toEqual({
      valid: false,
      issues: [
        {
          path: 'cursor',
          message: 'Unknown model key "cursor". Allowed: kiro, claude, opencode, codex.',
        },
      ],
      value: {},
    });
  });

  it('accepts a bare Bedrock inference profile ID for Claude', () => {
    expect(normalizeCliModels({ claude: ' us.anthropic.claude-opus-4-8 ' })).toEqual({
      valid: true,
      issues: [],
      value: { claude: 'us.anthropic.claude-opus-4-8' },
    });
  });

  it('rejects Claude model values with the amazon-bedrock provider prefix', () => {
    const result = normalizeCliModels({ claude: 'amazon-bedrock/us.anthropic.claude-opus-4-8' });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      {
        path: 'claude',
        message:
          'Claude model must be a bare Bedrock inference profile ID (no "amazon-bedrock/" prefix).',
      },
    ]);
  });

  it('accepts valid JSON strings', () => {
    expect(normalizeCliModels('{"opencode":"amazon-bedrock/model"}')).toEqual({
      valid: true,
      issues: [],
      value: { opencode: 'amazon-bedrock/model' },
    });
  });

  it('rejects non-string values', () => {
    const result = normalizeCliModels({ kiro: 123 });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([{ path: 'kiro', message: 'Expected string; got number.' }]);
  });

  it('rejects values longer than 200 characters', () => {
    const result = normalizeCliModels({ kiro: 'x'.repeat(201) });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([{ path: 'kiro', message: 'Must be 200 characters or fewer.' }]);
  });

  it('rejects OpenCode model values without the amazon-bedrock provider prefix', () => {
    const result = normalizeCliModels({ opencode: 'us.anthropic.claude-sonnet-4-6' });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      {
        path: 'opencode',
        message: 'OpenCode model must start with "amazon-bedrock/".',
      },
    ]);
  });

  it('accepts an exact openai.* id for Codex', () => {
    expect(normalizeCliModels({ codex: ' openai.gpt-5.5 ' })).toEqual({
      valid: true,
      issues: [],
      value: { codex: 'openai.gpt-5.5' },
    });
  });

  it('rejects Codex model values outside the openai.* namespace', () => {
    for (const bad of ['us.anthropic.claude-sonnet-4-6', 'amazon-bedrock/openai.gpt-5.5']) {
      const result = normalizeCliModels({ codex: bad });
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toMatchObject({ path: 'codex' });
      expect(result.issues[0].message).toContain('openai.');
    }
  });

  it('rejects a bare/incomplete Codex prefix (would fail at invocation time)', () => {
    for (const bad of ['openai.', 'openai. gpt-5.5', 'openai.gpt 5']) {
      const result = normalizeCliModels({ codex: bad });
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toMatchObject({ path: 'codex' });
    }
  });
});

describe('parseCliModels', () => {
  it('returns an empty object for invalid stored values', () => {
    expect(parseCliModels('{not-json')).toEqual({});
  });

  it('keeps valid entries when stored values contain unsupported keys', () => {
    expect(parseCliModels({ kiro: 'ok', cursor: 'ignored' })).toEqual({ kiro: 'ok' });
  });
});

describe('mergeCliModels — project over global', () => {
  it('the project value wins per CLI; global fills the gaps', () => {
    expect(
      mergeCliModels(
        { claude: 'us.anthropic.claude-opus-4-8' },
        { claude: 'us.anthropic.claude-sonnet-4-6', kiro: 'auto' },
      ),
    ).toEqual({ claude: 'us.anthropic.claude-opus-4-8', kiro: 'auto' });
  });

  it('falls back to global entirely when the project has none', () => {
    expect(mergeCliModels({}, { claude: 'us.anthropic.claude-sonnet-4-6' })).toEqual({
      claude: 'us.anthropic.claude-sonnet-4-6',
    });
  });

  it('an empty project value never shadows a global (only truthy contributes)', () => {
    expect(mergeCliModels({ claude: '' }, { claude: 'us.anthropic.claude-sonnet-4-6' })).toEqual({
      claude: 'us.anthropic.claude-sonnet-4-6',
    });
  });

  it('returns {} when neither is set', () => {
    expect(mergeCliModels(null, null)).toEqual({});
    expect(mergeCliModels({}, {})).toEqual({});
  });

  it('accepts JSON strings and drops unsupported keys via parse', () => {
    expect(
      mergeCliModels('{"kiro":"claude-sonnet-4.6"}', '{"kiro":"auto","cursor":"nope"}'),
    ).toEqual({ kiro: 'claude-sonnet-4.6' });
  });
});

describe('patchCliModels — a per-CLI change to a stored map', () => {
  const stored = { claude: 'us.anthropic.claude-opus-4-8', kiro: 'auto' };

  it('sets the named CLI and keeps the others', () => {
    expect(patchCliModels(stored, { claude: ' us.anthropic.claude-sonnet-4-6 ' })).toEqual({
      valid: true,
      issues: [],
      value: { claude: 'us.anthropic.claude-sonnet-4-6', kiro: 'auto' },
      changed: true,
    });
  });

  it('removes a CLI on null and on an empty string', () => {
    expect(patchCliModels(stored, { claude: null, kiro: '  ' })).toMatchObject({
      valid: true,
      value: {},
      changed: true,
    });
  });

  it('reports no change for the stored value, an absent CLI removed, and an empty change', () => {
    for (const change of [{ claude: 'us.anthropic.claude-opus-4-8' }, { codex: null }, {}]) {
      expect(patchCliModels(stored, change)).toMatchObject({
        valid: true,
        value: stored,
        changed: false,
      });
    }
  });

  it('starts from an empty map when nothing is stored', () => {
    expect(patchCliModels(null, { codex: 'openai.gpt-5.5' })).toMatchObject({
      value: { codex: 'openai.gpt-5.5' },
      changed: true,
    });
  });

  it('does not touch the stored map', () => {
    const before = structuredClone(stored);
    patchCliModels(stored, { claude: null });
    expect(stored).toEqual(before);
  });

  it('holds the values to the rules of the space setting', () => {
    const result = patchCliModels(stored, { claude: 'amazon-bedrock/us.anthropic.claude', x: 'y' });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(['claude', 'x']);
    expect(result.value).toBeUndefined();
  });

  it.each([[null], ['{"claude":"us.anthropic.claude-sonnet-4-6"}'], [['claude']], [7]])(
    'refuses %j: a change is an object',
    (change) => {
      expect(patchCliModels(stored, change)).toMatchObject({
        valid: false,
        issues: [{ path: '' }],
      });
    },
  );
});

describe('describeCliModelsChange', () => {
  it('names each CLI whose model was set or removed', () => {
    expect(
      describeCliModelsChange({
        previous: { claude: 'a', kiro: 'auto', codex: 'openai.gpt-5.5' },
        next: { claude: 'b', kiro: 'auto', opencode: 'amazon-bedrock/c' },
      }),
    ).toEqual([
      'Model for claude set to b for this intent',
      'Model for opencode set to amazon-bedrock/c for this intent',
      'Model for codex removed for this intent (was openai.gpt-5.5)',
    ]);
  });

  it('says nothing when no model changed, whether the map is null or empty', () => {
    expect(describeCliModelsChange({ previous: null, next: {} })).toEqual([]);
    expect(describeCliModelsChange({ previous: { claude: 'a' }, next: { claude: 'a' } })).toEqual(
      [],
    );
    expect(describeCliModelsChange()).toEqual([]);
  });
});
