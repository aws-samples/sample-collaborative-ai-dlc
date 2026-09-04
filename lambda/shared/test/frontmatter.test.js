import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../frontmatter.js';

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

  it('handles a non-string input safely', () => {
    expect(parseFrontmatter(undefined)).toEqual({ data: {}, body: '' });
  });
});
