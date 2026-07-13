// Stage materializer — turns a resolved plan stage + the loaded library into the
// concrete things the headless CLI needs to run ONE stage:
//   1. a stage PROMPT that injects the MCP execution annex FIRST (the harness
//      binding that redirects the upstream filesystem/bun stage prose onto our
//      MCP tools), then the persona + stage body + a tail output-contract reminder,
//   2. the rule + knowledge bodies written into the workspace as steering files,
//   3. an `--mcp-config` JSON pointing at our stdio MCP server with the trusted
//      scope ENV.
//
// The PROMPT ASSEMBLY is a pure function (no fs/network) so it is unit-tested in
// isolation; the workspace write is the thin effectful shell.

import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStructureContracts } from '../shared/artifact-structure-contract.js';

// The MCP execution annex — the harness binding that redirects the upstream
// stage prose (which is written for a filesystem + `bun` harness) onto our MCP
// tool surface. Injected FIRST in the prompt so the agent reads the binding
// before the filesystem-laden stage instructions. Authored + owned by us; see
// docs/v2-runtime.md. Loaded once at module init.
const annexPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'prompts',
  'mcp-execution-annex.md',
);
export const MCP_EXECUTION_ANNEX = readFileSync(annexPath, 'utf8').trimEnd();

// Upstream bodies carry a literal `{{HARNESS_DIR}}` token (substituted only at
// upstream's own dist build, which we bypass by fetching core/ raw). We neutralize
// it at the PROMPT layer — the seeded block body stays verbatim — so the agent
// never sees a raw templating artifact. The annex tells it to ignore the location.
const HARNESS_DIR_TOKEN = /\{\{HARNESS_DIR\}\}/g;
export const neutralizeHarnessDir = (text = '') =>
  text.replace(HARNESS_DIR_TOKEN, '<runtime-managed>');

// The strict output contract — a short tail reminder of the load-bearing tool
// calls. The annex (injected first) owns the full "MCP is your only I/O" framing;
// this just restates the must-not-forget writes at the end of the prompt.
export const OUTPUT_CONTRACT = [
  '## Output contract (reminder)',
  '',
  '- Record EVERY business artifact via `create_artifact`; wire links with',
  '  `link_artifacts`. Output not written through a tool is DISCARDED.',
  '- Finish with a `send_output` summary and `collect_metric` for usage.',
  '- Do exactly THIS stage. Do not start other stages or invent status.',
].join('\n');

// Render the resolved input artifacts as a prompt section. An `expectedAbsent`
// input (its producer exists in the workflow but is out of the selected scope —
// the plan resolver's scope-shortcut classification) is called out explicitly:
// the agent must never fabricate the missing artifact's content, and must fall
// back to whatever in-scope context exists instead of failing a read and
// improvising differently each run.
const renderInputs = (inputArtifacts = []) => {
  if (inputArtifacts.length === 0) return '- none';
  return inputArtifacts
    .map((i) => {
      if (i.expectedAbsent) {
        return (
          `- ${i.artifact} — NOT produced in this scope (producer out of scope; absence is by design). ` +
          'Do NOT fabricate its content and do NOT treat its absence as an error; fall back to the ' +
          'available in-scope context (the other inputs above, the reverse-engineered code knowledge, the workspace itself).'
        );
      }
      return `- ${i.artifact}${i.required ? '' : ' (optional)'}${i.producedBy?.length ? ` — from ${i.producedBy.join(', ')}` : ''}`;
    })
    .join('\n');
};

// An `optional: true` output (upstream `optional_produces`) MAY be written —
// the agent produces it only when the work calls for it, and its absence is
// never an error (the sensors/coverage exempt it too).
const renderOutputs = (outputArtifacts = []) =>
  outputArtifacts.length
    ? outputArtifacts
        .map(
          (o) =>
            `- ${o.artifact}${o.optional ? ' (conditional — produce it only when this work actually calls for it; omitting it is normal)' : ''}`,
        )
        .join('\n')
    : '- none';

// Render the intent block — the run's north star.
// PURE. Injected near the top of every fresh stage prompt: early stages work
// FROM it; later stages get it as originating context with refined artifacts
// taking precedence.
export const renderIntentBlock = ({ title, prompt, scope } = {}) => {
  if (!title && !prompt) return '';
  return [
    '## The intent (originating request)',
    '',
    ...(title ? [`**${title}**${scope ? ` (scope: ${scope})` : ''}`, ''] : []),
    ...(prompt ? [prompt.trim(), ''] : []),
    'This is what the human asked for — the whole run serves it. Earlier',
    "stages' recorded artifacts REFINE it; where they exist, they take",
    'precedence over this raw request.',
  ].join('\n');
};

// Render the unit-scope block for a `forEach: unit-of-work` lane run
// (docs/v2-parallel.md WP4). PURE. `unit` = { slug, dependsOn, kind } from the
// promoted UNITPLAN — the engine's scheduling truth, never agent-supplied.
// Injected right before the stage instructions so the fan-out framing is read
// before the (once-per-workflow-worded) stage prose.
export const renderUnitScope = (unit) => {
  if (!unit?.slug) return '';
  const deps = (unit.dependsOn ?? []).filter(Boolean);
  return [
    '## Unit scope (fan-out)',
    '',
    `This stage runs ONCE PER UNIT OF WORK; this run is scoped to the unit`,
    `**${unit.slug}** only.`,
    '',
    `- Unit: ${unit.slug}`,
    ...(unit.kind ? [`- Unit kind: ${unit.kind}`] : []),
    `- Depends on (already completed): ${deps.length ? deps.join(', ') : 'none'}`,
    '',
    'Apply the stage instructions to THIS unit alone: only the stories,',
    `components, and requirements the unit-of-work artifacts assign to "${unit.slug}".`,
    'Treat dependency units\u2019 outputs as read-only inputs. Do NOT design, modify,',
    'or generate work for any other unit — their own lanes handle that.',
  ].join('\n');
};

// Assemble the full stage prompt. PURE. `ctx`:
//   stage           — the resolved plan stage (stageId, phase, agentRef, in/out,
//                      rules refs, humanValidation)
//   stageBody       — the STAGE block's markdown instructions
//   agentPersona    — the lead AGENT block's body (the persona)
//   knowledge       — concatenated methodology knowledge for the agent (optional)
export const buildStagePrompt = ({
  stage = {},
  unit = null,
  intent = null, // { title, prompt, scope } — the originating request
  stageBody = '',
  agentPersona = '',
  knowledge = '',
  conductor = '',
  compiledContext = '',
}) => {
  const sections = [
    `# Stage: ${stage.stageId ?? 'unknown'} (phase: ${stage.phase ?? 'unphased'})`,
    '',
    `You are the **${stage.agentRef ?? 'assigned'}** agent executing ONE stage of an`,
    'AI-DLC v2 workflow. Follow the stage instructions for WORK QUALITY; follow the',
    'execution environment below for MECHANICS.',
  ];
  // The harness binding goes FIRST — it must be read before the filesystem-laden
  // stage prose so the agent translates rather than obeys it literally.
  sections.push('', MCP_EXECUTION_ANNEX);
  // The intent — what the human actually asked for. Right after the harness
  // binding so every stage knows the run's north star without interviewing the
  // human for it.
  const intentBlock = renderIntentBlock(intent ?? {});
  if (intentBlock) sections.push('', intentBlock);
  // The conductor persona (upstream execution-quality doctrine) — loaded from the
  // pinned runtime snapshot so the quality guidance can't drift from upstream.
  // The annex already declared it authoritative for WORK QUALITY (not mechanics);
  // injecting the real file means the agent reads upstream's actual craft notes,
  // not a hand-distilled paraphrase. Neutralized for the {{HARNESS_DIR}} token.
  if (conductor)
    sections.push('', '## Execution quality (conductor)', neutralizeHarnessDir(conductor));
  if (agentPersona) sections.push('', '## Your role', neutralizeHarnessDir(agentPersona));
  if (compiledContext) sections.push('', neutralizeHarnessDir(compiledContext));
  // Unit lane: the fan-out scoping must precede the stage prose (which is
  // worded once-per-workflow) so the agent reads its lane boundary first.
  const unitScope = renderUnitScope(unit);
  if (unitScope) sections.push('', unitScope);
  sections.push(
    '',
    '## Stage instructions',
    neutralizeHarnessDir(stageBody) || '(no stage body supplied)',
  );
  sections.push('', '## Inputs (read via the MCP tools)', renderInputs(stage.inputArtifacts));
  sections.push(
    '',
    '## Expected outputs (record each via create_artifact)',
    renderOutputs(stage.outputArtifacts),
  );
  // Structure contracts — generated from the extraction registry for THIS
  // stage's registered output types (artifact-structure-contract.js). Placed
  // directly after the outputs list so "what to produce" and "what shape it
  // must take" read as one unit. Nothing is injected for unregistered types.
  const structureContracts = renderStructureContracts(
    (stage.outputArtifacts ?? []).map((o) => o.artifact ?? o).filter(Boolean),
  );
  if (structureContracts) sections.push('', structureContracts);
  if (knowledge) sections.push('', '## Reference knowledge', neutralizeHarnessDir(knowledge));
  if (stage.humanValidation === 'required') {
    sections.push(
      '',
      '## Human validation',
      "This stage's output is reviewed by a human out-of-band, after you finish —",
      'the runtime owns that gate. Do NOT prompt for approval or render an approval',
      'question; end with a `send_output` summary of what you produced.',
    );
  }
  sections.push('', OUTPUT_CONTRACT);
  return sections.join('\n');
};

// Build the --mcp-config JSON the CLI loads. Points at our stdio MCP server and
// passes the TRUSTED scope as the child's ENV (the agent can't override it). The
// command/args are server-controlled. `customServers` (a name→spec map, already
// validated + reserved-name-filtered upstream) are spread FIRST so the reserved
// `aidlc` entry, written last, always wins a name collision — a custom entry can
// never override the runtime bridge.
export const buildMcpConfig = ({ mcpEntry, scope, env = {}, customServers = {} }) => ({
  mcpServers: {
    ...customServers,
    aidlc: {
      command: 'node',
      args: [mcpEntry],
      env: {
        V2_EXECUTION_ID: scope.executionId,
        V2_INTENT_ID: scope.intentId,
        V2_PROJECT_ID: scope.projectId ?? '',
        V2_STAGE_INSTANCE_ID: scope.stageInstanceId ?? '',
        // Unit lane attribution (docs/v2-parallel.md WP4): the bridge stamps
        // this on every gate/output/metric/event row it writes. Empty → null.
        V2_UNIT_SLUG: scope.unitSlug ?? '',
        V2_RESOLVED_MODEL: scope.model ?? '',
        V2_MCP_ROLE: scope.role ?? 'author',
        // Trusted reviewer identity (reviewer role only): the bridge stamps this
        // on the verdict row instead of trusting the agent's self-reported name
        // (upstream §12a identity marker, enforced server-side). Empty → null.
        V2_REVIEWER_AGENT: scope.reviewerAgent ?? '',
        V2_PROCESS_TABLE: env.V2_PROCESS_TABLE ?? '',
        NEPTUNE_ENDPOINT: env.NEPTUNE_ENDPOINT ?? '',
        GREMLIN_PROTOCOL: env.GREMLIN_PROTOCOL ?? 'wss',
        GREMLIN_PORT: env.GREMLIN_PORT ?? '8182',
        CONNECTIONS_TABLE: env.CONNECTIONS_TABLE ?? '',
        WEBSOCKET_ENDPOINT: env.WEBSOCKET_ENDPOINT ?? '',
        AWS_REGION: env.AWS_REGION ?? '',
        ARTIFACTS_BUCKET: env.ARTIFACTS_BUCKET ?? '',
      },
    },
  },
});

// Concatenate the bodies of the rule blocks resolved for this stage (universal +
// phase). `rulesById` is the library bag; `ruleBodies` maps ruleId → body text.
export const renderRulesDoc = (stage, ruleBodies = {}) => {
  const ids = [...(stage.rules?.universal ?? []), ...(stage.rules?.phase ?? [])];
  const parts = ids.map((id) => ruleBodies[id]).filter(Boolean);
  return parts.join('\n\n---\n\n');
};

// Effectful: write JUST the `.aidlc/mcp-config.json` the CLI loads and return its
// path. A resume re-invocation needs only the MCP config re-attached (the prompt
// + rules already shaped the parked conversation), so this is factored out of
// materializeStage and reused by run-stage's resume branch.
export const materializeMcpConfig = async ({
  workspaceDir,
  mcpEntry,
  scope,
  env = process.env,
  customServers = {},
}) => {
  const aidlcDir = path.join(workspaceDir, '.aidlc');
  await mkdir(aidlcDir, { recursive: true });
  const mcpConfig = buildMcpConfig({ mcpEntry, scope, env, customServers });
  const mcpConfigPath = path.join(aidlcDir, 'mcp-config.json');
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
  return mcpConfigPath;
};

// The Kiro agent-config name we register our MCP server under. Kiro (unlike
// Claude) has NO `--mcp-config` flag — it discovers MCP servers from an AGENT
// config at <cwd>/.kiro/agents/<name>.json and is told to use it via `--agent`.
export const KIRO_AGENT_NAME = 'aidlc';

// Build the Kiro agent config that wires our stdio MCP server. Reuses the exact
// server spec buildMcpConfig produces (command/args/scope-env) — just wrapped in
// Kiro's agent envelope. `tools:["*"]` exposes the MCP tools (we also pass
// --trust-all-tools so none prompt for approval). `resources` points Kiro at the
// steering dir: with a custom --agent, Kiro does NOT auto-load .kiro/steering,
// so the glob is required to load the project's custom rules
// (https://kiro.dev/docs/cli/steering). Pure.
export const buildKiroAgentConfig = ({ mcpEntry, scope, env = {}, customServers = {} }) => ({
  $schema:
    'https://raw.githubusercontent.com/aws/amazon-q-developer-cli/refs/heads/main/schemas/agent-v1.json',
  name: KIRO_AGENT_NAME,
  description: 'AI-DLC v2 stage execution agent (runtime-managed MCP surface).',
  mcpServers: buildMcpConfig({ mcpEntry, scope, env, customServers }).mcpServers,
  tools: ['*'],
  allowedTools: ['*'],
  resources: ['file://.kiro/steering/**/*.md'],
});

// Effectful: write the Kiro agent config to <workspaceDir>/.kiro/agents/aidlc.json
// and return the agent name to pass via `--agent`. The cwd-local agent dir is what
// `kiro-cli` discovers (verified: `agent list` reads <cwd>/.kiro/agents). Factored
// out like materializeMcpConfig so the resume branch reuses it.
export const materializeKiroAgent = async ({
  workspaceDir,
  mcpEntry,
  scope,
  env = process.env,
  customServers = {},
}) => {
  const agentsDir = path.join(workspaceDir, '.kiro', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const config = buildKiroAgentConfig({ mcpEntry, scope, env, customServers });
  await writeFile(
    path.join(agentsDir, `${KIRO_AGENT_NAME}.json`),
    JSON.stringify(config, null, 2),
    'utf8',
  );
  return KIRO_AGENT_NAME;
};

// Per-driver NATIVE rules directory (relative to the workspace). The CLI
// auto-loads markdown here at session start — even headless:
//   Claude  → .claude/rules/*.md  (https://code.claude.com/docs/en/memory)
//   Kiro    → .kiro/steering/*.md (loaded via the agent `resources` glob)
const CLI_RULES_DIR = {
  claude: path.join('.claude', 'rules'),
  kiro: path.join('.kiro', 'steering'),
};

// Sanitize an uploaded rule filename and resolve its destination inside
// `rulesDir`, prefixed `custom--` to namespace it from any other rules. Strips
// path separators (path.basename), enforces `.md`, and verifies the resolved
// path stays under rulesDir. Returns null when unsafe.
const safeRuleDest = (rulesDir, filename) => {
  if (!filename || typeof filename !== 'string') return null;
  const base = path.basename(filename);
  if (!base || base === '.' || base === '..') return null;
  if (!base.toLowerCase().endsWith('.md')) return null;
  const destName = `custom--${base}`;
  const dest = path.resolve(rulesDir, destName);
  const root = path.resolve(rulesDir);
  if (dest !== path.join(root, destName) || !dest.startsWith(root + path.sep)) return null;
  return dest;
};

// Effectful: write the project's custom agent rules into the selected CLI's
// native rules directory so the CLI auto-loads them (NOT concatenated into the
// prompt). `customRules` is [{ filename, body }] already fetched from S3.
// Returns the list of written basenames (for logging/tests). Best-effort per
// file — an unsafe name is skipped, never throws.
export const materializeCustomRules = async ({ workspaceDir, cli, customRules = [] }) => {
  const rel = CLI_RULES_DIR[cli];
  if (!rel || !Array.isArray(customRules) || customRules.length === 0) return [];
  const rulesDir = path.join(workspaceDir, rel);
  await mkdir(rulesDir, { recursive: true });
  const written = [];
  for (const doc of customRules) {
    const dest = safeRuleDest(rulesDir, doc?.filename);
    if (!dest) continue;
    await writeFile(dest, doc.body ?? '', 'utf8');
    written.push(path.basename(dest));
  }
  return written;
};

// Effectful: write the workspace files for a stage and return the paths the CLI
// runner needs. `workspaceDir` is the session-persistent checkout root.
//   - .aidlc/rules.md            steering (resolved methodology rules)
//   - .aidlc/mcp-config.json     the --mcp-config the CLI loads
//   - <driver rules dir>/custom--*.md  project custom rules (CLI auto-loads)
// The stage prompt itself is returned (the runner pipes it to the CLI), not
// written to disk.
export const materializeStage = async ({
  workspaceDir,
  stage,
  unit = null,
  intent = null,
  stageBody,
  agentPersona,
  knowledge,
  conductor = '',
  compiledContext = '',
  rulesDoc,
  mcpEntry,
  scope,
  env = process.env,
  customServers = {},
  cli = null,
  customRules = [],
}) => {
  const aidlcDir = path.join(workspaceDir, '.aidlc');
  await mkdir(aidlcDir, { recursive: true });

  if (rulesDoc) await writeFile(path.join(aidlcDir, 'rules.md'), rulesDoc, 'utf8');

  await materializeCustomRules({ workspaceDir, cli, customRules });

  const mcpConfigPath = await materializeMcpConfig({
    workspaceDir,
    mcpEntry,
    scope,
    env,
    customServers,
  });

  const prompt = buildStagePrompt({
    stage,
    unit,
    intent,
    stageBody,
    agentPersona,
    knowledge,
    conductor,
    compiledContext,
  });
  return { prompt, mcpConfigPath, rulesPath: rulesDoc ? path.join(aidlcDir, 'rules.md') : null };
};
