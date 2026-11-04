import { describe, expect, it } from 'vitest';
import { htmlH2Headings, isHtmlDocument, sectionHeadings } from '../html-artifact.js';

// guards: contract S5 S6
describe('section headings and comment-aware HTML detection', () => {
  // guards: contract S5
  it('Given a Markdown body and an HTML body with repeated section headings, when their section headings are read, then each yields its de-duplicated `## <text>` heading lines', () => {
    const markdown = '# Title\n\n## Login\ntext\n  ## Home  \n## Login\n### Sub\n';
    const html =
      '<!doctype html><html><body><h2>Login</h2><p>x</p><h2>Home</h2><h2>Login</h2></body></html>';

    expect(sectionHeadings(markdown)).toEqual(['## Login', '## Home']);
    expect(sectionHeadings(html)).toEqual(['## Login', '## Home']);
  });

  // guards: contract S6
  it('Given HTML that starts with a comment closed by `--!>`, an empty `<!-->` or `<!--->` comment, when it is checked as an HTML document and its h2 headings are read, then it counts as an HTML document and a heading inside the comment is ignored while a heading after `--!>` is counted', () => {
    const bangClosed = '<!-- note --!>\n<!doctype html><html><body></body></html>';
    const emptyShort = '<!--><!doctype html><html><body></body></html>';
    const emptyDash = '<!---><!doctype html><html><body></body></html>';

    expect([bangClosed, emptyShort, emptyDash].map(isHtmlDocument)).toEqual([true, true, true]);
    expect(htmlH2Headings('<body><!-- <h2>Hidden</h2> --!><h2>Shown</h2></body>')).toEqual([
      'Shown',
    ]);
  });
});
