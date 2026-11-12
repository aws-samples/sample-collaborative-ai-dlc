import { describe, expect, it } from 'vitest';
import { htmlArtifactRefusal, htmlH2Headings, isHtmlDocument } from '../html-artifact.js';

const PAGE = '<!doctype html><html><body><h2>Login</h2><h2>Home</h2></body></html>';

describe('htmlArtifactRefusal', () => {
  it.each([
    ['wireframes', PAGE, false],
    ['user-flow', PAGE, false],
    ['mockups', PAGE, false],
    ['requirements', PAGE, true],
    ['rough-mockups-questions', PAGE, true],
    ['requirements', '## A\n\n<details>inline</details>\n\n## B', false],
  ])('%s with %j is refused: %s', (artifactType, content, refused) => {
    const reason = htmlArtifactRefusal(artifactType, content);
    if (refused) expect(reason).toMatch(/must be markdown.*wireframes, user-flow, mockups/);
    else expect(reason).toBeNull();
  });
});

describe('htmlH2Headings', () => {
  it('returns the visible text of each non-empty, uncommented <h2>', () => {
    expect(
      htmlH2Headings('<h2 id="a">Log<b>in</b> &amp;  out</h2><h2> </h2><!--<h2>Old</h2>-->'),
    ).toEqual(['Login & out']);
  });
});

describe('comment scanning', () => {
  it('ends a leading comment at its first terminator', () => {
    expect(isHtmlDocument('<!-- a --> <!-- b --!>\n<!doctype html><html></html>')).toBe(true);
    expect(isHtmlDocument('<!-- a --> text --> <html></html>')).toBe(false);
    expect(isHtmlDocument('<!-- never closed <html></html>')).toBe(false);
  });

  // A backtracking pattern needs longer than the test timeout for each of these.
  it('reads a body made of comment delimiters in linear time', () => {
    expect(isHtmlDocument(`<!--${'--><!--'.repeat(50_000)}`)).toBe(false);
    expect(isHtmlDocument(`${'<!-->'.repeat(50_000)}x`)).toBe(false);
    expect(isHtmlDocument(`${'<!-- a -->\n'.repeat(50_000)}<html></html>`)).toBe(true);
    expect(htmlH2Headings(`<h2>Shown</h2>${'<!--'.repeat(250_000)}`)).toEqual(['Shown']);
  });
});
