// Model resolver — picks the Bedrock model id for a stage run and resolves bare
// tier aliases to full ids.
//
// Precedence (decided): the project's per-CLI Admin selection wins, then the
// stage/agent block's modelOverride, then the static env default. The Admin knob
// is authoritative; the upstream per-agent override (every agent ships one) is the
// fallback when a project hasn't chosen a model for the selected CLI.
//
// Alias resolution: upstream agent overrides are bare tiers ('opus'/'sonnet'/
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

// Pick the model for a stage run. `cli` is the selected CLI (the cliModels key).
//
// Bedrock CLIs (claude/opencode): precedence cliModels[cli] > agent override > env
// defaults, then alias/region resolution — these are all Bedrock concepts.
//
// Kiro: ONLY an explicit project selection (cliModels.kiro) applies, passed through
// verbatim (no Bedrock alias/region resolution). The bare-alias agent override and
// the BEDROCK_MODEL/AGENT_MODEL env are Bedrock-shaped and must NOT leak into Kiro.
// When unset, return undefined so the driver omits --model and Kiro uses its own
// default (`auto`).
export const resolveStageModel = ({
  cliModels = {},
  agentBlock = null,
  cli,
  env = process.env,
}) => {
  if (!BEDROCK_CLIS.has(cli)) {
    const selected = cliModels?.[cli];
    return selected ? String(selected).trim() : undefined;
  }
  const raw =
    cliModels?.[cli] || agentBlock?.modelOverride || env.AGENT_MODEL || env.BEDROCK_MODEL || '';
  return resolveModelId(raw, { env });
};
