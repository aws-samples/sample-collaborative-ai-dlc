// Compose pre-pass + proposal contract — the PURE half of the composer.
//
// The composer is an LLM ("composer proposes"), but everything around it is
// deterministic ("engine disposes"): this module owns the keyword pre-pass
// that can answer without any LLM call, the grounding pack that anchors the
// LLM in the compiled plan's REAL numbers instead of prose, and the strict
// proposal parser that turns model output into data — or a structured
// failure, never a guess. No I/O anywhere in this file.

// Word-boundary keyword hit: 'auth' matches "fix auth flow", not "author".
const keywordHit = (text, keyword) => {
  const kw = String(keyword ?? '').trim();
  if (!kw) return false;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(String(text ?? ''));
};

// Deterministic scope inference (upstream's keyword routing): a scope block
// may declare `keywords`; when EXACTLY ONE scope's keywords hit the intent
// text the match is clean and the LLM can be bypassed. Zero hits or an
// ambiguous 2+ hit returns null — ambiguity is the composer's job, never a
// coin flip here.
const matchScopeByKeywords = ({ text, scopes = [] }) => {
  const hits = [];
  for (const scope of scopes) {
    const keywords = Array.isArray(scope?.keywords) ? scope.keywords : [];
    const matched = keywords.filter((kw) => keywordHit(text, kw));
    if (matched.length > 0) hits.push({ scopeId: scope.id ?? scope.blockId, matched });
  }
  return hits.length === 1 ? hits[0] : null;
};

// The grounding pack: authoritative per-scope run shapes (from the pure plan
// resolver — real stage/gate counts, never prose claims) plus the stage
// catalog the grid ranges over. Rendered as compact markdown for the prompt.
//   scopes:    SCOPE blocks ({ id, description, keywords, depth })
//   summaries: { [scopeId]: plan.summary } from buildExecutionPlan per scope
//   grids:     { [scopeId]: { stageId: 'EXECUTE'|'SKIP' } } scope projections
//   stages:    STAGE blocks ({ id, phase, execution, produces, consumes,
//              optionalProduces })
const buildGroundingPack = ({ scopes = [], summaries = {}, grids = {}, stages = [] }) => {
  const lines = [];
  lines.push('## Stock scopes (authoritative compiled run shapes)');
  for (const scope of scopes) {
    const id = scope.id ?? scope.blockId;
    const s = summaries[id];
    const shape = s
      ? `runs ${s.executedStages} of ${s.totalStages} stages, ${s.approvalGates} approval gates, ${s.perUnitStages} per-unit stages`
      : 'shape unavailable';
    const keywords = (scope.keywords ?? []).join(', ') || 'none';
    lines.push(`- ${id}: ${shape}. Keywords: ${keywords}.`);
    if (scope.description) lines.push(`  ${String(scope.description).slice(0, 300)}`);
    const grid = grids[id];
    if (grid) {
      const executed = Object.entries(grid)
        .filter(([, v]) => v === 'EXECUTE')
        .map(([k]) => k);
      lines.push(`  EXECUTE: ${executed.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('## Stage catalog (id | phase | execution | produces | requires)');
  for (const st of stages) {
    const id = st.id ?? st.blockId;
    const produces = [
      ...(st.produces ?? []),
      ...(st.optionalProduces ?? []).map((a) => `${a}?`),
    ].join(', ');
    const consumes = (st.consumes ?? [])
      .filter((c) => (typeof c === 'object' ? c.required !== false : true))
      .map((c) => (typeof c === 'object' ? c.artifact : c))
      .join(', ');
    lines.push(
      `- ${id} | ${st.phase ?? '?'} | ${st.execution ?? 'ALWAYS'} | ${produces || '-'} | ${consumes || '-'}`,
    );
  }
  return lines.join('\n');
};

// The output contract the composer must satisfy — rendered into the prompt
// verbatim so parseComposeProposal and the instructions can never drift.
const PROPOSAL_CONTRACT = [
  'Respond with EXACTLY ONE fenced JSON block and nothing else:',
  '```json',
  '{',
  '  "mode": "matched" | "custom",',
  '  "scope": "<stock scope id for matched; a short kebab-case label for custom>",',
  '  "grid": { "<stage-id>": "EXECUTE" | "SKIP", ... },   // custom mode only: EVERY stage in the catalog',
  '  "rationale": ["<one short reason per SKIP or notable inclusion>"],',
  '  "confidence": 0.0-1.0',
  '}',
  '```',
  'Rules: initialization stages are ALWAYS EXECUTE. Never invent stage ids.',
  'If you cannot produce a valid grid, respond with {"mode":"failed","reason":"<why>"} instead — never guess.',
].join('\n');

// Extract + validate the composer's JSON proposal. Returns { proposal } or
// { error } — the caller records a degraded compose, it never applies an
// unvalidated grid (the plan resolver re-validates the grid afterwards; this
// is only the wire-shape gate).
const parseComposeProposal = (rawText) => {
  const text = String(rawText ?? '');
  // Prefer a fenced ```json block; fall back to the first {...} span.
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  let jsonText = fenced?.[1] ?? null;
  if (!jsonText) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) jsonText = text.slice(start, end + 1);
  }
  if (!jsonText) return { error: 'no JSON object found in composer output' };
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return { error: `composer output is not valid JSON: ${e.message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'composer output must be a JSON object' };
  }
  if (parsed.mode === 'failed') {
    return { error: `composer declared failure: ${parsed.reason ?? 'no reason given'}` };
  }
  if (parsed.mode !== 'matched' && parsed.mode !== 'custom') {
    return { error: `proposal mode must be "matched" or "custom", got "${parsed.mode}"` };
  }
  if (typeof parsed.scope !== 'string' || !parsed.scope.trim()) {
    return { error: 'proposal must name a scope' };
  }
  const proposal = {
    mode: parsed.mode,
    scope: parsed.scope.trim(),
    grid: null,
    rationale: Array.isArray(parsed.rationale)
      ? parsed.rationale.filter((r) => typeof r === 'string').slice(0, 64)
      : [],
    confidence:
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : null,
  };
  if (parsed.mode === 'custom') {
    if (typeof parsed.grid !== 'object' || parsed.grid === null || Array.isArray(parsed.grid)) {
      return { error: 'a custom proposal must carry a grid object' };
    }
    const grid = {};
    for (const [stageId, value] of Object.entries(parsed.grid)) {
      const v = typeof value === 'string' ? value.toUpperCase() : value;
      if (v !== 'EXECUTE' && v !== 'SKIP') {
        return { error: `grid["${stageId}"] must be EXECUTE or SKIP` };
      }
      grid[stageId] = v;
    }
    if (Object.keys(grid).length === 0) return { error: 'a custom proposal grid is empty' };
    proposal.grid = grid;
  }
  return { proposal };
};

export {
  keywordHit,
  matchScopeByKeywords,
  buildGroundingPack,
  parseComposeProposal,
  PROPOSAL_CONTRACT,
};
export default {
  keywordHit,
  matchScopeByKeywords,
  buildGroundingPack,
  parseComposeProposal,
  PROPOSAL_CONTRACT,
};
