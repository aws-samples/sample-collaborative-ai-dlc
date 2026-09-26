import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../frontmatter.js';
import { FrontmatterParseError, parseFrontmatterStrict, splitFrontmatter } from '../frontmatter.js';

describe('parseFrontmatter', () => {
  it('splits YAML frontmatter from the body', () => {
    const { data, body } = parseFrontmatter(
      '---\nname: foo\ndepth: Standard\n---\n# Title\n\nProse',
    );
    expect(data).toEqual({ name: 'foo', depth: 'Standard' });
    expect(body).toBe('# Title\n\nProse');
  });

  it('parses nested + list YAML', () => {
    const { data } = parseFrontmatter(
      '---\nconsumes:\n  - artifact: requirements\n    required: true\n---\nbody',
    );
    expect(data.consumes).toEqual([{ artifact: 'requirements', required: true }]);
  });

  it('returns the whole file as body when there is no frontmatter', () => {
    const text = '# Org-Level Rules\n\nFramework defaults.';
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toBe(text);
  });

  it('treats malformed frontmatter as no frontmatter (recoverable body)', () => {
    const text = '---\nname: [unclosed\n---\nbody';
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toBe(text);
  });

  it('keeps the body after parseable non-object frontmatter', () => {
    expect(parseFrontmatter('---\nscalar\n---\nbody')).toEqual({ data: {}, body: 'body' });
    expect(parseFrontmatter('---\n- list\n---\nbody')).toEqual({ data: {}, body: 'body' });
  });

  it('handles a non-string input safely', () => {
    expect(parseFrontmatter(undefined)).toEqual({ data: {}, body: '' });
  });
});

describe('parseFrontmatterStrict', () => {
  it('keeps files without frontmatter recoverable', () => {
    expect(parseFrontmatterStrict('# Rules')).toEqual({ data: {}, body: '# Rules' });
  });

  it('throws a typed path-aware diagnostic for malformed YAML', () => {
    expect(() =>
      parseFrontmatterStrict('---\ncommand: {{INVOKE}} engine sensor-linter\n---\nbody', {
        path: 'core/sensors/aidlc-linter.md',
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'FrontmatterParseError',
        code: 'frontmatter_invalid_yaml',
        path: 'core/sensors/aidlc-linter.md',
        line: expect.any(Number),
        column: expect.any(Number),
      }),
    );
  });

  it('rejects a leading frontmatter fence without a closing fence', () => {
    expect(() =>
      parseFrontmatterStrict('---\nname: unfinished\nbody', { path: 'core/scopes/x.md' }),
    ).toThrowError(
      expect.objectContaining({
        code: 'frontmatter_unclosed',
        path: 'core/scopes/x.md',
        line: 1,
        column: 1,
      }),
    );
  });

  it('rejects a scalar frontmatter document', () => {
    expect(() => parseFrontmatterStrict('---\njust-a-string\n---\nbody')).toThrow(
      FrontmatterParseError,
    );
  });
});

describe('splitFrontmatter', () => {
  it('returns the raw frontmatter source for profile normalization', () => {
    expect(splitFrontmatter('---\nname: foo\n---\nbody')).toEqual({
      hasFrontmatter: true,
      source: 'name: foo',
      body: 'body',
      text: '---\nname: foo\n---\nbody',
    });
  });
});
