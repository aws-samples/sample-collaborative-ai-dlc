// Context compiler: turns the fine-grained graph projection into a bounded,
// deterministic prompt pack so agents orient from graph slices instead of full
// markdown documents.
//
// v2 pack contents, in PRIORITY order (the byte budget truncates from the
// bottom, so the most load-bearing context survives truncation):
//   1. Input artifacts — compact line per artifact incl. its enrichment
//      summary_gist when present (this is where derive-time enrichment spend
//      pays off: the gist rides every fresh prompt).
//   2. Unit lane pack (lane runs only) — the stories mapped to THIS unit, the
//      requirements those stories cover, and the contracts it provides/
//      consumes, joined from the typed items.
//   3. Decisions — cross-cutting constraints every stage should respect.
//   4. Derived items — compact index of the intent's typed items, each with a
//      one-line traceability suffix (covers/persona/depends-on refs).
//   5. Section TOCs of the input artifacts — headings only, for navigation.
// All reads are compact; nothing here loads full markdown bodies.

// Tolerant JSON-array prop reader — shared with the graph stacks (item props
// store lists as JSON strings).
import { jsonListProp as listProp } from '../shared/graph-rows.js';

const DEFAULT_BUDGET_BYTES = 24_000;
const TOC_HEADINGS_PER_ARTIFACT = 10;
const ITEMS_LIMIT = 50;

const textBytes = (value = '') => Buffer.byteLength(String(value ?? ''), 'utf8');

const fitLines = (lines, budgetBytes) => {
  const out = [];
  let used = 0;
  for (const line of lines) {
    const next = textBytes(`${line}\n`);
    if (used + next > budgetBytes) break;
    out.push(line);
    used += next;
  }
  return { lines: out, bytes: used, truncated: out.length < lines.length };
};

const artifactLine = (a) => {
  const base = `- ${a.artifact_type ?? 'artifact'} (${a.id})${a.title ? ` — ${a.title}` : ''}; ${a.contentLength ?? 0} bytes`;
  const gist = typeof a.summary_gist === 'string' && a.summary_gist.trim();
  return gist ? `${base}\n  gist: ${gist}` : base;
};

// One-line traceability suffix for the derived-item index — surfaces the
// item↔item references (the props behind the COVERS/FOR_PERSONA/DEPENDS_ON
// edges the derive sweep materializes) so a stage consuming stories or
// requirements sees the coverage map without loading any artifact body.
const traceSuffix = (i) => {
  const parts = [];
  const label = i.label ?? '';
  if (label === 'Story') {
    const covers = listProp(i.covers);
    if (covers.length) parts.push(`covers: ${covers.join(', ')}`);
    if (i.persona) parts.push(`persona: ${i.persona}`);
  }
  if (label === 'Story' || label === 'Component') {
    const deps = listProp(i.depends_on);
    if (deps.length) parts.push(`depends on: ${deps.join(', ')}`);
  }
  return parts.length ? ` → ${parts.join('; ')}` : '';
};

// The lane contract pack: what of the intent's typed items belongs to THIS
// unit — its mapped stories and the contracts it touches. Pure join over the
// compact item rows (StoryMapEntry.unit/stories, Contract.provider/consumers,
// Story slugs). Empty sections are omitted by the caller.
export const buildUnitPack = ({ unitSlug, items = [] }) => {
  if (!unitSlug) return null;
  const byLabel = (label) => items.filter((i) => (i.label ?? '') === label);
  const storyIds = new Set(
    byLabel('StoryMapEntry')
      .filter((m) => (m.unit ?? '') === unitSlug)
      .flatMap((m) => listProp(m.stories)),
  );
  const stories = byLabel('Story').filter((s) => storyIds.has(s.slug));
  const contracts = byLabel('Contract').filter(
    (c) => (c.provider ?? '') === unitSlug || listProp(c.consumers).includes(unitSlug),
  );
  if (!stories.length && !contracts.length && storyIds.size === 0) return null;
  const lines = [`### Unit pack — ${unitSlug}`];
  if (storyIds.size) {
    lines.push(`Stories mapped to this unit (${storyIds.size}):`);
    if (stories.length) {
      for (const s of stories) {
        lines.push(
          `- ${s.slug}${s.title ? ` — ${s.title}` : ''}${s.priority ? ` [${s.priority}]` : ''}`,
        );
      }
    } else {
      lines.push(`- ids: ${[...storyIds].join(', ')} (story items not derived yet)`);
    }
  }
  // Requirements this unit actually satisfies — one COVERS hop from the
  // lane's stories, so the lane agent works against ITS requirement slice
  // instead of re-reading the whole requirements artifact.
  const requirementBySlug = new Map(byLabel('Requirement').map((r) => [r.slug, r]));
  const covered = [...new Set(stories.flatMap((s) => listProp(s.covers)))].toSorted();
  if (covered.length) {
    lines.push('Requirements satisfied by this unit (via story COVERS):');
    for (const slug of covered) {
      const r = requirementBySlug.get(slug);
      lines.push(
        `- ${slug}${r?.title ? ` — ${r.title}` : ''}${r?.priority ? ` [${r.priority}]` : ''}`,
      );
    }
  }
  if (contracts.length) {
    lines.push('Contracts this unit provides/consumes:');
    for (const c of contracts) {
      const role = (c.provider ?? '') === unitSlug ? 'provides' : 'consumes';
      lines.push(
        `- ${c.slug}${c.title ? ` — ${c.title}` : ''} (${role}; provider: ${c.provider ?? '?'}, consumers: ${listProp(c.consumers).join(', ') || 'none'})`,
      );
    }
  }
  return lines;
};

export const compileContextPack = async ({
  graph,
  stage = {},
  unit = null,
  budgetBytes = DEFAULT_BUDGET_BYTES,
} = {}) => {
  if (!graph) return { markdown: '', bytes: 0, truncated: false, artifacts: 0, items: 0 };
  const needed = new Set((stage.inputArtifacts ?? []).map((i) => i.artifact).filter(Boolean));
  const artifacts = [];
  for (const artifactType of needed) {
    const rows = await graph.lookupArtifacts({ artifactType }).catch(() => []);
    artifacts.push(...rows);
  }
  const sortedArtifacts = artifacts.toSorted((a, b) =>
    String(a.artifact_type).localeCompare(String(b.artifact_type)),
  );

  const typedItems = (await graph.getItems?.({ limit: ITEMS_LIMIT }).catch(() => [])) ?? [];
  const sortedItems = typedItems.toSorted((a, b) => String(a.id).localeCompare(String(b.id)));

  const lines = ['## Compiled graph context', ''];

  // 1. Input artifacts (+ gists).
  if (sortedArtifacts.length === 0) {
    lines.push('- No in-scope graph artifacts were found for this stage input contract.');
  } else {
    lines.push('### Input artifacts');
    for (const a of sortedArtifacts) lines.push(artifactLine(a));
  }

  // 2. Unit lane pack.
  const unitPack = buildUnitPack({ unitSlug: unit?.slug ?? null, items: sortedItems });
  if (unitPack) lines.push('', ...unitPack);

  // 3. Decisions — cross-cutting constraints.
  const decisions = sortedItems.filter((i) => (i.label ?? '') === 'Decision');
  if (decisions.length) {
    lines.push('', '### Decisions (constraints on all work)');
    for (const d of decisions) {
      lines.push(`- ${d.slug}${d.title ? ` — ${d.title}` : ''}${d.status ? ` [${d.status}]` : ''}`);
    }
  }

  // 4. Derived-item index (with one-line traceability refs).
  if (sortedItems.length) {
    lines.push('', '### Derived items');
    for (const i of sortedItems) {
      lines.push(
        `- ${i.label ?? i.type ?? 'Item'} ${i.slug ?? i.id}${i.title ? ` — ${i.title}` : ''}${traceSuffix(i)}`,
      );
    }
  }

  // The drill-down hint BEFORE the (droppable) TOCs so truncation never
  // removes the pointer to the tools.
  lines.push(
    '',
    'Use MCP drill-down tools (`get_artifact_toc`, `get_section`, `get_items`) for details.',
  );

  // 5. Input-artifact TOCs — pure navigation, first to go under budget.
  for (const a of sortedArtifacts) {
    const toc = (await graph.getArtifactToc?.({ id: a.id }).catch(() => [])) ?? [];
    if (!toc.length) continue;
    lines.push('', `### Sections — ${a.artifact_type} (${a.id})`);
    for (const s of toc.slice(0, TOC_HEADINGS_PER_ARTIFACT)) {
      lines.push(`- ${s.slug}${s.heading ? ` — ${s.heading}` : ''}`);
    }
    if (toc.length > TOC_HEADINGS_PER_ARTIFACT) {
      lines.push(`- … ${toc.length - TOC_HEADINGS_PER_ARTIFACT} more (get_artifact_toc)`);
    }
  }

  const fitted = fitLines(lines, budgetBytes);
  return {
    markdown: fitted.lines.join('\n'),
    bytes: fitted.bytes,
    truncated: fitted.truncated,
    artifacts: artifacts.length,
    items: typedItems.length,
  };
};

export const __test = { fitLines, artifactLine, listProp, traceSuffix, DEFAULT_BUDGET_BYTES };
