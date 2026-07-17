import { describe, it, expect } from 'vitest';
import {
  extractArtifactStructure,
  validateStructuredBlock,
  extractCitations,
  splitSections,
} from '../artifact-extractors.js';

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
