// Platform-level agent CLI availability (Admin → Agents → Agent CLIs).
//
// The platform admin can switch individual agent CLIs off for the whole
// deployment. The setting lives in SSM at `${AGENT_SETTINGS_SSM_PREFIX}/disabled-clis`
// as a JSON array of CLI ids. Storing the DISABLED set (rather than an enabled
// allowlist) keeps the default — an empty array or a missing parameter —
// identical to the behavior before the toggle existed: every supported CLI is
// selectable.
//
// The toggle gates NEW selections only (intent start, DRAFT compose, DRAFT
// discussion assists, the space's recommended CLI). An execution that already
// pinned a CLI keeps it, per the pinned-configuration contract.
import { GetParameterCommand } from '@aws-sdk/client-ssm';

export const AGENT_CLI_IDS = Object.freeze(['kiro', 'claude', 'opencode', 'codex']);
const KNOWN = new Set(AGENT_CLI_IDS);

export const disabledClisParameterName = (prefix) => `${prefix}/disabled-clis`;

// Strict validation for admin writes. Accepts an array (or its JSON string) of
// known CLI ids; rejects unknown ids and disabling every CLI (that would leave
// no way to start an intent). Returns a de-duplicated, canonically ordered list.
export function normalizeDisabledClis(value) {
  let input = value;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch (err) {
      return { valid: false, issues: [`Invalid JSON: ${err.message}`], value: [] };
    }
  }
  if (!Array.isArray(input)) {
    return { valid: false, issues: ['disabledClis must be an array of CLI ids'], value: [] };
  }
  const issues = [];
  const seen = new Set();
  for (const cli of input) {
    if (typeof cli !== 'string' || !KNOWN.has(cli)) {
      issues.push(`Unknown CLI "${String(cli)}". Allowed: ${AGENT_CLI_IDS.join(', ')}`);
      continue;
    }
    seen.add(cli);
  }
  if (!issues.length && seen.size === AGENT_CLI_IDS.length) {
    issues.push('At least one agent CLI must stay enabled');
  }
  const normalized = AGENT_CLI_IDS.filter((cli) => seen.has(cli));
  return { valid: issues.length === 0, issues, value: normalized };
}

// Lenient parse for reads: unknown ids are dropped; malformed input yields [].
export function parseDisabledClis(raw) {
  if (!raw) return [];
  let input = raw;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(input)) return [];
  return AGENT_CLI_IDS.filter((cli) => input.includes(cli));
}

// Read the disabled set from SSM. A missing prefix or parameter means nothing
// is disabled; any other read error propagates so an SSM outage cannot
// silently re-enable a CLI the admin switched off.
export async function readDisabledClis(ssm, prefix) {
  if (!prefix) return [];
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: disabledClisParameterName(prefix) }),
    );
    return parseDisabledClis(res?.Parameter?.Value);
  } catch (err) {
    if (err?.name === 'ParameterNotFound') return [];
    throw err;
  }
}

export const agentCliDisabledError = (agentCli) => ({
  statusCode: 400,
  body: {
    error: `The ${agentCli} agent CLI is disabled by the platform administrator`,
    code: 'agent_cli_disabled',
  },
});
