// Visual artifacts may be stored as a complete, static HTML document instead of
// markdown. Keep HTML_DOCUMENT_RE in sync with
// frontend/src/components/intent/ArtifactHtmlFrame.tsx, which renders them.

const HTML_DOCUMENT_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html[\s>]|<html[\s>])/i;

// Every other type is read as markdown downstream (sections, YAML blocks, questions).
export const HTML_ARTIFACT_TYPES = Object.freeze(['wireframes', 'user-flow', 'mockups']);

export const isHtmlDocument = (content) =>
  typeof content === 'string' && HTML_DOCUMENT_RE.test(content);

// Returns null when the content may be written, otherwise the reason it is refused.
export const htmlArtifactRefusal = (artifactType, content) => {
  if (!isHtmlDocument(content) || HTML_ARTIFACT_TYPES.includes(artifactType)) return null;
  return (
    `Artifact type \`${artifactType}\` must be markdown. HTML is accepted only for ` +
    `${HTML_ARTIFACT_TYPES.join(', ')}.`
  );
};

const H2_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

const textOf = (html) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();

// The visible text of each non-empty <h2>, in document order.
export const htmlH2Headings = (html) =>
  [...String(html).replace(COMMENT_RE, '').matchAll(H2_RE)]
    .map((m) => textOf(m[1]))
    .filter(Boolean);
