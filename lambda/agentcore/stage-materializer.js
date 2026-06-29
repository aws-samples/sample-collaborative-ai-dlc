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

// Render the resolved input artifacts as a prompt section.
const renderInputs = (inputArtifacts = []) => {
  if (inputArtifacts.length === 0) return '- none';
  return inputArtifacts
    .map(
      (i) =>
        `- ${i.artifact}${i.required ? '' : ' (optional)'}${i.producedBy?.length ? ` — from ${i.producedBy.join(', ')}` : ''}`,
    )
    .join('\n');
};

const renderOutputs = (outputArtifacts = []) =>
  outputArtifacts.length ? outputArtifacts.map((o) => `- ${o.artifact}`).join('\n') : '- none';

// Assemble the full stage prompt. PURE. `ctx`:
//   stage           — the resolved plan stage (stageId, phase, agentRef, in/out,
//                      rules refs, humanValidation)
//   stageBody       — the STAGE block's markdown instructions
//   agentPersona    — the lead AGENT block's body (the persona)
//   knowledge       — concatenated methodology knowledge for the agent (optional)
export const buildStagePrompt = ({
  stage = {},
  stageBody = '',
  agentPersona = '',
  knowledge = '',
  conductor = '',
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
  // The conductor persona (upstream execution-quality doctrine) — loaded from the
  // pinned runtime snapshot so the quality guidance can't drift from upstream.
  // The annex already declared it authoritative for WORK QUALITY (not mechanics);
  // injecting the real file means the agent reads upstream's actual craft notes,
  // not a hand-distilled paraphrase. Neutralized for the {{HARNESS_DIR}} token.
  if (conductor)
    sections.push('', '## Execution quality (conductor)', neutralizeHarnessDir(conductor));
  if (agentPersona) sections.push('', '## Your role', neutralizeHarnessDir(agentPersona));
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
// command/args are server-controlled.
export const buildMcpConfig = ({ mcpEntry, scope, env = {} }) => ({
  mcpServers: {
    aidlc: {
      command: 'node',
      args: [mcpEntry],
      env: {
        V2_EXECUTION_ID: scope.executionId,
        V2_INTENT_ID: scope.intentId,
        V2_PROJECT_ID: scope.projectId ?? '',
        V2_STAGE_INSTANCE_ID: scope.stageInstanceId ?? '',
        V2_MCP_ROLE: scope.role ?? 'author',
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

// Effectful: write the workspace files for a stage and return the paths the CLI
// runner needs. `workspaceDir` is the session-persistent checkout root.
//   - .aidlc/rules.md            steering (resolved rules)
//   - .aidlc/mcp-config.json     the --mcp-config the CLI loads
// The stage prompt itself is returned (the runner pipes it to the CLI), not
// written to disk.
export const materializeStage = async ({
  workspaceDir,
  stage,
  stageBody,
  agentPersona,
  knowledge,
  conductor = '',
  rulesDoc,
  mcpEntry,
  scope,
  env = process.env,
}) => {
  const aidlcDir = path.join(workspaceDir, '.aidlc');
  await mkdir(aidlcDir, { recursive: true });

  if (rulesDoc) await writeFile(path.join(aidlcDir, 'rules.md'), rulesDoc, 'utf8');

  const mcpConfig = buildMcpConfig({ mcpEntry, scope, env });
  const mcpConfigPath = path.join(aidlcDir, 'mcp-config.json');
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

  const prompt = buildStagePrompt({ stage, stageBody, agentPersona, knowledge, conductor });
  return { prompt, mcpConfigPath, rulesPath: rulesDoc ? path.join(aidlcDir, 'rules.md') : null };
};
