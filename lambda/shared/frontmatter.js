// Splits a markdown file into its YAML frontmatter (parsed) and the body that
// follows. Used by the seed job to read the official aidlc-workflows files: the
// structured block fields come from the frontmatter, the prose from the body.
//
// Some block files (rules, knowledge) carry no frontmatter at all — the whole
// file is the body. parseFrontmatter handles that by returning an empty `data`
// object and the full text as `body`.

import yaml from 'js-yaml';

// Matches a leading `---\n … \n---` fence. The body is everything after the
// closing fence (a single trailing newline after the fence is swallowed).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

class FrontmatterParseError extends Error {
  constructor(code, message, { path = null, line = null, column = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FrontmatterParseError';
    this.code = code;
    this.path = path;
    this.line = line;
    this.column = column;
  }
}

const splitFrontmatter = (text) => {
  const src = typeof text === 'string' ? text : '';
  const match = src.match(FRONTMATTER_RE);
  if (!match) {
    return { hasFrontmatter: false, source: '', body: src, text: src };
  }
  return {
    hasFrontmatter: true,
    source: match[1],
    body: match[2] ?? '',
    text: src,
  };
};

// Strict parser for import/certification tooling. Unlike the legacy production
// helper below, malformed or non-object frontmatter is a typed failure carrying
// the source path. Compatibility callers use this API only for diagnostics; the seed
// path keeps its existing behaviour until release-aware import is implemented.
const parseFrontmatterStrict = (text, { path = null } = {}) => {
  const split = splitFrontmatter(text);
  if (!split.hasFrontmatter) {
    if (/^---\r?\n/.test(split.text)) {
      throw new FrontmatterParseError(
        'frontmatter_unclosed',
        `Frontmatter${path ? ` in ${path}` : ''} has no closing fence`,
        { path, line: 1, column: 1 },
      );
    }
    return { data: {}, body: split.body };
  }

  let parsed;
  try {
    parsed = yaml.load(split.source);
  } catch (cause) {
    const line = cause?.mark?.line == null ? null : cause.mark.line + 2;
    const column = cause?.mark?.column == null ? null : cause.mark.column + 1;
    throw new FrontmatterParseError(
      'frontmatter_invalid_yaml',
      `Invalid YAML frontmatter${path ? ` in ${path}` : ''}: ${cause.message}`,
      { path, line, column, cause },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontmatterParseError(
      'frontmatter_not_object',
      `Frontmatter${path ? ` in ${path}` : ''} must parse to an object`,
      { path, line: 2, column: 1 },
    );
  }
  return { data: parsed, body: split.body };
};

// Returns { data, body }. `data` is the parsed YAML object (empty when there is
// no frontmatter or it parses to a non-object); `body` is the markdown after
// the fence (or the whole file when there is no fence).
const parseFrontmatter = (text) => {
  const split = splitFrontmatter(text);
  if (!split.hasFrontmatter) return { data: {}, body: split.body };
  try {
    const parsed = yaml.load(split.source);
    return {
      data: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {},
      body: split.body,
    };
  } catch {
    // A malformed frontmatter block is treated as no frontmatter rather than
    // failing the whole seed — the body is still recoverable.
    return { data: {}, body: split.text };
  }
};

export { FrontmatterParseError, parseFrontmatter, parseFrontmatterStrict, splitFrontmatter };
export default {
  FrontmatterParseError,
  parseFrontmatter,
  parseFrontmatterStrict,
  splitFrontmatter,
};
