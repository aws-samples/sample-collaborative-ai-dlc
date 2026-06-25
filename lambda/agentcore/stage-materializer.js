// Stage materializer — turns a resolved plan stage + the loaded library into the
// concrete things the headless CLI needs to run ONE stage:
//   1. a stage PROMPT with a strict OUTPUT CONTRACT (business writes go ONLY
//      through the MCP tools; process notes/output through the bridge tools),
//   2. the rule + knowledge bodies written into the workspace as steering files,
//   3. an `--mcp-config` JSON pointing at our stdio MCP server with the trusted
//      scope ENV.
//
// The PROMPT ASSEMBLY is a pure function (no fs/network) so it is unit-tested in
// isolation; the workspace write is the thin effectful shell.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// The strict output contract appended to every stage prompt. Load-bearing: it
// keeps the stage machine intact — an agent that only prints markdown produces
// nothing the graph or the audit trail can see.
export const OUTPUT_CONTRACT = [
  '## Output contract (MANDATORY)',
  '',
  '- Record EVERY business artifact you produce by CALLING `create_artifact`',
  '  (artifactType = the expected output name, e.g. "requirements-analysis"),',
  '  and wire relationships with `link_artifacts`. Output not written through a',
  '  tool is DISCARDED — the stage will have produced nothing.',
  '- Read upstream inputs with `get_artifact` / `lookup_artifacts` and orient with',
  '  `get_intent_graph` / `search_graph` before you start.',
  '- Stream human-facing progress and your final summary with `send_output`.',
  '- If you need a human decision before continuing, call `ask_question` and wait',
  '  for the answer — do not guess on ambiguous requirements.',
  '- Report token/context usage with `collect_metric` when you finish.',
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
}) => {
  const sections = [
    `# Stage: ${stage.stageId ?? 'unknown'} (phase: ${stage.phase ?? 'unphased'})`,
    '',
    `You are the **${stage.agentRef ?? 'assigned'}** agent executing ONE stage of an`,
    'AI-DLC v2 workflow. Follow the stage instructions exactly.',
  ];
  if (agentPersona) sections.push('', '## Your role', agentPersona);
  sections.push('', '## Stage instructions', stageBody || '(no stage body supplied)');
  sections.push('', '## Inputs (read via the MCP tools)', renderInputs(stage.inputArtifacts));
  sections.push(
    '',
    '## Expected outputs (record each via create_artifact)',
    renderOutputs(stage.outputArtifacts),
  );
  if (knowledge) sections.push('', '## Reference knowledge', knowledge);
  if (stage.humanValidation === 'required') {
    sections.push(
      '',
      '## Human validation',
      'This stage requires human approval of its output before the workflow proceeds.',
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

  const prompt = buildStagePrompt({ stage, stageBody, agentPersona, knowledge });
  return { prompt, mcpConfigPath, rulesPath: rulesDoc ? path.join(aidlcDir, 'rules.md') : null };
};
