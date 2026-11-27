// Context compiler: turns the fine-grained graph projection into a bounded,
// deterministic prompt pack so agents orient from graph slices instead of full
// markdown documents.
//
// v2 pack contents, in PRIORITY order (the byte budget truncates from the
// bottom, so the most load-bearing context survives truncation):
//   1. Input artifacts — compact line per artifact incl. its enrichment
//      summary_gist when present (this is where derive-time enrichment spend
//      pays off: the gist rides every fresh prompt).
//   2. Decisions — cross-cutting constraints every stage should respect.
//   3. Unit lane pack (lane runs only) — the stories mapped to THIS unit, the
//      requirements those stories cover, and the contracts it provides/
//      consumes, joined from the typed items.
//   4. Derived items of the input artifacts — compact index of the items the
//      stage's input artifacts produced, each with a one-line traceability
//      suffix (covers/persona/depends-on refs).
//   5. Section TOCs of the input artifacts — headings only, for navigation.
// All reads are compact; nothing here loads full markdown bodies. Items come
// from one read of the intent; when that read is at the op maximum, each
// section is read on its own (per label or input artifact type), so a section
// never depends on which other items the graph holds. Sections are
// capped with a "… N more (get_items)" line, and the result carries a status
// ('ok' | 'truncated' | 'unavailable') and the number of decision and
// unit-pack items left out, so an incomplete pack is never silent.

// Tolerant JSON-array prop reader — shared with the graph stacks (item props
// store lists as JSON strings).
import { jsonListProp as listProp } from '../shared/graph-rows.js';

const DEFAULT_BUDGET_BYTES = 24_000;
const TOC_HEADINGS_PER_ARTIFACT = 10;
// The getItems op maximum. A read that returns this many rows may be cut.
const ITEMS_READ_LIMIT = 500;
const UNIT_PACK_LABELS = ['StoryMapEntry', 'Story', 'Requirement', 'Contract'];
// Per-section line cap; the rest is counted in a "… N more (get_items)" line.
const SECTION_ITEM_LIMIT = 50;
const TRUNCATED_MARKER = '- … context truncated (get_items)';

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

// Renders at most SECTION_ITEM_LIMIT entries and counts the rest in a visible
// marker, so a capped section never reads as complete. `weights` holds how
// many items each line carries, so a byte-budget cut can count what it drops.
const capLines = (entries, render) => {
  const lines = entries.slice(0, SECTION_ITEM_LIMIT).map(render);
  const weights = lines.map(() => 1);
  const omitted = entries.length - lines.length;
  if (omitted > 0) {
    lines.push(`- … ${omitted} more (get_items)`);
    weights.push(0);
  }
  return { lines, weights, omitted };
};

const byId = (a, b) => String(a.id).localeCompare(String(b.id));

const artifactLine = (a) => {
  const base = `- ${a.artifact_type ?? 'artifact'} (${a.id})${a.title ? ` — ${a.title}` : ''}; ${a.contentLength ?? 0} bytes`;
  const gist = typeof a.summary_gist === 'string' && a.summary_gist.trim();
  return gist ? `${base}\n  gist: ${gist}` : base;
};

// One-line traceability suffix for the derived-item index and the unit-pack
// stories — surfaces the
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
// Story slugs). Returns { lines, weights, omitted }, or null when nothing is
// relevant.
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
  const weights = [0];
  let omitted = 0;
  const push = (line, weight = 0) => {
    lines.push(line);
    weights.push(weight);
  };
  const pushCapped = (entries, render) => {
    const capped = capLines(entries, render);
    lines.push(...capped.lines);
    weights.push(...capped.weights);
    omitted += capped.omitted;
  };
  if (storyIds.size) {
    push(`Stories mapped to this unit (${storyIds.size}):`);
    if (stories.length) {
      pushCapped(
        stories,
        (s) =>
          `- ${s.slug}${s.title ? ` — ${s.title}` : ''}${s.priority ? ` [${s.priority}]` : ''}${traceSuffix(s)}`,
      );
    } else {
      const ids = [...storyIds].toSorted();
      const shown = ids.slice(0, SECTION_ITEM_LIMIT);
      const more = ids.length - shown.length;
      push(
        `- ids: ${shown.join(', ')}${more > 0 ? ` … ${more} more` : ''} (story items not derived yet)`,
        shown.length,
      );
      omitted += more;
    }
  }
  // Requirements this unit actually satisfies — one COVERS hop from the
  // lane's stories, so the lane agent works against ITS requirement slice
  // instead of re-reading the whole requirements artifact.
  const requirementBySlug = new Map(byLabel('Requirement').map((r) => [r.slug, r]));
  const covered = [...new Set(stories.flatMap((s) => listProp(s.covers)))].toSorted();
  if (covered.length) {
    push('Requirements satisfied by this unit (via story COVERS):');
    pushCapped(covered, (slug) => {
      const r = requirementBySlug.get(slug);
      return `- ${slug}${r?.title ? ` — ${r.title}` : ''}${r?.priority ? ` [${r.priority}]` : ''}`;
    });
  }
  if (contracts.length) {
    push('Contracts this unit provides/consumes:');
    pushCapped(contracts, (c) => {
      const role = (c.provider ?? '') === unitSlug ? 'provides' : 'consumes';
      return `- ${c.slug}${c.title ? ` — ${c.title}` : ''} (${role}; provider: ${c.provider ?? '?'}, consumers: ${listProp(c.consumers).join(', ') || 'none'})`;
    });
  }
  return { lines, weights, omitted };
};

export const compileContextPack = async ({
  graph,
  stage = {},
  unit = null,
  budgetBytes = DEFAULT_BUDGET_BYTES,
} = {}) => {
  if (!graph) {
    return {
      markdown: '',
      bytes: 0,
      truncated: false,
      artifacts: 0,
      items: 0,
      status: 'ok',
      omitted: 0,
    };
  }
  // A failed read of the artifacts or items leaves the stage without context
  // it is promised; a failed TOC read only loses navigation.
  let unavailable = false;
  let incomplete = false;

  const needed = new Set((stage.inputArtifacts ?? []).map((i) => i.artifact).filter(Boolean));
  const artifacts = [];
  const failedArtifactTypes = [];
  for (const artifactType of needed) {
    const rows = await graph.lookupArtifacts({ artifactType }).catch(() => {
      failedArtifactTypes.push(artifactType);
      return [];
    });
    artifacts.push(...rows);
  }
  if (failedArtifactTypes.length) unavailable = true;
  const sortedArtifacts = artifacts.toSorted((a, b) =>
    String(a.artifact_type).localeCompare(String(b.artifact_type)),
  );

  // Items: one read of the whole intent (two traversals, the common case). A
  // read below the op maximum is complete and every section is built from it.
  // A read AT the maximum may have been cut in traversal order, so only then
  // each section is read on its own, filtered in the traversal, and flagged
  // only if that read also hits the maximum. Rows are sorted after every read,
  // so traversal order never picks the survivors.
  const failedReads = [];
  const cutReads = [];
  const fetchItems = async (filter, what) => {
    if (!graph.getItems) return [];
    try {
      return (await graph.getItems({ ...filter, limit: ITEMS_READ_LIMIT })) ?? [];
    } catch {
      failedReads.push(what);
      return null;
    }
  };
  let decisionItems = [];
  let unitItems = [];
  let inputItems = [];
  const all = await fetchItems({}, 'derived items');
  if (all && all.length < ITEMS_READ_LIMIT) {
    const sorted = all.toSorted(byId);
    decisionItems = sorted.filter((i) => i.label === 'Decision');
    if (unit?.slug) unitItems = sorted.filter((i) => UNIT_PACK_LABELS.includes(i.label));
    inputItems = [...needed].toSorted().map((artifactType) => ({
      artifactType,
      rows: sorted.filter((i) => i.artifact_type === artifactType),
    }));
  } else if (all) {
    const readSection = async (filter, what) => {
      const rows = await fetchItems(filter, what);
      if (!rows) return [];
      if (rows.length >= ITEMS_READ_LIMIT) cutReads.push(what);
      return rows.toSorted(byId);
    };
    decisionItems = await readSection({ itemType: 'Decision' }, 'Decision items');
    if (unit?.slug) {
      for (const itemType of UNIT_PACK_LABELS) {
        unitItems.push(...(await readSection({ itemType }, `${itemType} items`)));
      }
    }
    for (const artifactType of [...needed].toSorted()) {
      const rows = await readSection({ artifactType }, `items of the ${artifactType} artifacts`);
      inputItems.push({ artifactType, rows });
    }
  }
  inputItems = inputItems.filter(({ rows }) => rows.length);
  if (failedReads.length) unavailable = true;
  if (cutReads.length) incomplete = true;

  const lines = ['## Compiled graph context', ''];
  const weights = [0, 0];
  const push = (...added) => {
    lines.push(...added);
    weights.push(...added.map(() => 0));
  };

  // 1. Input artifacts (+ gists).
  if (failedArtifactTypes.length) {
    push(`- Could not read the ${failedArtifactTypes.join(', ')} input artifacts.`);
  }
  if (sortedArtifacts.length === 0) {
    push('- No in-scope graph artifacts were found for this stage input contract.');
  } else {
    push('### Input artifacts');
    for (const a of sortedArtifacts) push(artifactLine(a));
  }

  if (failedReads.length) {
    push('', `- Could not read ${failedReads.join(', ')}; use \`get_items\` for them.`);
  }
  if (cutReads.length) {
    push(
      '',
      `- ${cutReads.join(', ')} reached the read limit of ${ITEMS_READ_LIMIT}; the sections below may be incomplete (get_items).`,
    );
  }

  // 2. Decisions — cross-cutting constraints, ahead of the unit pack so the
  // byte budget never drops them first.
  const decisions = capLines(
    decisionItems,
    (d) => `- ${d.slug}${d.title ? ` — ${d.title}` : ''}${d.status ? ` [${d.status}]` : ''}`,
  );
  if (decisions.lines.length) {
    push('', '### Decisions (constraints on all work)');
    lines.push(...decisions.lines);
    weights.push(...decisions.weights);
  }

  // 3. Unit lane pack.
  const unitPack = buildUnitPack({ unitSlug: unit?.slug ?? null, items: unitItems });
  if (unitPack) {
    push('');
    lines.push(...unitPack.lines);
    weights.push(...unitPack.weights);
  }

  // 4. Derived items of the input artifacts (with one-line traceability refs).
  // A navigation index: its cap is signposted but does not mark the pack
  // incomplete.
  for (const { artifactType, rows } of inputItems) {
    const index = capLines(
      rows,
      (i) =>
        `- ${i.label ?? i.type ?? 'Item'} ${i.slug ?? i.id}${i.title ? ` — ${i.title}` : ''}${traceSuffix(i)}`,
    );
    push('', `### Derived items — ${artifactType}`, ...index.lines);
  }

  // The drill-down hint BEFORE the (droppable) TOCs so truncation never
  // removes the pointer to the tools.
  push(
    '',
    'Use MCP drill-down tools (`get_artifact_toc`, `get_section`, `get_items`) for details.',
  );

  // 5. Input-artifact TOCs — pure navigation, first to go under budget.
  for (const a of sortedArtifacts) {
    const toc =
      (await graph.getArtifactToc?.({ id: a.id }).catch(() => {
        incomplete = true;
        return [];
      })) ?? [];
    if (!toc.length) continue;
    push('', `### Sections — ${a.artifact_type} (${a.id})`);
    for (const s of toc.slice(0, TOC_HEADINGS_PER_ARTIFACT)) {
      push(`- ${s.slug}${s.heading ? ` — ${s.heading}` : ''}`);
    }
    if (toc.length > TOC_HEADINGS_PER_ARTIFACT) {
      push(`- … ${toc.length - TOC_HEADINGS_PER_ARTIFACT} more (get_artifact_toc)`);
    }
  }

  // A budget cut keeps room for a marker so the agent knows the pack is cut.
  let kept = fitLines(lines, budgetBytes);
  let fitted = kept;
  const markerBytes = textBytes(`${TRUNCATED_MARKER}\n`);
  if (kept.truncated && markerBytes <= budgetBytes) {
    kept = fitLines(lines, budgetBytes - markerBytes);
    fitted = { ...kept, lines: [...kept.lines, TRUNCATED_MARKER], bytes: kept.bytes + markerBytes };
  }
  // Decision and unit-pack items the stage is told to respect in full that
  // the pack could not carry: past a section cap, or cut by the byte budget
  // (fitLines keeps a prefix, so the dropped lines are the tail).
  const droppedByBudget = weights.slice(kept.lines.length).reduce((sum, w) => sum + w, 0);
  const omitted = (unitPack?.omitted ?? 0) + decisions.omitted + droppedByBudget;
  if (fitted.truncated || omitted > 0) incomplete = true;
  let status = 'ok';
  if (unavailable) status = 'unavailable';
  else if (incomplete) status = 'truncated';
  return {
    markdown: fitted.lines.join('\n'),
    bytes: fitted.bytes,
    truncated: fitted.truncated,
    artifacts: artifacts.length,
    items:
      decisionItems.length +
      unitItems.length +
      inputItems.reduce((sum, { rows }) => sum + rows.length, 0),
    status,
    omitted,
  };
};

export const __test = {
  fitLines,
  artifactLine,
  listProp,
  traceSuffix,
  DEFAULT_BUDGET_BYTES,
  ITEMS_READ_LIMIT,
  SECTION_ITEM_LIMIT,
};
