// Tier-model configuration — the per-tier successor to the flat per-CLI model
// map (cli-models.js). Upstream agents (≥2.3.1) declare a work-shaped `tier`
// (judgment | balanced | templated) instead of a raw model pin; what model a
// tier means is DEPLOYMENT configuration, authored here at two levels (Admin
// global SSM + per-project vertex) and merged at intent create.
//
// Shape (every row is a per-CLI map, same keys/validation as cliModels):
//   {
//     tiers: {
//       judgment:  { claude?, kiro?, opencode? },   // strongest models
//       balanced:  { … },                           // reviewers / mid work
//       templated: { … },                           // planners / cheapest
//     },
//     fallback: { … },   // no tier resolvable (tier-less agent, no legacy pin)
//     quorum:   { … },   // one-shot Quorum surfaces (discussions, edit plans)
//   }
//
// Legacy compatibility: the flat cliModels selection keeps its EXACT position
// in the runtime precedence (project/global flat selection beats the agent
// block) — a deployment that never touches tier-models behaves byte-identically
// to before. The tier rows engage below the flat map; see model-resolver.js
// for the full chain.

import { normalizeCliModels } from './cli-models.js';

const TIER_MODEL_ROWS = ['judgment', 'balanced', 'templated', 'fallback', 'quorum'];
const AGENT_TIER_ROWS = ['judgment', 'balanced', 'templated'];

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// Validate + normalize a raw tier-models value (object or JSON string).
// Returns { valid, issues: [{ path, message }], value } where `value` is the
// canonical flat-row shape { judgment?, balanced?, templated?, fallback?,
// quorum? } — each a normalized per-CLI map. Both the nested authored shape
// ({ tiers: { judgment: … }, fallback, quorum }) and the flat row shape are
// accepted on input; the FLAT shape is canonical everywhere downstream.
function normalizeTierModels(value) {
  const issues = [];
  const normalized = {};

  if (value === undefined || value === null) {
    return { valid: true, issues, value: normalized };
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (err) {
      return {
        valid: false,
        issues: [{ path: '', message: `Invalid JSON: ${err.message}.` }],
        value: normalized,
      };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      valid: false,
      issues: [{ path: '', message: `Expected an object; got ${describe(value)}.` }],
      value: normalized,
    };
  }

  // Flatten the authored nested shape; reject unknown keys loudly (a typo'd
  // tier name would otherwise silently configure nothing).
  const flat = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'tiers') {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push({ path: 'tiers', message: `Expected an object; got ${describe(raw)}.` });
        continue;
      }
      for (const [tier, row] of Object.entries(raw)) {
        if (!AGENT_TIER_ROWS.includes(tier)) {
          issues.push({
            path: `tiers.${tier}`,
            message: `Unknown tier "${tier}". Allowed: ${AGENT_TIER_ROWS.join(', ')}.`,
          });
          continue;
        }
        flat[tier] = row;
      }
      continue;
    }
    if (!TIER_MODEL_ROWS.includes(key)) {
      issues.push({
        path: key,
        message: `Unknown row "${key}". Allowed: ${TIER_MODEL_ROWS.join(', ')} (or nested under "tiers").`,
      });
      continue;
    }
    flat[key] = raw;
  }

  for (const [row, raw] of Object.entries(flat)) {
    if (raw === undefined || raw === null) continue;
    const validation = normalizeCliModels(raw);
    for (const issue of validation.issues) {
      issues.push({ path: `${row}.${issue.path}`, message: issue.message });
    }
    if (Object.keys(validation.value).length > 0) normalized[row] = validation.value;
  }

  return { valid: issues.length === 0, issues, value: normalized };
}

// Lenient parse (mirror of parseCliModels): whatever validates survives.
function parseTierModels(raw) {
  return normalizeTierModels(raw || {}).value;
}

// Merge the Admin GLOBAL tier config UNDER a project's: the project value wins
// per row per CLI, the global fills the gaps — the same field-wise semantics
// mergeCliModels gives the flat map. Returns the canonical flat-row shape.
function mergeTierModels(project, global) {
  const p = parseTierModels(project);
  const g = parseTierModels(global);
  const merged = {};
  for (const row of TIER_MODEL_ROWS) {
    const combined = { ...g[row], ...p[row] };
    if (Object.keys(combined).length > 0) merged[row] = combined;
  }
  return merged;
}

export { TIER_MODEL_ROWS, AGENT_TIER_ROWS, normalizeTierModels, parseTierModels, mergeTierModels };
export default {
  TIER_MODEL_ROWS,
  AGENT_TIER_ROWS,
  normalizeTierModels,
  parseTierModels,
  mergeTierModels,
};
