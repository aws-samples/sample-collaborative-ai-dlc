// Conservative adapter around known limitations in the pinned lexical reader.
// No contributor code is evaluated. Ambiguity loses precision, never review cues.
export function lexicalAmbiguity(lines = []) {
  for (const line of lines) {
    const comment = line.indexOf('//');
    if (comment >= 0 && line.slice(comment + 2).includes('/*')) return 'line-comment-block-token';
    for (const match of line.matchAll(/(["'])(?:\\.|(?!\1).)*?\1/g)) {
      if (/(?<!\\)`/.test(match[0])) return 'quoted-backtick-token';
      if (match[0].includes('/*') || match[0].includes('*/')) return 'quoted-block-comment-token';
    }
    for (const match of line.matchAll(/\/(?:\\.|[^/\r\n])+\/[dgimsuvy]*/g)) {
      if (/(?<!\\)`/.test(match[0])) return 'regex-backtick-token';
    }
  }
  return null;
}

export function guardRead(read, before, after) {
  const fallbacks = new Map();
  for (const [path, shape] of read.shapes) {
    if (shape.kind === 'file' || !/\.[cm]?[jt]sx?$/.test(path)) continue;
    let reason = lexicalAmbiguity(before.get(path)) ?? lexicalAmbiguity(after.get(path));
    // A quiet classification must be consistent with actual added lines.
    // Inline comments / multiline blocks can conservatively become file-wide.
    if (
      !reason &&
      shape.kind === 'comments' &&
      (read.added.get(path) ?? []).some((line) => !/^\s*(?:$|\/\/|\/\*|\*)/.test(line))
    ) {
      reason = 'quiet-code-contradiction';
    }
    if (!reason) continue;
    fallbacks.set(path, `lexical-ambiguity:${reason}`);
    read.shapes.set(path, { ...shape, kind: 'file', touches: [], words: [], members: [] });
  }
  read.users = read.users.filter((row) => !fallbacks.has(row.of));
  read.fallbacks = fallbacks;
  return read;
}
