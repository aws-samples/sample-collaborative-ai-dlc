// Model resolver — picks the Bedrock model id for a stage run and resolves bare
// tier aliases to full ids.
//
// Precedence (decided): specific beats general. The agent's TIER row from the
// tier-model config (upstream ≥2.3.1 agents declare `tier: judgment | balanced
// | templated`) wins, then the flat per-CLI Admin/project selection (the
// "default model" — it doubles as the fallback for tier-less agents), then the
// agent block's legacy raw pin (`modelOverride` — older baselines and user
// forks), then the config's fallback row (legacy — the UI no longer authors
// it, but saved values keep resolving), then the static env default. A
// deployment that never configures tier rows behaves exactly as before.
//
// Alias resolution: legacy agent overrides are bare tiers ('opus'/'sonnet'/
// 'haiku'), not full Bedrock ids. Claude Code happens to accept them, but that's
// CLI-dependent — resolve them to explicit, region-prefixed ids so the choice is
// unambiguous and CLI-agnostic. A value that is already a full id (contains a '.')
// passes through untouched. The alias table is overridable via AIDLC_MODEL_ALIASES
// (JSON) so it isn't a hard version lock.

const DEFAULT_ALIASES = {
  opus: 'anthropic.claude-opus-4-6-v1',
  sonnet: 'anthropic.claude-sonnet-4-6',
  haiku: 'anthropic.claude-haiku-4-5-20251001',
};

// A value is a "full id" (leave alone) if it already looks region/provider
// qualified — it contains a dot (us.anthropic.…, anthropic.…) or a provider slash
// (amazon-bedrock/…). Bare aliases ('opus') have neither.
const isFullId = (v) => /[./]/.test(v);

// Region prefix for a resolved alias. Bedrock cross-region inference profiles are
// prefixed by geo (us./eu./apac.); derive from the runtime region, default us.
const regionPrefix = (region = '') => {
  if (region.startsWith('eu-')) return 'eu';
  if (region.startsWith('ap-')) return 'apac';
  return 'us';
};

const loadAliases = (env) => {
  if (!env.AIDLC_MODEL_ALIASES) return DEFAULT_ALIASES;
  try {
    return { ...DEFAULT_ALIASES, ...JSON.parse(env.AIDLC_MODEL_ALIASES) };
  } catch {
    return DEFAULT_ALIASES;
  }
};

// Resolve a raw model value (may be an alias or a full id) to a concrete id.
// Aliases get the region prefix; full ids and already-prefixed alias targets pass
// through. Returns undefined for an empty input.
export const resolveModelId = (raw, { env = process.env } = {}) => {
  if (!raw) return undefined;
  const value = String(raw).trim();
  if (!value) return undefined;
  if (isFullId(value)) return value; // already a full id
  const aliases = loadAliases(env);
  const target = aliases[value.toLowerCase()];
  if (!target) return value; // unknown bare token — pass through, let the CLI decide
  // Prefix the alias target with the geo unless it already carries one.
  return isFullId(target) && /^(us|eu|apac)\./.test(target)
    ? target
    : `${regionPrefix(env.AWS_REGION || env.BEDROCK_REGION)}.${target}`;
};

// CLIs whose `--model` value is a Bedrock id (inference profile / provider-
// prefixed). For these the alias table, region geo-prefixing, and the
// BEDROCK_MODEL/AGENT_MODEL env defaults all apply. Kiro is deliberately absent:
// it has its OWN model namespace (e.g. "auto", "claude-sonnet-4.6"), so a Bedrock
// id like "us.anthropic.claude-sonnet-4-6" is rejected by the kiro CLI.
const BEDROCK_CLIS = new Set(['claude', 'opencode']);

// The agent tiers a tier-model row can be keyed by. Kept in sync with the
// block library's AGENT_TIERS (shared/blocks.js) — duplicated here only to
// avoid pulling the whole block layer into the resolver.
const KNOWN_TIERS = new Set(['judgment', 'balanced', 'templated']);

// The model an agent's tier maps to for this CLI, or undefined. `tierModels`
// is the canonical flat-row shape (shared/tier-models.js): every row a
// per-CLI map. An unknown/absent tier never resolves — the chain falls
// through to the legacy pin / fallback row.
const tierModelFor = ({ tierModels, tier, cli }) => {
  if (!tierModels || !tier || !KNOWN_TIERS.has(tier)) return undefined;
  const value = tierModels[tier]?.[cli];
  return value ? String(value).trim() : undefined;
};

// The configured fallback-row model for this CLI, or undefined.
const fallbackModelFor = ({ tierModels, cli }) => {
  const value = tierModels?.fallback?.[cli];
  return value ? String(value).trim() : undefined;
};

// The effective per-CLI map for the Quorum one-shot surfaces (discussion
// assist, Quorum edit planning/apply): the dedicated quorum row wins, then the
// legacy flat selection, then the fallback row. Shaped exactly like cliModels
// so runOneShotPrompt consumes it unchanged (agent blocks play no part in
// one-shot calls — there is no persona, so there is no tier).
export const quorumCliModels = ({ cliModels = null, tierModels = null } = {}) => {
  const merged = {
    ...tierModels?.fallback,
    ...cliModels,
    ...tierModels?.quorum,
  };
  return Object.keys(merged).length > 0 ? merged : null;
};

// The effective per-CLI map for non-conversational machine one-shots (derive
// enrichment, merge-conflict resolution): legacy flat selection, backfilled by
// the fallback row.
export const machineCliModels = ({ cliModels = null, tierModels = null } = {}) => {
  const merged = { ...tierModels?.fallback, ...cliModels };
  return Object.keys(merged).length > 0 ? merged : null;
};

// Pick the model for a stage run. `cli` is the selected CLI (the cliModels key).
//
// Bedrock CLIs (claude/opencode) resolve through the full chain, then
// alias/region resolution:
//   tierModels[agent tier][cli]    — the agent's tier row (most specific)
//   > cliModels[cli]               — flat project/global default model
//   > agentBlock.modelOverride     — legacy raw pin (older refs, user forks)
//   > tierModels.fallback[cli]     — legacy fallback row (kept resolving)
//   > AGENT_MODEL / BEDROCK_MODEL  — static env default
//
// Kiro: ONLY explicit configured selections apply (tier, flat, fallback — in
// the same order), passed through verbatim (no Bedrock alias/region
// resolution). The bare-alias agent override and the BEDROCK_MODEL/AGENT_MODEL
// env are Bedrock-shaped and must NOT leak into Kiro. When unset, return
// undefined so the driver omits --model and Kiro uses its own default (`auto`).
export const resolveStageModel = ({
  cliModels = {},
  tierModels = null,
  agentBlock = null,
  cli,
  env = process.env,
}) => {
  const tier = agentBlock?.tier ?? null;
  if (!BEDROCK_CLIS.has(cli)) {
    const selected =
      tierModelFor({ tierModels, tier, cli }) ||
      cliModels?.[cli] ||
      fallbackModelFor({ tierModels, cli });
    return selected ? String(selected).trim() : undefined;
  }
  const raw =
    tierModelFor({ tierModels, tier, cli }) ||
    cliModels?.[cli] ||
    agentBlock?.modelOverride ||
    fallbackModelFor({ tierModels, cli }) ||
    env.AGENT_MODEL ||
    env.BEDROCK_MODEL ||
    '';
  return resolveModelId(raw, { env });
};
