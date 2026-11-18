import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Code, Eye } from 'lucide-react';

// Renders HTML in a bounded sandbox without scripts or same-origin access.
// Keep isHtmlDocument and HTML_ARTIFACT_TYPES in sync with
// lambda/shared/html-artifact.js; the frontend is a separate package and cannot
// import it.

// Comments are scanned, not matched by one backtracking pattern: a pattern that
// may end a comment at any later `-->` takes exponential time on a body made of
// comment delimiters, which would freeze the tab that opens the artifact.
const SPACE_RE = /\s*/y;
const COMMENT_CLOSE_RE = /--!?>/g;
const DOCUMENT_START_RE = /<!doctype\s+html[\s>]|<html[\s>]/iy;

const skipSpace = (text: string, from: number): number => {
  SPACE_RE.lastIndex = from;
  SPACE_RE.test(text);
  return SPACE_RE.lastIndex;
};

// The index after the comment that opens at `open`, or -1 when it never closes.
// A comment closes at its first `-->` or legacy `--!>`; `<!-->` and `<!--->`
// are empty comments.
const commentEnd = (text: string, open: number): number => {
  const body = open + 4;
  if (text.startsWith('>', body)) return body + 1;
  if (text.startsWith('->', body)) return body + 2;
  COMMENT_CLOSE_RE.lastIndex = body;
  return COMMENT_CLOSE_RE.test(text) ? COMMENT_CLOSE_RE.lastIndex : -1;
};

export const HTML_ARTIFACT_TYPES: readonly string[] = Object.freeze([
  'wireframes',
  'user-flow',
  'mockups',
]);

// Whether the content opens with `<!doctype html` or `<html`, after any leading
// whitespace and comments.
export const isHtmlDocument = (content: string | null | undefined): boolean => {
  if (typeof content !== 'string') return false;
  let at = skipSpace(content, 0);
  while (content.startsWith('<!--', at)) {
    const end = commentEnd(content, at);
    if (end === -1) return false;
    at = skipSpace(content, end);
  }
  DOCUMENT_START_RE.lastIndex = at;
  return DOCUMENT_START_RE.test(content);
};

// A non-visual type (e.g. `requirements`) stored as HTML before the backend
// guards must not pick the page renderer.
export const rendersAsHtml = (
  artifactType: string | null | undefined,
  content: string | null | undefined,
): boolean => isHtmlDocument(content) && HTML_ARTIFACT_TYPES.some((type) => type === artifactType);

// Blocks every network fetch from the page: only inline CSS and data: URIs load.
export const ARTIFACT_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// Removes what could navigate the frame; CSP does not restrict a frame's own
// navigation, and attributes are not enough of a guard because SMIL re-adds them
// at runtime (<set attributeName="href"> runs without allow-scripts). The elements
// that carry navigation semantics go instead: every <a> becomes an element that
// has none, keeping its children and its other attributes (a <span>, or an SVG <g>
// for an SVG <a> so its drawing children still render), and <area>, <base> and
// <link> are dropped outright. <link> is not navigation but rel=dns-prefetch
// resolves a host outside CSP, and so does a meta x-dns-prefetch-control that
// turns it on. SMIL changes attributes without scripts, so its elements go too.
//
// A nested browsing context or plugin (<iframe>, <frame>, <frameset>, <object>,
// <embed>, <portal>, <fencedframe>) carries its document in attributes this parse
// never reads, so an <iframe srcdoc> ships markup the sanitizer has not seen,
// links and all. Static mockups need none of them, so they go outright.
//
// A <template shadowrootmode> stays inert to this parse and its children live in
// template.content, which querySelectorAll does not search. The frame's parse
// attaches that shadow root and its links become live, so the attribute goes (the
// template then stays inert there too) and the removals repeat inside every
// template, nested ones included.
const stripFrameNavigation = (root: Document | DocumentFragment) => {
  const owner = root instanceof Document ? root : root.ownerDocument;
  root.querySelectorAll('a').forEach((link) => {
    const replacement =
      link.namespaceURI === SVG_NAMESPACE
        ? owner.createElementNS(SVG_NAMESPACE, 'g')
        : owner.createElement('span');
    for (const attribute of Array.from(link.attributes)) {
      if (attribute.localName === 'href') continue;
      replacement.setAttribute(attribute.name, attribute.value);
    }
    while (link.firstChild) replacement.appendChild(link.firstChild);
    link.replaceWith(replacement);
  });
  root
    .querySelectorAll(
      'area, base, link, iframe, frame, frameset, object, embed, portal, fencedframe',
    )
    .forEach((element) => element.remove());
  // The camelCase spellings are not a typo: in foreign content the parser
  // corrects `animatemotion` to `animateMotion`, and a type selector then has to
  // name that spelling exactly.
  root
    .querySelectorAll('set, animate, animateMotion, animateTransform, animateColor, discard')
    .forEach((element) => element.remove());
  root.querySelectorAll('meta[http-equiv]').forEach((meta) => {
    const httpEquiv = meta.getAttribute('http-equiv')?.trim().toLowerCase();
    if (httpEquiv === 'refresh' || httpEquiv === 'x-dns-prefetch-control') meta.remove();
  });
  root.querySelectorAll('template').forEach((template) => {
    template.removeAttribute('shadowrootmode');
    template.removeAttribute('shadowroot');
    stripFrameNavigation(template.content);
  });
};

// Anything in a parse of the srcdoc that could move the frame to a page of its
// own, reach the network around CSP or start a document of its own: an <a> at all,
// since a sanitizer that left one would have left a navigable one, and a nested
// browsing context, whose document the sanitizer never parses.
const FRAME_NAVIGATION_SELECTOR =
  'a, area, base, link, iframe, frame, frameset, object, embed, portal, fencedframe, set, animate, animateMotion, animateTransform, animateColor, discard, meta[http-equiv="refresh" i], meta[http-equiv="x-dns-prefetch-control" i], template[shadowrootmode]';

const carriesFrameNavigation = (root: Document | DocumentFragment): boolean =>
  root.querySelector(FRAME_NAVIGATION_SELECTOR) !== null ||
  Array.from(root.querySelectorAll('template')).some((template) =>
    carriesFrameNavigation(template.content),
  );

export const buildArtifactSrcDoc = (content: string): string => {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', ARTIFACT_HTML_CSP);
  doc.head.prepend(csp);
  stripFrameNavigation(doc);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
};

// The srcdoc is handed to the frame as a string and parsed a second time, and
// that parse can differ: foreign-content confusion (math, svg and form nesting)
// serializes to markup that re-parses into another tree, turning attribute text
// into a live link. So the sanitizer's output has to be a fixpoint of itself and
// that re-parse has to carry nothing that can navigate.
export const isStableSrcDoc = (srcDoc: string): boolean => {
  const doc = new DOMParser().parseFromString(srcDoc, 'text/html');
  if (carriesFrameNavigation(doc)) return false;
  return `<!doctype html>${doc.documentElement.outerHTML}` === srcDoc;
};

export function ArtifactHtmlFrame({ content, title }: { content: string; title?: string | null }) {
  const [view, setView] = useState<'rendered' | 'source'>('rendered');

  // Live events re-render the panel; the srcdoc only changes with its content.
  // A srcdoc the frame would parse into something else is not shown at all.
  const srcDoc = useMemo(() => {
    const built = buildArtifactSrcDoc(content);
    return isStableSrcDoc(built) ? built : null;
  }, [content]);

  return (
    <div className="not-prose mt-2" data-testid="artifact-html">
      <div className="mb-1 flex items-center justify-end gap-1">
        <span className="mr-auto text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          HTML
        </span>
        <Button
          size="sm"
          variant={view === 'rendered' ? 'secondary' : 'ghost'}
          className="h-6 gap-1 px-2 text-[11px]"
          aria-pressed={view === 'rendered'}
          onClick={() => setView('rendered')}
        >
          <Eye className="h-3 w-3" />
          Rendered
        </Button>
        <Button
          size="sm"
          variant={view === 'source' ? 'secondary' : 'ghost'}
          className="h-6 gap-1 px-2 text-[11px]"
          aria-pressed={view === 'source'}
          onClick={() => setView('source')}
        >
          <Code className="h-3 w-3" />
          Source
        </Button>
      </div>

      {srcDoc && view === 'rendered' ? (
        <iframe
          title={title ? `${title} (HTML artifact)` : 'HTML artifact'}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className="block h-[70vh] max-h-[720px] min-h-[240px] w-full rounded-md border bg-white"
        />
      ) : (
        <div className="space-y-1">
          {!srcDoc && (
            <p className="text-xs text-muted-foreground" data-testid="artifact-html-refusal">
              This page could not be displayed safely; showing its source.
            </p>
          )}
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs">
            <code>{content}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
