const ALLOWED_CLI_MODEL_KEYS = new Set(['kiro', 'claude', 'opencode', 'codex']);
const MAX_CLI_MODEL_LENGTH = 200;
const OPENCODE_MODEL_PREFIX = 'amazon-bedrock/';
const CODEX_MODEL_PREFIX = 'openai.';
// A full Codex-on-Bedrock id: the prefix plus a non-empty model name (bare
// "openai." would pass a prefix check but fail at invocation time).
const CODEX_MODEL_ID = /^(?:(?:global|us|eu|apac)\.)?openai\.[A-Za-z0-9][A-Za-z0-9._-]*$/;

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function normalizeCliModels(value) {
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

  for (const [key, raw] of Object.entries(value)) {
    if (!ALLOWED_CLI_MODEL_KEYS.has(key)) {
      issues.push({
        path: key,
        message: `Unknown model key "${key}". Allowed: ${[...ALLOWED_CLI_MODEL_KEYS].join(', ')}.`,
      });
      continue;
    }
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      issues.push({ path: key, message: `Expected string; got ${describe(raw)}.` });
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length > MAX_CLI_MODEL_LENGTH) {
      issues.push({
        path: key,
        message: `Must be ${MAX_CLI_MODEL_LENGTH} characters or fewer.`,
      });
      continue;
    }
    if (key === 'opencode' && trimmed && !trimmed.startsWith(OPENCODE_MODEL_PREFIX)) {
      issues.push({
        path: key,
        message: `OpenCode model must start with "${OPENCODE_MODEL_PREFIX}".`,
      });
      continue;
    }
    // Claude on Bedrock uses a bare cross-region inference profile ID — the
    // inverse of OpenCode: the "amazon-bedrock/" provider prefix is invalid.
    if (key === 'claude' && trimmed && trimmed.startsWith(OPENCODE_MODEL_PREFIX)) {
      issues.push({
        path: key,
        message: `Claude model must be a bare Bedrock inference profile ID (no "${OPENCODE_MODEL_PREFIX}" prefix).`,
      });
      continue;
    }
    // Codex on Bedrock uses its own namespace of "openai.*" ids, optionally
    // carrying a cross-Region inference (CRIS) prefix. The bare id is NOT
    // always servable: Codex calls the OpenAI-compatible endpoint
    // (bedrock-mantle.<region>.api.aws/openai/v1/responses), and for GPT-5.6 that
    // endpoint answers 404 "The model 'openai.gpt-5.6-sol' does not exist" —
    // those models are reachable only through a CRIS inference profile, so a
    // "global." or geographic prefix must be accepted here.
    // See https://aws.amazon.com/blogs/machine-learning/introduce-cross-region-inference-for-openai-gpt-5-6-models-on-amazon-bedrock/
    // A bare "openai." with an empty model name is still rejected.
    if (key === 'codex' && trimmed && !CODEX_MODEL_ID.test(trimmed)) {
      issues.push({
        path: key,
        message: `Codex model must be a Bedrock OpenAI model ID containing "${CODEX_MODEL_PREFIX}", optionally with a cross-Region inference prefix (e.g. "openai.gpt-5.5" or "global.openai.gpt-5.6-sol").`,
      });
      continue;
    }
    if (trimmed) normalized[key] = trimmed;
  }

  return { valid: issues.length === 0, issues, value: normalized };
}

function parseCliModels(raw) {
  const validation = normalizeCliModels(raw || {});
  return validation.value;
}

// Merge the Admin GLOBAL per-CLI models UNDER a project's selection: the project
// value wins per CLI, the global fills the gaps. This is what makes the runtime's
// model precedence `project > global(admin) > agentBlock > env` — the intents
// lambda snapshots the merged map onto the intent at create so the run is
// reproducible AND the global default the UI advertises is actually applied.
// Both inputs are parsed/validated first; only truthy values contribute (an empty
// string never shadows a global). Returns a plain {cli: model} map.
function mergeCliModels(project, global) {
  const p = parseCliModels(project);
  const g = parseCliModels(global);
  const merged = {};
  for (const [cli, model] of Object.entries(g)) {
    if (model) merged[cli] = model;
  }
  for (const [cli, model] of Object.entries(p)) {
    if (model) merged[cli] = model;
  }
  return merged;
}

export { normalizeCliModels, parseCliModels, mergeCliModels };
export default { normalizeCliModels, parseCliModels, mergeCliModels };
