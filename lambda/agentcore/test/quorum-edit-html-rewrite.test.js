import { describe, expect, it } from 'vitest';
import { checkRewriteStructure } from '../commands/quorum-edit-shared.js';
import {
  buildTargetRewritePrompt,
  buildDownstreamRewritePrompt,
} from '../commands/quorum-edit-apply-start.js';
import { htmlArtifactRefusal } from '../../shared/html-artifact.js';

const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
const TWO_H2 = page('<h2>Login</h2><p>form</p><h2>Home</h2><p>feed</p>');
const MARKDOWN = '# Wireframes\n\n## Login\n\nform\n\n## Home\n\nfeed\n';
const DEEPER_MARKDOWN = '# Wireframes\n\n### Login\n\nform\n\n### Home\n\nfeed\n';
const check = (before, after) =>
  checkRewriteStructure({ artifactType: 'wireframes', artifactId: 'w1', before, after });
// The same HTML document under a type that may not store HTML.
const checkLegacy = (before, after) =>
  checkRewriteStructure({ artifactType: 'requirements', artifactId: 'r1', before, after });

// guards: contract S1 S2 S3 S4
describe('Quorum rewrites of HTML visual artifacts', () => {
  // guards: contract S1
  it('Given an HTML wireframe with the sections Login and Home, when a Quorum rewrite returns Markdown with the same two headings, then the structure check rejects it because the visual artifact must stay a complete HTML document', () => {
    const result = check(TWO_H2, '## Login\n\n## Home\n');
    const converted = checkLegacy(TWO_H2, '## Login\n\n## Home\n');
    const legacyHtmlAnswer = page('<h2>Login</h2><p>new form</p><h2>Home</h2>');
    const keptHtml = checkLegacy(TWO_H2, legacyHtmlAnswer);
    const flattened = checkLegacy(TWO_H2, 'form and feed\n');

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/complete HTML document/);
    expect(converted).toMatchObject({ ok: true, problems: [] });
    expect(keptHtml.ok).toBe(false);
    expect(keptHtml.problems).toEqual([htmlArtifactRefusal('requirements', legacyHtmlAnswer)]);
    expect(flattened.ok).toBe(false);
    expect(flattened.problems).toEqual(['every section heading was removed']);
  });

  // guards: contract S2
  it('Given a two-section Markdown wireframe or an HTML wireframe with two h2 sections, when a Quorum rewrite returns an HTML document that keeps both sections as h2 headings, then the check accepts it, and when an HTML rewrite of the HTML wireframe drops every h2, then it is rejected because every section heading was removed', () => {
    const fromMarkdown = check(MARKDOWN, TWO_H2);
    const kept = check(TWO_H2, page('<h2>Login</h2><p>new form</p><h2>Home</h2>'));
    const dropped = check(TWO_H2, page('<p>form</p><p>feed</p>'));
    const deeperDropped = check(DEEPER_MARKDOWN, page('<p>form</p><p>feed</p>'));

    expect(fromMarkdown).toMatchObject({ ok: true, problems: [] });
    expect(kept).toMatchObject({ ok: true, problems: [] });
    expect(dropped.ok).toBe(false);
    expect(dropped.problems).toContain('every section heading was removed');
    expect(deeperDropped.ok).toBe(false);
    expect(deeperDropped.problems).toContain('every section heading was removed');
  });

  // guards: contract S3
  it('Given a Markdown document with two sections, when a Quorum rewrite returns Markdown, then the check behaves as before: deeper headings such as ### still count as sections, and dropping every heading is rejected because every section heading was removed', () => {
    const deeper = '# Wireframes\n\n### Login\n\nform\n\n### Home\n\nfeed\n';
    const toDeeper = check(MARKDOWN, deeper);
    const deeperDropped = check('### Login\n\nform\n\n### Home\n\nfeed\n', 'form and feed\n');
    const dropped = check(MARKDOWN, '# Wireframes\n\nform and feed\n');

    expect(toDeeper).toMatchObject({ ok: true, problems: [] });
    expect(deeperDropped.problems).toEqual(['every section heading was removed']);
    expect(dropped.problems).toEqual(['every section heading was removed']);
  });

  // guards: contract S4
  it('Given a document to rewrite, when the target and downstream rewrite prompts are built, then for an HTML document they ask for only the complete updated HTML document as one static, self-contained page, and for a Markdown document they keep the current markdown sentence unchanged', () => {
    const MD_SENTENCE =
      'Respond with ONLY the complete updated markdown document — no commentary, no code fences around the whole document.';
    const upstream = { id: 'u1', title: 'Stories', content: '## A\n' };
    const item = { proposedChange: 'align' };
    const prompts = (content, artifactType = 'wireframes') => {
      const artifact = { id: 'w1', title: 'Wires', artifact_type: artifactType, content };
      return [
        buildTargetRewritePrompt({ artifact, changeDescription: 'rename' }),
        buildDownstreamRewritePrompt({ artifact, upstream, changeDescription: 'rename', item }),
      ];
    };

    for (const prompt of prompts(TWO_H2)) {
      expect(prompt).toContain('ONLY the complete updated HTML document');
      expect(prompt).toMatch(/static, self-contained HTML page/);
      expect(prompt).not.toContain(MD_SENTENCE);
      expect(prompt).toContain(
        'Keep every `<h2>` section heading; restructure only where the change requires it.',
      );
    }
    for (const prompt of prompts(MARKDOWN)) expect(prompt).toContain(MD_SENTENCE);
    for (const prompt of prompts(TWO_H2, 'requirements')) {
      expect(prompt).toContain(`${MD_SENTENCE} This document is currently HTML`);
      expect(prompt).toContain('convert it and keep each `<h2>` section as a `##` heading.');
      expect(prompt).toContain('Keep the markdown section headings');
    }
  });
});
