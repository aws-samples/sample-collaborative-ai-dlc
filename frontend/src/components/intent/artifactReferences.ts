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
//
// Documents are read with the same parser and GFM extension the preview renders
// with, so the index and the preview's anchors agree on where every block starts
// and ends.

import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

// One to eight capitals, an optional hyphen, then a number with optional dotted
// parts and one trailing letter: U26, U8b, US6.11, AC1.1.2, CR-10, OQ-01.
const ID_SOURCE = '[A-Z]{1,8}-?\\d+(?:\\.\\d+)*[a-z]?';
const ID_RE = new RegExp(`^${ID_SOURCE}$`);
const LEADING_ID_RE = new RegExp(`^(${ID_SOURCE})(?=$|[\\s:,;(\\u2013\\u2014-])`);
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

/** The part of an mdast node the definition walk and the preview's transforms use. */
export type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  url?: string;
  title?: string;
  data?: { hProperties?: Record<string, unknown>; referenceDefinition?: boolean };
};

/** A node's text, including inline code, without markup. */
export function nodeText(node: MdastNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  return (node.children ?? []).map(nodeText).join('');
}

/**
 * Where a document defines an identifier. `target` is the heading, table row or
 * list item that gets the anchor; `cell` is the table cell holding the id, and
 * `label` the heading or bold list label it leads.
 */
export interface DefinitionSite {
  id: string;
  kind: ReferenceDefinitionKind;
  explicit: boolean;
  target: MdastNode;
  cell: MdastNode | null;
  label: MdastNode;
}

// Every heading, table row and bold-led list item that defines an id, in document
// order. Code blocks are leaves in the tree, so nothing inside them counts.
function collectSites(tree: MdastNode): DefinitionSite[] {
  const sites: DefinitionSite[] = [];
  const visit = (node: MdastNode) => {
    if (node.type === 'heading') {
      const id = leadingReferenceId(nodeText(node));
      if (id)
        sites.push({ id, kind: 'heading', explicit: false, target: node, cell: null, label: node });
      return;
    }
    if (node.type === 'table') {
      const [header, ...rows] = node.children ?? [];
      const { column, explicit } = referenceIdColumn((header?.children ?? []).map(nodeText));
      for (const row of rows) {
        const cell = row.children?.[column];
        const id = cell ? cellReferenceId(nodeText(cell)) : null;
        if (cell && id) sites.push({ id, kind: 'table', explicit, target: row, cell, label: cell });
      }
      return;
    }
    if (node.type === 'listItem') {
      const label = node.children?.[0]?.children?.[0];
      const id = label?.type === 'strong' ? leadingReferenceId(nodeText(label)) : null;
      if (label && id)
        sites.push({ id, kind: 'list', explicit: false, target: node, cell: null, label });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return sites;
}

/**
 * The definitions in a parsed document: the first site of each id, dropping plain
 * tokens (S3, Q3) that nothing backs up as an id: a column headed as an identifier,
 * a hyphen or dotted parts, or a sibling with the same prefix (U1 alongside U26).
 */
export function definitionSites(tree: MdastNode): DefinitionSite[] {
  const first = new Map<string, DefinitionSite>();
  for (const site of collectSites(tree)) if (!first.has(site.id)) first.set(site.id, site);
  const prefixCounts = new Map<string, number>();
  for (const id of first.keys()) {
    prefixCounts.set(idPrefix(id), (prefixCounts.get(idPrefix(id)) ?? 0) + 1);
  }
  return [...first.values()].filter(
    (site) =>
      site.explicit || hasDistinctForm(site.id) || (prefixCounts.get(idPrefix(site.id)) ?? 0) > 1,
  );
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);

/** Every identifier one document defines, in document order, first definition only. */
export function definitionsInArtifact(
  artifact: DefinableArtifact,
): Array<Pick<ReferenceDefinition, 'id' | 'kind'>> {
  const tree = markdownParser.parse(String(artifact.content ?? '')) as MdastNode;
  return definitionSites(tree).map(({ id, kind }) => ({ id, kind }));
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
