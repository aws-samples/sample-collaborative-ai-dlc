// Compose pre-pass + proposal contract — the PURE half of the composer.
//
// The composer is an LLM ("composer proposes"), but everything around it is
// deterministic ("engine disposes"): this module owns the keyword pre-pass
// that can answer without any LLM call, the grounding pack that anchors the
// LLM in the compiled plan's REAL numbers instead of prose, and the strict
// proposal parser that turns model output into data — or a structured
// failure, never a guess. No I/O anywhere in this file.

import { AIDLC_CAPABILITIES, capabilityFor } from './aidlc-capabilities.js';

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
//   scopeSettings:     { [scopeId]: { <authored setting>: value } } — what each
//              scope authors, so a proposed value starts from the real default
//              instead of being invented. Rendered only for a release that has
//              the per-intent settings at all (`settingsScopeId` is supplied),
//              so the compose prompt of every older pinned release is unchanged.
//   settingsScopeId:   the scope whose values `effectiveSettings` describes, so
//              the section says WHICH selection is in force rather than leaving
//              the reader to assume.
//   effectiveSettings: [{ name, value, source }] — the settings this intent
//              already runs with and where each came from. This is the honest
//              half of upstream's `engine config get`: the composer reads the
//              effective values from the prompt, and the annex forbids it
//              looking for a settings or environment file to find them.
const buildGroundingPack = ({
  scopes = [],
  summaries = {},
  grids = {},
  stages = [],
  scopeSettings = {},
  settingsScopeId = null,
  effectiveSettings = [],
}) => {
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
    const authored = settingsScopeId ? scopeSettings[id] : null;
    if (authored && Object.keys(authored).length > 0) {
      lines.push(
        `  Settings: ${Object.entries(authored)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}`,
      );
    }
    const grid = grids[id];
    if (grid) {
      const executed = Object.entries(grid)
        .filter(([, v]) => v === 'EXECUTE')
        .map(([k]) => k);
      lines.push(`  EXECUTE: ${executed.join(', ')}`);
    }
  }
  if (effectiveSettings.length > 0) {
    lines.push('');
    lines.push('## AI-DLC settings in force for this intent');
    if (settingsScopeId) {
      lines.push(`Resolved for the selected scope "${settingsScopeId}".`);
    }
    for (const { name, value, source } of effectiveSettings) {
      lines.push(`- ${name}: ${value} (${source})`);
    }
    lines.push(
      "These are the effective values — the selected scope's own value for each",
      'setting, with any override recorded for this intent on top — and this',
      'prompt is the whole truth about them:',
      'do not look for a settings, environment or shell file to read them from.',
      'You may PROPOSE different values; a person on the project accepts or rejects',
      'the proposal before anything runs, and you never apply one yourself.',
    );
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

// The library agent whose persona, and the knowledge filed under it, the compose
// prompt renders.
const COMPOSER_AGENT_ID = 'aidlc-composer-agent';

// ── The composer's settings proposal (2.11) ──────────────────────────────────
//
// From 2.11 the composer returns the ceremony settings beside the grid: one
// Guard Policy plus the six `scope_settings` it echoes from its validator, each
// under the exact field name the scope file uses. Until this module parsed
// them they were dropped on the floor — a valid proposal reached the platform
// with its settings silently gone.
//
// The legal values are NOT written here: each setting names the SCOPE
// capability entry whose value set the importer already validates, so an
// authored scope, the per-intent chooser and a composer proposal all speak one
// vocabulary and cannot drift.
const COMPOSE_SCOPE_SETTING_CAPABILITIES = Object.freeze({
  sensors: 'SCOPE:sensors',
  learnings: 'SCOPE:learnings',
  summary_confirmation: 'SCOPE:summary_confirmation',
  plan_approval: 'SCOPE:plan_approval',
  collaborators: 'SCOPE:collaborators',
  review_cap: 'SCOPE:review_cap',
});
const COMPOSE_SCOPE_SETTING_KEYS = Object.freeze(Object.keys(COMPOSE_SCOPE_SETTING_CAPABILITIES));
const GUARD_POLICY_CAPABILITY = 'SCOPE:guard_policy';

const capabilityValues = (key) => Object.keys(capabilityFor(key)?.values ?? {});

// What one SCOPE block authors, keyed by the field name the scope FILE uses —
// which is the name the composer's own contract speaks, not the camelCase the
// mapper writes. Derived from the capability registry so a new setting reaches
// the grounding by being registered, never by being listed again here.
const authoredScopeSettings = (scopeBlock) => {
  const authored = {};
  if (!scopeBlock) return authored;
  for (const capability of AIDLC_CAPABILITIES) {
    if (capability.blockType !== 'SCOPE' || !capability.values || !capability.planKey) continue;
    const value = scopeBlock[capability.planKey];
    if (value != null) authored[capability.field] = String(value);
  }
  return authored;
};

// Upstream's in-flight settings change: typed values the engine applies to open
// work on a human's approval. This platform refuses it BY NAME rather than by
// silence — the settings belong to the intent, a started intent answers
// `settings_locked`, and the dialect annex tells the composer that a human
// changes them on the intent. Parsing it as a no-op would be the dishonest
// outcome: the composer would believe its change had been taken.
const COMPOSE_SETTINGS_CHANGE_ERROR = 'compose_settings_change_unsupported';

// A label the composer suggests, not an identifier the platform resolves, so it
// is only length-bounded — nothing here mints a scope from it (`scope save` is
// refused in the annex).
const MAX_PROPOSAL_LABEL = 64;

const boundedLabel = (value) =>
  typeof value === 'string' && value.trim() && value.trim().length <= MAX_PROPOSAL_LABEL
    ? value.trim()
    : null;

// The output contract the composer must satisfy — rendered into the prompt
// verbatim so parseComposeProposal and the instructions can never drift.
//
// GATED on `settingsAware`: the settings members are asked for only when the
// pinned catalog actually authors the per-intent settings. A release that does
// not — no pin, 2.3.3, and anything before 2.11 — therefore receives the
// BYTE-IDENTICAL contract it received before this PR, which is what keeps its
// whole compose prompt byte-identical. The parser accepts the settings members
// whenever they arrive, so a model that volunteers them on an older pin is
// still parsed rather than rejected; nothing offers them to a member, because
// the plan authors nothing to offer.
const BASE_PROPOSAL_CONTRACT = [
  'Respond with EXACTLY ONE fenced JSON block and nothing else:',
  '```json',
  '{',
  '  "mode": "matched" | "custom",',
  '  "scope": "<stock scope id for matched; a short kebab-case label for custom>",',
  '  "grid": { "<stage-id>": "EXECUTE" | "SKIP", ... },   // custom mode only: EVERY stage in the catalog',
];
const SETTINGS_PROPOSAL_MEMBERS = [
  '  "guardPolicy": "strict" | "relaxed" | "off",         // optional: the guard the work should run with',
  '  "scopeSettings": { "sensors": "on"|"off", "learnings": "on"|"off", "summary_confirmation": "on"|"off", "plan_approval": "on"|"off", "collaborators": "on"|"off", "review_cap": "adversarial"|"advisory"|"none" },',
  '  "baseScope": "<custom mode only: the stock scope the plan runs on>",',
  '  "creationDepth": "<custom mode only: the depth the plan is created at>",',
];
const PROPOSAL_CONTRACT_TAIL = [
  '  "rationale": ["<one short reason per SKIP or notable inclusion>"],',
  '  "confidence": 0.0-1.0',
  '}',
  '```',
  'Rules: initialization stages are ALWAYS EXECUTE. Never invent stage ids.',
];
const SETTINGS_PROPOSAL_RULES = [
  'The settings members are OPTIONAL and are a PROPOSAL: a person on the project',
  'accepts them on the compose page before anything runs, and they apply to this',
  'intent only. Only Guard Policy, plan_approval and collaborators are choices a',
  'person can make here; the other settings are recorded for them to read and',
  'follow the scope. Never propose turning plan_approval off — only the person does',
  'that, in their own words.',
  'Do NOT return "settingsChanges": this runtime cannot change a setting on work',
  'that has already started. Settings belong to the intent and only a human',
  'changes them, before the run starts.',
];
const PROPOSAL_CONTRACT_CLOSE =
  'If you cannot produce a valid grid, respond with {"mode":"failed","reason":"<why>"} instead — never guess.';

const proposalContract = ({ settingsAware = false } = {}) =>
  [
    ...BASE_PROPOSAL_CONTRACT,
    ...(settingsAware ? SETTINGS_PROPOSAL_MEMBERS : []),
    ...PROPOSAL_CONTRACT_TAIL,
    ...(settingsAware ? SETTINGS_PROPOSAL_RULES : []),
    PROPOSAL_CONTRACT_CLOSE,
  ].join('\n');

const PROPOSAL_CONTRACT = proposalContract();

// Parse the composer's optional settings proposal. Each member is kept ONLY
// when the composer sent it, so a 2.8.2/2.9.0 proposal — which is never asked
// for any of them — parses to exactly the object it parses to today.
const parseProposalSettings = (parsed) => {
  if (parsed.settingsChanges != null) {
    return {
      error: `${COMPOSE_SETTINGS_CHANGE_ERROR}: a settings change cannot be applied to work in flight here. Settings belong to the intent and a human changes them before the run starts.`,
    };
  }
  const settings = {};
  if (parsed.guardPolicy != null) {
    const allowed = capabilityValues(GUARD_POLICY_CAPABILITY);
    if (!allowed.includes(parsed.guardPolicy)) {
      return { error: `proposal guardPolicy must be one of ${allowed.join(' | ')}` };
    }
    settings.guardPolicy = parsed.guardPolicy;
  }
  if (parsed.scopeSettings != null) {
    if (typeof parsed.scopeSettings !== 'object' || Array.isArray(parsed.scopeSettings)) {
      return { error: 'proposal scopeSettings must be an object of setting values' };
    }
    const scopeSettings = {};
    for (const [key, value] of Object.entries(parsed.scopeSettings)) {
      if (!COMPOSE_SCOPE_SETTING_KEYS.includes(key)) {
        return {
          error: `proposal scopeSettings["${key}"] is not a setting; expected ${COMPOSE_SCOPE_SETTING_KEYS.join(' | ')}`,
        };
      }
      if (value == null) continue;
      const allowed = capabilityValues(COMPOSE_SCOPE_SETTING_CAPABILITIES[key]);
      if (!allowed.includes(value)) {
        return {
          error: `proposal scopeSettings["${key}"] must be one of ${allowed.join(' | ')}`,
        };
      }
      scopeSettings[key] = value;
    }
    if (Object.keys(scopeSettings).length > 0) settings.scopeSettings = scopeSettings;
  }
  const baseScope = boundedLabel(parsed.baseScope);
  if (parsed.baseScope != null && !baseScope) {
    return { error: 'proposal baseScope must be a short non-empty scope name' };
  }
  if (baseScope) settings.baseScope = baseScope;
  const creationDepth = boundedLabel(parsed.creationDepth);
  if (parsed.creationDepth != null && !creationDepth) {
    return { error: 'proposal creationDepth must be a short non-empty depth name' };
  }
  if (creationDepth) settings.creationDepth = creationDepth;
  return { settings };
};

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
  const { settings, error: settingsError } = parseProposalSettings(parsed);
  if (settingsError) return { error: settingsError };
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
    ...settings,
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
  COMPOSER_AGENT_ID,
  COMPOSE_SCOPE_SETTING_CAPABILITIES,
  COMPOSE_SCOPE_SETTING_KEYS,
  COMPOSE_SETTINGS_CHANGE_ERROR,
  authoredScopeSettings,
  proposalContract,
  keywordHit,
  matchScopeByKeywords,
  buildGroundingPack,
  parseComposeProposal,
  PROPOSAL_CONTRACT,
};
export default {
  COMPOSER_AGENT_ID,
  COMPOSE_SCOPE_SETTING_CAPABILITIES,
  COMPOSE_SCOPE_SETTING_KEYS,
  COMPOSE_SETTINGS_CHANGE_ERROR,
  authoredScopeSettings,
  proposalContract,
  keywordHit,
  matchScopeByKeywords,
  buildGroundingPack,
  parseComposeProposal,
  PROPOSAL_CONTRACT,
};
