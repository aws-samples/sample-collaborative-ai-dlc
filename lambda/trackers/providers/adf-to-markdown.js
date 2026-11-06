// Atlassian Document Format → Markdown. Read-only one-way conversion used
// to render Jira issue/comment bodies into Sprint.description so the
// agent sees something close to the original text. Round-tripping is
// out of scope.
//
// Coverage: paragraph, heading (1-6), bulletList, orderedList, listItem,
// codeBlock (with language), inlineCode (via mark), link, mention,
// hardBreak, text with marks (strong, em, code), and media filenames supplied
// by the Jira provider (keyed by Media Services ID). Anything else emits a
// `> _Unsupported Jira block: <type>_` placeholder so the agent at
// least sees the gap.

const escapeText = (s) => (typeof s === 'string' ? s : '');

const renderText = (node) => {
  let out = escapeText(node.text);
  const marks = Array.isArray(node.marks) ? node.marks : [];
  for (const m of marks) {
    if (m.type === 'code') out = `\`${out}\``;
    else if (m.type === 'strong') out = `**${out}**`;
    else if (m.type === 'em') out = `_${out}_`;
    else if (m.type === 'link') {
      const href = m.attrs?.href || '';
      out = `[${out}](${href})`;
    }
  }
  return out;
};

const renderMedia = (node, mediaFilenames) =>
  mediaFilenames.get(node.attrs?.id) || `> _Unsupported Jira block: ${node.type}_`;

const renderInline = (children, mediaFilenames) =>
  (Array.isArray(children) ? children : [])
    .map((c) => {
      if (c.type === 'text') return renderText(c);
      if (c.type === 'hardBreak') return '  \n';
      if (c.type === 'inlineCode') return `\`${escapeText(c.text)}\``;
      if (c.type === 'mediaInline') return renderMedia(c, mediaFilenames);
      if (c.type === 'mention') {
        const handle = c.attrs?.text || c.attrs?.displayName || c.attrs?.id || '';
        return `@${handle}`;
      }
      return `> _Unsupported Jira block: ${c.type}_`;
    })
    .join('');

const renderListItem = (node, ordered, index, mediaFilenames) => {
  const marker = ordered ? `${index + 1}. ` : '- ';
  const inner = renderBlocks(node.content || [], mediaFilenames)
    .split('\n')
    .map((line, i) => (i === 0 ? line : line ? `  ${line}` : line))
    .join('\n');
  return `${marker}${inner}`;
};

const renderBlocks = (nodes, mediaFilenames) => {
  const parts = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'paragraph' || node.type === 'caption') {
      parts.push(renderInline(node.content || [], mediaFilenames));
    } else if (node.type === 'heading') {
      const level = Math.min(Math.max(Number.parseInt(node.attrs?.level, 10) || 1, 1), 6);
      parts.push(`${'#'.repeat(level)} ${renderInline(node.content || [], mediaFilenames)}`);
    } else if (node.type === 'bulletList') {
      const items = (node.content || []).map((item, i) =>
        renderListItem(item, false, i, mediaFilenames),
      );
      parts.push(items.join('\n'));
    } else if (node.type === 'orderedList') {
      const items = (node.content || []).map((item, i) =>
        renderListItem(item, true, i, mediaFilenames),
      );
      parts.push(items.join('\n'));
    } else if (node.type === 'listItem') {
      // Standalone listItem — render inline (rare, normally seen via bulletList/orderedList).
      parts.push(renderBlocks(node.content || [], mediaFilenames));
    } else if (node.type === 'mediaSingle' || node.type === 'mediaGroup') {
      parts.push(renderBlocks(node.content || [], mediaFilenames));
    } else if (node.type === 'media' || node.type === 'mediaInline') {
      parts.push(renderMedia(node, mediaFilenames));
    } else if (node.type === 'codeBlock') {
      const lang = node.attrs?.language || '';
      const body = (node.content || []).map((c) => escapeText(c.text)).join('');
      parts.push(`\`\`\`${lang}\n${body}\n\`\`\``);
    } else {
      parts.push(`> _Unsupported Jira block: ${node.type}_`);
    }
  }
  return parts.join('\n\n');
};

export const adfToMarkdown = (adf, mediaFilenames = new Map()) => {
  if (!adf || typeof adf !== 'object') return '';
  if (adf.type !== 'doc' || !Array.isArray(adf.content)) return '';
  return renderBlocks(adf.content, mediaFilenames).trim();
};
