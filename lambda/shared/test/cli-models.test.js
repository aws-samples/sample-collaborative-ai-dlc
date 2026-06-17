import { describe, it, expect } from 'vitest';
import { normalizeCliModels, parseCliModels } from '../cli-models.js';

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
          message: 'Unknown model key "cursor". Allowed: kiro, claude, opencode.',
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
});

describe('parseCliModels', () => {
  it('returns an empty object for invalid stored values', () => {
    expect(parseCliModels('{not-json')).toEqual({});
  });

  it('keeps valid entries when stored values contain unsupported keys', () => {
    expect(parseCliModels({ kiro: 'ok', cursor: 'ignored' })).toEqual({ kiro: 'ok' });
  });
});
