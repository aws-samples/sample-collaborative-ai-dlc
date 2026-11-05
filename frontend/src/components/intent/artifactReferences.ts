// Identifiers a document defines (a unit's `U26`, a story's `US6.11`, a change
// request's `CR-10`, an open question's `OQ-01`), and where. Artifacts don't
// record them as derived items, so references to them elsewhere can only be
// linked by reading the documents. An identifier is defined where it leads a
// heading, fills a table row's identifier cell, or opens a bold-led list item.
//
// Plain letter-and-number tokens are also ordinary technical words (S3, EC2, Q3,
// H2), so one of those counts only in a column headed as an identifier, or when
// the same document defines another with the same prefix (U1 … U26). Ids with a
// hyphen or dotted parts (CR-10, OQ-01, US6.11) count on their own.

// One to eight capitals, an optional hyphen, then a number with optional dotted
// parts and one trailing letter: U26, U8b, US6.11, AC1.1.2, CR-10, OQ-01.
const ID_SOURCE = '[A-Z]{1,8}-?\\d+(?:\\.\\d+)*[a-z]?';
const ID_RE = new RegExp(`^${ID_SOURCE}$`);
const LEADING_ID_RE = new RegExp(`^(${ID_SOURCE})(?=$|[\\s:,;(\\u2013\\u2014-])`);
const HEADING_RE = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_BOLD_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*|__)(.+?)(?:\*\*|__)/;
const FENCE_RE = /^\s*(```|~~~)/;
// A header naming the identifier column: ID, Ref, Key, Code, #, No., or "<thing> ID".
const ID_HEADER_RE = /^(?:id|ref|reference|key|code|#|no\.?|.+\sid)$/i;

/** Where a definition sits, strongest first: a heading, then a table, then a list. */
export type ReferenceDefinitionKind = 'heading' | 'table' | 'list';
const STRENGTH: Record<ReferenceDefinitionKind, number> = { heading: 3, table: 2, list: 1 };

export interface ReferenceDefinition {
  id: string;
  artifactId: string;
  artifactTitle: string;
  anchor: string;
  kind: ReferenceDefinitionKind;
}

export interface DefinableArtifact {
  id: string;
  title: string | null;
  content?: string | null;
  createdAt?: string | null;
}

/** Markdown emphasis, code ticks and link syntax removed from a cell or heading. */
export function plainReferenceText(value: string): string {
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

/** The identifier a table cell holds, when it holds only that. */
export function cellReferenceId(value: string): string | null {
  const text = plainReferenceText(value);
  return ID_RE.test(text) ? text : null;
}

/** The identifier a heading or list label starts with. */
export function leadingReferenceId(value: string): string | null {
  return LEADING_ID_RE.exec(plainReferenceText(value))?.[1] ?? null;
}

/**
 * The column of a table that holds identifiers: one headed as such (`explicit`),
 * else the first.
 */
export function referenceIdColumn(headerCells: string[]): { column: number; explicit: boolean } {
  const index = headerCells.findIndex((cell) => ID_HEADER_RE.test(plainReferenceText(cell)));
  return index === -1 ? { column: 0, explicit: false } : { column: index, explicit: true };
}

const idPrefix = (id: string) => /^[A-Z]+/.exec(id)?.[0] ?? id;
const hasDistinctForm = (id: string) => /[-.]/.test(id);

const anchorPart = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** The element id a definition renders with in its artifact's preview. */
export function referenceAnchor(artifactId: string, id: string): string {
  return `ref-${anchorPart(artifactId)}--${anchorPart(id)}`;
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

const hasCellSeparator = (line: string) => /(?<!\\)\|/.test(line);

// A GFM table starts where a header row is followed by a delimiter row with the same
// number of cells. Outer pipes are optional, but a row needs at least one pipe.
function startsTable(lines: string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1] ?? '';
  return (
    hasCellSeparator(header) &&
    hasCellSeparator(delimiter) &&
    TABLE_SEPARATOR_RE.test(delimiter) &&
    splitTableRow(header).length === splitTableRow(delimiter).length
  );
}

// A table's body runs to the first blank line or the next heading or fence.
const endsTableBody = (line: string) =>
  line.trim() === '' || HEADING_RE.test(line) || FENCE_RE.test(line);

// The identifiers in a table's identifier column, and the index of the line after it.
function tableDefinitions(
  lines: string[],
  headerIndex: number,
): { ids: string[]; explicit: boolean; next: number } {
  const { column, explicit } = referenceIdColumn(splitTableRow(lines[headerIndex]));
  const ids: string[] = [];
  let i = headerIndex + 2;
  for (; i < lines.length && !endsTableBody(lines[i]); i += 1) {
    const id = cellReferenceId(splitTableRow(lines[i])[column] ?? '');
    if (id) ids.push(id);
  }
  return { ids, explicit, next: i };
}

// Drops plain tokens (S3, Q3) that nothing in the document backs up as an id: a
// column headed as an identifier, a hyphen or dotted parts, or a sibling with the
// same prefix (U1 alongside U26).
function corroborated(
  found: Map<string, { kind: ReferenceDefinitionKind; explicit: boolean }>,
): Array<Pick<ReferenceDefinition, 'id' | 'kind'>> {
  const prefixCounts = new Map<string, number>();
  for (const id of found.keys()) {
    prefixCounts.set(idPrefix(id), (prefixCounts.get(idPrefix(id)) ?? 0) + 1);
  }
  return [...found]
    .filter(
      ([id, { explicit }]) =>
        explicit || hasDistinctForm(id) || (prefixCounts.get(idPrefix(id)) ?? 0) > 1,
    )
    .map(([id, { kind }]) => ({ id, kind }));
}

/** Every identifier one document defines, in document order, first definition only. */
export function definitionsInArtifact(
  artifact: DefinableArtifact,
): Array<Pick<ReferenceDefinition, 'id' | 'kind'>> {
  const lines = String(artifact.content ?? '').split(/\r?\n/);
  const found = new Map<string, { kind: ReferenceDefinitionKind; explicit: boolean }>();
  const define = (id: string | null, kind: ReferenceDefinitionKind, explicit = false) => {
    if (id && !found.has(id)) found.set(id, { kind, explicit });
  };
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      define(leadingReferenceId(heading[1]), 'heading');
      continue;
    }
    if (startsTable(lines, i)) {
      const table = tableDefinitions(lines, i);
      for (const id of table.ids) define(id, 'table', table.explicit);
      i = table.next - 1;
      continue;
    }
    const listLabel = LIST_BOLD_RE.exec(line);
    if (listLabel) define(leadingReferenceId(listLabel[1]), 'list');
  }
  return corroborated(found);
}

const indexCache = new WeakMap<readonly DefinableArtifact[], Map<string, ReferenceDefinition>>();

/**
 * Where each identifier across the intent's documents is defined. A heading beats a
 * table row, which beats a list item; between equals, the earlier document wins,
 * since later documents (story maps, traceability) mostly repeat earlier ids.
 */
export function buildReferenceDefinitions(
  artifacts: readonly DefinableArtifact[],
): Map<string, ReferenceDefinition> {
  const cached = indexCache.get(artifacts);
  if (cached) return cached;
  const ordered = [...artifacts].toSorted((a, b) =>
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
  );
  const index = new Map<string, ReferenceDefinition>();
  for (const artifact of ordered) {
    for (const { id, kind } of definitionsInArtifact(artifact)) {
      const current = index.get(id);
      if (current && STRENGTH[current.kind] >= STRENGTH[kind]) continue;
      index.set(id, {
        id,
        kind,
        artifactId: artifact.id,
        artifactTitle: artifact.title || artifact.id,
        anchor: referenceAnchor(artifact.id, id),
      });
    }
  }
  indexCache.set(artifacts, index);
  return index;
}
