import { describe, expect, it } from 'vitest';
import { htmlArtifactRefusal, htmlH2Headings } from '../html-artifact.js';

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
