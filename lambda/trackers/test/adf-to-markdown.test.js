import { describe, it, expect } from 'vitest';
import { adfToMarkdown } from '../providers/adf-to-markdown.js';

const doc = (...content) => ({ type: 'doc', version: 1, content });
const para = (...content) => ({ type: 'paragraph', content });
const text = (s, marks) => ({ type: 'text', text: s, ...(marks ? { marks } : {}) });

describe('adfToMarkdown', () => {
  it('returns empty string for null / non-doc input', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(undefined)).toBe('');
    expect(adfToMarkdown({})).toBe('');
    expect(adfToMarkdown({ type: 'paragraph', content: [text('hi')] })).toBe('');
    expect(adfToMarkdown({ type: 'doc' })).toBe('');
  });

  it('renders a plain paragraph', () => {
    expect(adfToMarkdown(doc(para(text('Hello world'))))).toBe('Hello world');
  });

  it('renders headings 1-6', () => {
    for (let level = 1; level <= 6; level++) {
      const adf = doc({ type: 'heading', attrs: { level }, content: [text(`H${level}`)] });
      expect(adfToMarkdown(adf)).toBe(`${'#'.repeat(level)} H${level}`);
    }
  });

  it('clamps heading level to 1..6', () => {
    expect(
      adfToMarkdown(doc({ type: 'heading', attrs: { level: 99 }, content: [text('big')] })),
    ).toBe('###### big');
    expect(
      adfToMarkdown(doc({ type: 'heading', attrs: { level: 0 }, content: [text('zero')] })),
    ).toBe('# zero');
  });

  it('applies strong / em / code text marks', () => {
    const adf = doc(
      para(
        text('plain '),
        text('bold', [{ type: 'strong' }]),
        text(' '),
        text('italic', [{ type: 'em' }]),
        text(' '),
        text('mono', [{ type: 'code' }]),
      ),
    );
    expect(adfToMarkdown(adf)).toBe('plain **bold** _italic_ `mono`');
  });

  it('renders link marks as [text](href)', () => {
    const adf = doc(
      para(text('See '), text('docs', [{ type: 'link', attrs: { href: 'https://example.com' } }])),
    );
    expect(adfToMarkdown(adf)).toBe('See [docs](https://example.com)');
  });

  it('renders mentions as @handle', () => {
    const adf = doc(
      para(text('cc '), {
        type: 'mention',
        attrs: { id: 'abc', text: '@alice', displayName: 'Alice' },
      }),
    );
    expect(adfToMarkdown(adf)).toBe('cc @@alice');
  });

  it('renders hardBreak as a markdown line break', () => {
    const adf = doc(para(text('line one'), { type: 'hardBreak' }, text('line two')));
    expect(adfToMarkdown(adf)).toBe('line one  \nline two');
  });

  it('renders inlineCode nodes', () => {
    const adf = doc(para(text('use '), { type: 'inlineCode', text: 'foo()' }));
    expect(adfToMarkdown(adf)).toBe('use `foo()`');
  });

  it('renders bullet lists', () => {
    const adf = doc({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para(text('first'))] },
        { type: 'listItem', content: [para(text('second'))] },
      ],
    });
    expect(adfToMarkdown(adf)).toBe('- first\n- second');
  });

  it('renders ordered lists', () => {
    const adf = doc({
      type: 'orderedList',
      content: [
        { type: 'listItem', content: [para(text('alpha'))] },
        { type: 'listItem', content: [para(text('beta'))] },
      ],
    });
    expect(adfToMarkdown(adf)).toBe('1. alpha\n2. beta');
  });

  it('renders codeBlock with language', () => {
    const adf = doc({
      type: 'codeBlock',
      attrs: { language: 'js' },
      content: [text('const x = 1;')],
    });
    expect(adfToMarkdown(adf)).toBe('```js\nconst x = 1;\n```');
  });

  it('renders codeBlock without language', () => {
    const adf = doc({
      type: 'codeBlock',
      content: [text('plain code')],
    });
    expect(adfToMarkdown(adf)).toBe('```\nplain code\n```');
  });

  it('emits an Unsupported placeholder for unknown block types', () => {
    const adf = doc({ type: 'tableRow', content: [] });
    expect(adfToMarkdown(adf)).toBe('> _Unsupported Jira block: tableRow_');
  });

  it('emits an Unsupported placeholder for unknown inline types', () => {
    const adf = doc(para(text('check '), { type: 'emoji', attrs: { shortName: ':smile:' } }));
    expect(adfToMarkdown(adf)).toBe('check > _Unsupported Jira block: emoji_');
  });

  it('joins multiple blocks with a blank line', () => {
    const adf = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
      para(text('First paragraph.')),
      para(text('Second paragraph.')),
    );
    expect(adfToMarkdown(adf)).toBe('## Title\n\nFirst paragraph.\n\nSecond paragraph.');
  });

  it('applies multiple marks on the same text node in source order', () => {
    // Marks are applied in iteration order (strong wraps first, link wraps the
    // already-bold text). Real Jira content combines these regularly.
    const strongLink = doc(
      para(
        text('See ', undefined),
        text('docs', [
          { type: 'strong' },
          { type: 'link', attrs: { href: 'https://example.com' } },
        ]),
      ),
    );
    expect(adfToMarkdown(strongLink)).toBe('See [**docs**](https://example.com)');
  });

  it('renders a link with a missing href as [text]()', () => {
    const adf = doc(para(text('see ', undefined), text('here', [{ type: 'link', attrs: {} }])));
    expect(adfToMarkdown(adf)).toBe('see [here]()');
  });

  it('renders adjacent text runs that each carry the same link mark as two separate links', () => {
    // Atlassian's ADF often splits a single visible link across multiple text
    // nodes (e.g. when one half is bold). The renderer applies the mark per
    // node, so we end up with two adjacent [text](url) — not ideal markdown,
    // but a faithful round-trip of what Jira gave us.
    const url = 'https://example.com';
    const adf = doc(
      para(
        text('docs', [{ type: 'link', attrs: { href: url } }]),
        text(' page', [{ type: 'link', attrs: { href: url } }]),
      ),
    );
    expect(adfToMarkdown(adf)).toBe(`[docs](${url})[ page](${url})`);
  });

  it('renders a nested bullet list with a continuation-line indent', () => {
    // listItem -> [paragraph, bulletList(listItem(paragraph))]. Exercises
    // the `renderListItem` continuation-line indenter (lines 43-50) which
    // was previously uncovered; flat single-paragraph items don't trigger it.
    const adf = doc({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            para(text('outer')),
            {
              type: 'bulletList',
              content: [
                { type: 'listItem', content: [para(text('inner-a'))] },
                { type: 'listItem', content: [para(text('inner-b'))] },
              ],
            },
          ],
        },
        { type: 'listItem', content: [para(text('sibling'))] },
      ],
    });
    expect(adfToMarkdown(adf)).toBe('- outer\n\n  - inner-a\n  - inner-b\n- sibling');
  });
});
