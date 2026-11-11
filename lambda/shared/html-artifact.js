// Visual artifacts may be stored as a complete, static HTML document instead of
// markdown. Keep isHtmlDocument in sync with
// frontend/src/components/intent/ArtifactHtmlFrame.tsx, which renders them.

// Comments are scanned, not matched by one backtracking pattern: content comes
// from agents and users, and a pattern that may end a comment at any later
// `-->` takes exponential time on a body made of comment delimiters.
const SPACE_RE = /\s*/y;
const COMMENT_CLOSE_RE = /--!?>/g;
const DOCUMENT_START_RE = /<!doctype\s+html[\s>]|<html[\s>]/iy;

const skipSpace = (text, from) => {
  SPACE_RE.lastIndex = from;
  SPACE_RE.test(text);
  return SPACE_RE.lastIndex;
};

// The index after the comment that opens at `open`, or -1 when it never closes.
// A comment closes at its first `-->` or legacy `--!>`; `<!-->` and `<!--->`
// are empty comments.
const commentEnd = (text, open) => {
  const body = open + 4;
  if (text.startsWith('>', body)) return body + 1;
  if (text.startsWith('->', body)) return body + 2;
  COMMENT_CLOSE_RE.lastIndex = body;
  return COMMENT_CLOSE_RE.test(text) ? COMMENT_CLOSE_RE.lastIndex : -1;
};

// Every other type is read as markdown downstream (sections, YAML blocks, questions).
export const HTML_ARTIFACT_TYPES = Object.freeze(['wireframes', 'user-flow', 'mockups']);

// Whether the content opens with `<!doctype html` or `<html`, after any leading
// whitespace and comments.
export const isHtmlDocument = (content) => {
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

// Returns null when the content may be written, otherwise the reason it is refused.
export const htmlArtifactRefusal = (artifactType, content) => {
  if (!isHtmlDocument(content) || HTML_ARTIFACT_TYPES.includes(artifactType)) return null;
  return (
    `Artifact type \`${artifactType}\` must be markdown. HTML is accepted only for ` +
    `${HTML_ARTIFACT_TYPES.join(', ')}.`
  );
};

// Whether an HTML document keeps HTML on a rewrite: only the visual types are
// stored as HTML, so a legacy HTML document of any other type converts to
// markdown, the format its type allows.
export const keepsHtml = (artifactType, content) =>
  isHtmlDocument(content) && HTML_ARTIFACT_TYPES.includes(artifactType);

const H2_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

// The document without its comments. An unclosed comment is left in place.
const withoutComments = (html) => {
  let kept = '';
  let at = 0;
  for (let open = html.indexOf('<!--'); open !== -1; open = html.indexOf('<!--', at)) {
    const end = commentEnd(html, open);
    if (end === -1) break;
    kept += html.slice(at, open);
    at = end;
  }
  return kept + html.slice(at);
};

const textOf = (html) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();

// The visible text of each non-empty, uncommented <h2>, in document order.
export const htmlH2Headings = (html) =>
  [...withoutComments(String(html)).matchAll(H2_RE)].map((m) => textOf(m[1])).filter(Boolean);

// The section headings of an artifact body as de-duplicated `## <text>` lines:
// an HTML document's sections are its <h2> elements, a markdown document's are
// its `## ` lines.
export const sectionHeadings = (body) => {
  const lines = isHtmlDocument(body)
    ? htmlH2Headings(body).map((text) => `## ${text}`)
    : String(body ?? '')
        .split(/\r?\n/)
        .map((raw) => raw.trim())
        .filter((line) => line.startsWith('## '));
  return [...new Set(lines)];
};
