import { describe, it, expect } from 'vitest';
import {
  extractArtifactStructure,
  validateStructuredBlock,
  extractCitations,
  splitSections,
  extractDeclaredArtifactStructure,
} from '../artifact-extractors.js';
import { REGISTRY } from '../artifact-extractors.js';
import { renderStructureContract } from '../artifact-structure-contract.js';

describe('content-declared structure', () => {
  it.each(Object.keys(REGISTRY))(
    'reads the established %s authoring contract without a filename hint',
    (type) => {
      const content = `\uFEFF# Exact document\r\n${renderStructureContract(type).replaceAll('\n', '\r\n')}`;
      const result = extractDeclaredArtifactStructure({ artifactId: 'file', content });
      expect(result.incompatible).toBe(false);
      expect(result.items.some((item) => item.artifactType === type)).toBe(true);
      for (const item of result.items) {
        const source = content
          .split(/\r?\n/)
          .slice(item.startLine - 1, item.endLine)
          .join('\n');
        expect(source).toMatch(/^```yaml\n/);
        expect(source).toMatch(/\n```$/);
      }
    },
  );

  it('ignores headings and nested examples in fences, preserving exact source line numbers', () => {
    const content =
      '\uFEFF# T\r\n## Real\r\n````text\r\n## Fake\r\n```yaml\r\nrequirements:\r\n  - id: r1\r\n    title: Fake\r\n```\r\n````\r\n## Other\r\ntext';
    const result = extractDeclaredArtifactStructure({ content });
    expect(result.sections.map((section) => [section.heading, section.startLine])).toEqual([
      ['Real', 2],
      ['Other', 11],
    ]);
    expect(result.items).toEqual([]);
  });

  it.each([
    'requirements: [null]',
    'requirements: [{title: Missing id}]',
    'requirements: [{id: r1, title: [not, text]}]',
    'requirements: {id: not-a-list}',
    'requirements:\n  - &a {id: req-one, title: One}\n  - *a',
    'requirements: [{id: a, title: A, extra: &x [*x]}]',
    'requirements: [invalid',
  ])('keeps generic sections when the declared block is incompatible: %s', (body) => {
    const result = extractDeclaredArtifactStructure({
      content: `## Readable\n\`\`\`yaml\n${body}\n\`\`\``,
    });
    expect(result.incompatible).toBe(true);
    expect(result.sections[0].heading).toBe('Readable');
    expect(result.items).toEqual([]);
  });
});

describe('artifact extractors', () => {
  it('splits markdown into H2+ sections with stable slugs and hashes', () => {
    const sections = splitSections(
      '# Title\n\n## Functional Requirements\nA\n### Nested\nB\n## Constraints\nC',
    );
    expect(sections.map((s) => s.slug)).toEqual([
      'functional-requirements',
      'nested',
      'constraints',
    ]);
    expect(sections[0]).toMatchObject({ heading: 'Functional Requirements', level: 2, order: 0 });
    expect(sections[0].content).toBe('A');
    expect(sections[0].contentHash).toHaveLength(64);
  });

  it('harvests wikilink artifact citations', () => {
    expect(
      extractCitations(
        'Uses [[requirements]] and [[component-dependency]]. Again [[requirements]].',
      ),
    ).toEqual(['component-dependency', 'requirements']);
  });

  it('extracts typed story items from a fenced yaml block', () => {
    const out = extractArtifactStructure({
      artifactType: 'stories',
      artifactId: 'artifact-1',
      content: [
        '## Stories',
        '',
        '```yaml',
        'stories:',
        '  - id: story-login',
        '    title: Login',
        '    persona: Admin',
        '    priority: Must Have',
        '    acceptance_criteria:',
        '      - Valid credentials sign in',
        '    covers: [req-auth]',
        '```',
        '',
        'References [[requirements]].',
      ].join('\n'),
    });
    expect(out.structuredPresent).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ slug: 'story-login', label: 'Story', title: 'Login' });
    expect(JSON.parse(out.items[0].props.acceptance_criteria)).toEqual([
      'Valid credentials sign in',
    ]);
    expect(out.citations).toEqual(['requirements']);
  });

  it('combines matching yaml blocks in document order', () => {
    const out = extractArtifactStructure({
      artifactType: 'requirements',
      content: [
        '## Requirements',
        '',
        '```yaml',
        'requirements:',
        '  - id: req-sign-in',
        '    title: Sign in',
        '```',
        '',
        '## Non-functional requirements',
        '',
        '```yaml',
        'requirements:',
        '  - id: req-fast-response',
        '    title: Fast response',
        '    category: non-functional',
        '```',
      ].join('\n'),
    });

    expect(out.structuredPresent).toBe(true);
    expect(out.items.map((item) => item.slug)).toEqual(['req-sign-in', 'req-fast-response']);
    expect(out.items[1].props.category).toBe('non-functional');
  });

  it('falls back to sections and citations for unknown artifact types', () => {
    const out = extractArtifactStructure({
      artifactType: 'unknown',
      content: '## Notes\nSee [[requirements]].',
    });
    expect(out.structuredKey).toBeNull();
    expect(out.items).toEqual([]);
    expect(out.sections.map((s) => s.heading)).toEqual(['Notes']);
    expect(out.citations).toEqual(['requirements']);
  });
});

describe('validateStructuredBlock', () => {
  const wrap = (yaml) => `## X\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n`;

  it('is ok for a well-formed registered block', () => {
    expect(
      validateStructuredBlock({
        artifactType: 'requirements',
        content: wrap('requirements:\n  - id: r1\n    title: R'),
      }),
    ).toEqual({ ok: true, error: null });
  });

  it('flags a malformed block (unquoted leading quote)', () => {
    const r = validateStructuredBlock({
      artifactType: 'requirements',
      content: wrap(
        'requirements:\n  - id: r1\n    acceptance_criteria:\n      - "Retry" is shown',
      ),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bad indentation|unexpected/i);
  });

  it('is ok for an unregistered type even with broken yaml', () => {
    expect(
      validateStructuredBlock({ artifactType: 'design', content: wrap('not: [valid') }),
    ).toEqual({ ok: true, error: null });
  });

  it('is ok when a registered type has no block present', () => {
    expect(
      validateStructuredBlock({ artifactType: 'requirements', content: '## Only prose' }),
    ).toEqual({ ok: true, error: null });
  });
});
