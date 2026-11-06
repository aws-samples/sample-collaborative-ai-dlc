import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactHtmlFrame,
  buildArtifactSrcDoc,
  isHtmlDocument,
  isStableSrcDoc,
} from '@/components/intent/ArtifactHtmlFrame';
import { ArtifactContent } from '@/components/intent/ArtifactContent';
import { ArtifactMarkdown } from '@/components/intent/ArtifactMarkdown';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

const PAGE = '<!DOCTYPE html><html><body><h1>Wireframes</h1></body></html>';

// Markup whose serialization re-parses into a different tree (foreign-content
// confusion) and turns attribute text into a live <a href>.
const MUTATING_PAGE =
  '<!doctype html><html><body><form><math><mtext></form><form><mglyph><svg><mtext><style><path id="</style><a href=https://evil.invalid>x</a>">';

// The threat, listed here instead of copied from the sanitizer: the frame's own
// parse must never contain an element that navigates it, reaches the network
// around CSP or starts a document of its own. A nested browsing context or plugin
// keeps its document in attributes this parse never reads, so its subtree is
// markup no sanitizer has seen.
const THREAT_SELECTOR =
  'a, area, base, link, iframe, frame, frameset, object, embed, portal, fencedframe, set, animate, animateMotion, animateTransform, animateColor, discard, meta[http-equiv="refresh" i], meta[http-equiv="x-dns-prefetch-control" i], template[shadowrootmode], template[shadowroot]';

const findThreat = (root: Document | DocumentFragment): Element | null => {
  const direct = root.querySelector(THREAT_SELECTOR);
  if (direct) return direct;
  for (const template of Array.from(root.querySelectorAll('template'))) {
    const nested = findThreat(template.content);
    if (nested) return nested;
  }
  return null;
};

describe('ArtifactHtmlFrame', () => {
  // guards: logic HTML document detection
  it.each([
    ['<!DOCTYPE html><html></html>', true],
    ['  \n<!doctype html>\n<html lang="en"></html>', true],
    ['<!-- generated -->\n<html><body></body></html>', true],
    ['<!-- --!>\n<!doctype html><html></html>', true],
    ['<!-->\n<!doctype html><html></html>', true],
    ['<!--->\n<!doctype html><html></html>', true],
    ['# Requirements\n\n<details>inline HTML in markdown</details>', false],
    ['Text that mentions <html> later', false],
    ['<htmlish>', false],
  ])('detects a full HTML document: %j -> %s', (content, expected) => {
    expect(isHtmlDocument(content)).toBe(expected);
  });

  // guards: security artifact HTML preview script, same-origin and network isolation
  it('renders HTML only through ArtifactContent, in an empty sandbox with the CSP; Markdown stays Markdown', () => {
    const { container, unmount } = render(<ArtifactMarkdown content={PAGE} />);
    expect(container.querySelector('iframe')).toBeNull();
    unmount();

    const { unmount: unmount2 } = render(
      <ArtifactContent artifactType="wireframes" content={PAGE} />,
    );
    const frame = screen.getByTitle('HTML artifact');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame).not.toHaveAttribute('style');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toMatch(
      /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*base-uri 'none'; form-action 'none'">/,
    );
    expect(srcdoc).not.toMatch(/script-src/);
    unmount2();

    const markdown = render(
      <ArtifactContent artifactType="wireframes" content={'# Requirements'} />,
    );
    expect(screen.getByRole('heading', { name: 'Requirements' })).toBeInTheDocument();
    expect(markdown.container.querySelector('iframe')).toBeNull();

    // The renderer follows the artifact type, not the content alone: HTML under a
    // non-visual type stays Markdown (the visual case is rendered above).
    const nonVisual = render(<ArtifactContent artifactType="requirements" content={PAGE} />);
    expect(nonVisual.container.querySelector('iframe')).toBeNull();
    nonVisual.unmount();
  });

  // guards: security artifact HTML preview navigation and network isolation
  it('places the CSP before untrusted markup and disables navigation', () => {
    for (const prefix of ['<!-- --!>', '<!-->', '<!--->']) {
      const content = `${prefix}<img src="https://artifact-review.invalid/prefix"><!-- --><!doctype html><html><head><base href="https://artifact-review.invalid/"><meta http-equiv="ReFrEsH" content="0;url=https://artifact-review.invalid/"></head><body><a href="https://artifact-review.invalid/click?content=x">Link</a><map><area href="https://artifact-review.invalid/" alt="Area"></map><svg><a href="https://artifact-review.invalid/">SVG link</a><a xlink:href="https://artifact-review.invalid/">SVG xlink</a></svg></body></html>`;
      const srcdoc = buildArtifactSrcDoc(content);
      const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
      const csp = doc.head.firstElementChild;
      const image = doc.querySelector('img');

      expect(srcdoc).toMatch(
        /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/,
      );
      expect(csp?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
      expect(csp?.getAttribute('content')).toContain("base-uri 'none'");
      expect(csp?.getAttribute('content')).toContain("form-action 'none'");
      expect(csp?.compareDocumentPosition(image!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(doc.querySelectorAll('base, meta[http-equiv="refresh" i]')).toHaveLength(0);
      expect(doc.querySelectorAll('a, area')).toHaveLength(0);
      expect(
        [...doc.querySelectorAll('span, svg > g')].map((element) => element.textContent),
      ).toEqual(['Link', 'SVG link', 'SVG xlink']);
    }
  });

  // A frame must never move itself, and sanitizing must not be a sledgehammer: each
  // row says whether the input ships a frame or falls back, and a shipped frame has
  // to keep the text it shows. Anything on the threat list anywhere in the shipped
  // srcdoc fails a row, so a stripper that only removed hrefs would pass while one
  // that refused everything would not.
  // guards: security artifact HTML preview navigation through a second parse
  it.each([
    [PAGE, 'renders', 'Wireframes'],
    [
      '<img src="https://artifact-review.invalid/prefix"><!doctype html><html><head><base href="https://artifact-review.invalid/"><meta http-equiv="ReFrEsH" content="0;url=https://artifact-review.invalid/"></head><body><a href="https://artifact-review.invalid/click">Link</a><map><area href="https://artifact-review.invalid/" alt="Area"></map><svg><a href="https://artifact-review.invalid/">SVG link</a><a xlink:href="https://artifact-review.invalid/">SVG xlink</a></svg></body></html>',
      'renders',
      'SVG xlink',
    ],
    [
      '<!doctype html><html><body><h2>Plan</h2><a href="https://artifact-review.invalid/click">Click me</a></body></html>',
      'renders',
      'Click me',
    ],
    // an iframe keeps its document in an attribute this parse never reads, so that
    // document ships unsanitized
    [
      '<!doctype html><html><body><iframe srcdoc="<meta http-equiv=x-dns-prefetch-control content=on><a href=//beacon.evil.invalid>x</a>"></iframe><h2>A</h2></body></html>',
      'renders',
      'A',
    ],
    // a plugin in template.content lands in the shadow root the frame's parse adds
    [
      '<!doctype html><html><body><template shadowrootmode="open"><object data="https://evil.invalid/o"></object><embed src="https://evil.invalid/e"></template><h2>B</h2></body></html>',
      'renders',
      'B',
    ],
    // SMIL hands an element its href at runtime, and runs without allow-scripts
    [
      '<!doctype html><html><body><svg><a><set attributeName="href" to="https://evil.invalid/x"/><text y="20">click</text></a></svg></body></html>',
      'renders',
      'click',
    ],
    [
      '<!doctype html><html><body><svg><a><animate attributeName="xlink:href" values="https://evil.invalid/y"/><text y="20">copy</text></a></svg></body></html>',
      'renders',
      'copy',
    ],
    // the animation elements themselves are gone, not only their targets
    [
      '<!doctype html><html><body><svg><g><set attributeName="href" to="https://evil.invalid/s"/><text y="20">kept-set</text></g></svg></body></html>',
      'renders',
      'kept-set',
    ],
    [
      '<!doctype html><html><body><svg><animateMotion dur="1s" path="M0 0"/><animatetransform attributeName="transform"/><ANIMATECOLOR/><discard/><text y="20">kept-anim</text></svg></body></html>',
      'renders',
      'kept-anim',
    ],
    [
      '<!doctype html><html><body><template shadowrootmode="open"><svg><animate attributeName="href" values="https://evil.invalid/t"/></svg></template><h2>kept-tpl</h2></body></html>',
      'renders',
      'kept-tpl',
    ],
    // rel=dns-prefetch resolves a host from outside CSP
    [
      '<!doctype html><html><head><link rel="dns-prefetch" href="//beacon.evil.invalid"><meta http-equiv="x-dns-prefetch-control" content="on"></head><body><h2>A</h2></body></html>',
      'renders',
      'A',
    ],
    [
      '<!doctype html><html><body><template shadowrootmode="open"><a href="https://evil.invalid/">Open</a></template></body></html>',
      'renders',
      'Open',
    ],
    [
      '<!doctype html><html><body><template shadowrootmode="open"><div><template shadowrootmode="closed"><a href="https://evil.invalid/2">nested link</a></template></div></template></body></html>',
      'renders',
      'nested link',
    ],
    [
      '<!doctype html><html><body><template><svg><a xlink:href="https://evil.invalid/svg"><text>svg link</text></a></svg></template></body></html>',
      'renders',
      'svg link',
    ],
    [MUTATING_PAGE, 'falls back', ''],
  ])('ships a frame that cannot navigate itself: %j', (content, outcome, kept) => {
    const { container } = render(<ArtifactHtmlFrame content={content} />);
    const frame = container.querySelector('iframe');
    if (outcome === 'falls back') {
      expect(frame).toBeNull();
      return;
    }
    const srcdoc = frame?.getAttribute('srcdoc') ?? '';
    expect(frame, content).not.toBeNull();
    expect(srcdoc).toContain(kept);
    const doc = new DOMParser().parseFromString(srcdoc, 'text/html');
    expect(findThreat(doc), srcdoc).toBeNull();
  });

  // guards: security artifact HTML preview refuses markup that mutates on re-parse
  it('shows the source instead of a frame for markup that re-parses differently', () => {
    expect(isStableSrcDoc(buildArtifactSrcDoc(MUTATING_PAGE))).toBe(false);

    const { container } = render(<ArtifactHtmlFrame content={MUTATING_PAGE} />);
    expect(screen.getByTestId('artifact-html-refusal')).toHaveTextContent(
      'This page could not be displayed safely; showing its source.',
    );
    expect(container.querySelector('code')).toHaveTextContent('https://evil.invalid');
  });
});
