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

// Returns { data, body }. `data` is the parsed YAML object (empty when there is
// no frontmatter or it parses to a non-object); `body` is the markdown after
// the fence (or the whole file when there is no fence).
const parseFrontmatter = (text) => {
  const src = typeof text === 'string' ? text : '';
  const match = src.match(FRONTMATTER_RE);
  if (!match) {
    return { data: {}, body: src };
  }
  let data = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed;
    }
  } catch {
    // A malformed frontmatter block is treated as no frontmatter rather than
    // failing the whole seed — the body is still recoverable.
    return { data: {}, body: src };
  }
  return { data, body: match[2] ?? '' };
};

export { parseFrontmatter };
export default { parseFrontmatter };
