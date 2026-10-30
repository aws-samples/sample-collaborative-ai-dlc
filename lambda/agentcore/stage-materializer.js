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

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { attachmentPromptManifest } from './attachments.js';
import { fileURLToPath } from 'node:url';
import { renderStructureContracts } from '../shared/artifact-structure-contract.js';
import { MCP_SERVER_NAME } from './cli/drivers.js';
import { APPLICATION_CREDENTIAL_ENV, INFERENCE_CREDENTIAL_ENV } from './cli/environment.js';
import { CREDENTIAL_ADAPTER_ENV_NAMES } from './credential-material-registry.js';
import { currentCredentialSession } from './credential-session.js';
import { createRuntimeMcpBridge } from './mcp/runtime-bridge.js';
import { DEFAULT_CODEX_HOME_ROOT } from './cli/codex-store.js';

// The capability-registry handler ids (aidlc-capabilities.js RUNTIME_HANDLERS)
// this module implements. Checked against the registry by a test, so a
// capability cannot be declared handled without the code that handles it.
export const IMPLEMENTED_RUNTIME_HANDLERS = Object.freeze([
  'agent.max-turns@v1',
  'policy.project-type.default@v1',
  'prompt.learnings@v1',
]);

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

// `learnings: off` withdraws the two learning writers from the MCP session, so
// the annex row that tells the agent to call them is swapped for one that says
// learnings are off. Every other policy (and no policy) keeps the annex verbatim.
const LEARNINGS_ANNEX_ROW = /^\| The learnings ritual .*\|$/m;
const annexFor = (policy) =>
  policy?.learnings === 'off'
    ? MCP_EXECUTION_ANNEX.replace(
        LEARNINGS_ANNEX_ROW,
        '| The learnings ritual / "capture a learning" / a reusable convention, decision, constraint, or gotcha that should steer FUTURE intents in this project | **IGNORE.** Learnings are turned off for this scope: there is no tool to record them. Put anything worth keeping in your stage output instead. |',
      )
    : MCP_EXECUTION_ANNEX;

// The {{INVOKE}} dialect annex — appended ONLY when a prompt part actually
// carries the token (releases ≥2.8.2 expand it to the upstream engine CLI, which
// does not exist here). A prompt with no token is byte-identical to before.
const invokeAnnexPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'prompts',
  'invoke-dialect-annex.md',
);
export const INVOKE_DIALECT_ANNEX = readFileSync(invokeAnnexPath, 'utf8').trimEnd();

// Every answer in the annex names an AUTHOR tool as the channel that replaces
// the engine command — `emit_stage_note` for a recommendation, `send_output` for
// the closing summary. A read-only persona session (the reviewer's MCP role,
// which may only `submit_review`) has neither, so handing it the annex verbatim
// would instruct it to call a tool it was never registered for. The rows stay
// VERBATIM — a release's annexed command is answered by the same text in every
// session, which is what makes the guard's annex claim checkable — and this
// preamble redirects only the recording channel to the one that role has.
const READ_ONLY_RECORDING_PREAMBLE = [
  '> **You are a read-only session.** Every answer below that says to record',
  '> something with `emit_stage_note`, or to end with a `send_output` summary,',
  '> names a tool you do not have. Put that content in your `submit_review`',
  '> findings instead, naming the command and what could not be performed. Every',
  '> refusal below — never run the engine, never claim you ran it, never invent a',
  '> value it would have produced — applies to you unchanged.',
].join('\n');

// `engine log answer` / `engine log decision` are mapped onto an ordinary
// question and a summary confirmation, and BOTH of those tools are conditional:
// `confirm_summary` exists only where the resolved policy asks for a summary
// confirmation, and neither exists in a session that does not own the stage's
// checkpoint (a dispatched support with no answer path, a reviewer). Advertising
// them unconditionally is the same policy/annex mismatch already fixed for
// `learnings: off` in the MCP annex: it tells a session to call a tool that was
// deliberately never registered for it.
//
// The refusals in the row are untouched — the protected checkpoints stay
// unavailable in every session — and only the substitute changes, so a release's
// answer is still the same answer everywhere it is deliverable.
const CHECKPOINT_ANNEX_ROW = /^- `engine log answer …` \/ `engine log decision …`: .*$/m;
// Whether the bodies in THIS prompt actually invoke the two commands the row
// maps. A release that never invokes them reads the row as inert prose, so
// leaving it verbatim is what keeps the prompt of every release before these
// commands existed byte-for-byte unchanged.
const CHECKPOINT_LOG_INVOKE = /\{\{INVOKE\}\}\s+engine\s+log\s+(answer|decision)\b/;
export const invokesCheckpointLog = (...parts) =>
  parts.some((part) => typeof part === 'string' && CHECKPOINT_LOG_INVOKE.test(part));
// A session with NO platform tools at all. The composer's one-shot invocation
// supplies no MCP configuration, so every answer that names a tool names one it
// cannot call: its only channel is the JSON proposal it returns, and it raises
// no checkpoint and changes no state. Carrying the annex is not the same as
// being able to perform it.
const TOOLLESS_RECORDING_PREAMBLE = [
  '> **You have no platform tools in this session.** Every answer below that',
  '> says to record something with a note tool, to ask or confirm with a',
  '> checkpoint tool, to request an approval, or to end with an output summary',
  '> names a tool you cannot call. Your only channel is the JSON proposal you',
  '> return: put that content in its `rationale`, naming the command and what',
  '> could not be performed. You raise no checkpoint and you change no state.',
  '> Every refusal below — never run the engine, never claim you ran it, never',
  '> invent a value it would have produced — applies to you unchanged.',
].join('\n');

// Every answer in the annex whose channel is a platform tool, rewritten for a
// session that has none. The proposal's own fields are the channel.
const TOOLLESS_SUBSTITUTIONS = Object.freeze([
  [/`emit_stage_note`/g, 'the `rationale` of the proposal you return'],
  [/your `send_output` summary/g, 'the `rationale` of the proposal you return'],
  [/`submit_review`/g, 'the `rationale` of the proposal you return'],
  [/`request_plan_approval`/g, 'a plan-approval tool this session does not have'],
]);

const checkpointRowFor = ({ policy, checkpointOwner, canAsk, toolless = false }) => {
  const confirms =
    checkpointOwner &&
    (policy?.summaryConfirmation === 'required' || policy?.summaryConfirmation === 'if-present');
  const asks = checkpointOwner && canAsk;
  if (asks && confirms) return null;
  const substitute = toolless
    ? '**You cannot raise either checkpoint in this session**: it registers no tools at all. Put the question or decision you would have put to the human in the `rationale` of the proposal you return, and say plainly that a person must take it on the intent.'
    : asks
      ? "Ask with `ask_question`, which records the human's exact words. There is **no summary confirmation** in this run: no `confirm_summary` tool exists for this session, so do not instruct one — put what you would have confirmed in your output."
      : "**You cannot raise either checkpoint in this session**: the stage's own session owns them, and neither `ask_question` nor `confirm_summary` is registered here. Say that the checkpoint cannot be raised from this session, record the question or decision you would have put to the human, and defer to the owning session.";
  return `- \`engine log answer …\` / \`engine log decision …\`: **An ordinary question and a summary confirmation only.** ${substitute} The protected checkpoints are **unavailable**: this runtime mints no plan-approval fingerprint or receipt and holds no approved verification command. For those, say the checkpoint cannot be recorded here, record what you would have asked, and never invent a receipt, an answer id or an approval.`;
};

// The dialect annex for ONE prompt, in the form the session receiving it can
// actually perform. `readOnly` is the caller's MCP role, not a release property:
// the answers are the same, the channel that carries them is not. `policy`,
// `checkpointOwner` and `canAsk` are the same three facts `toolsForRole` reads,
// so the prompt and the tool surface cannot disagree.
export const invokeDialectAnnex = ({
  readOnly = false,
  // A session that registers no platform tools at all (the composer). Its
  // answers are rewritten onto the proposal it returns, because a channel it
  // cannot open is not an answer.
  toolless = false,
  policy = null,
  checkpointOwner = !readOnly && !toolless,
  canAsk = !readOnly && !toolless,
  // Only a prompt whose own bodies invoke `engine log answer` / `log decision`
  // has its mapping adapted; every other prompt keeps the annex verbatim.
  checkpointLogInvoked = false,
} = {}) => {
  const row = checkpointLogInvoked
    ? checkpointRowFor({ policy, checkpointOwner, canAsk, toolless })
    : null;
  let annex = row ? INVOKE_DIALECT_ANNEX.replace(CHECKPOINT_ANNEX_ROW, row) : INVOKE_DIALECT_ANNEX;
  if (toolless) {
    for (const [pattern, replacement] of TOOLLESS_SUBSTITUTIONS) {
      annex = annex.replace(pattern, replacement);
    }
    return `${TOOLLESS_RECORDING_PREAMBLE}\n\n${annex}`;
  }
  return readOnly ? `${READ_ONLY_RECORDING_PREAMBLE}\n\n${annex}` : annex;
};

// Upstream bodies carry a literal `{{HARNESS_DIR}}` token (substituted only at
// upstream's own dist build, which we bypass by fetching core/ raw). We neutralize
// it at the PROMPT layer — the seeded block body stays verbatim — so the agent
// never sees a raw templating artifact. The annex tells it to ignore the location.
const HARNESS_DIR_TOKEN = /\{\{HARNESS_DIR\}\}/g;
export const neutralizeHarnessDir = (text = '') =>
  text.replace(HARNESS_DIR_TOKEN, '<runtime-managed>');

// Releases ≥2.8.2 write `{{INVOKE}} engine …` in stage bodies, where {{INVOKE}}
// expands to the upstream engine CLI at their dist build. We never build their
// dist, and no engine binary exists in this runtime, so the token is neutralized
// at the PROMPT layer exactly like {{HARNESS_DIR}} (the seeded body stays
// verbatim) and the dialect annex maps each command family to its platform
// equivalent.
const INVOKE_TOKEN = /\{\{INVOKE\}\}/g;
export const neutralizeInvoke = (text = '') =>
  text.replace(INVOKE_TOKEN, '<runtime-managed-engine>');
export const hasInvokeToken = (...parts) =>
  parts.some((part) => typeof part === 'string' && part.includes('{{INVOKE}}'));
export const neutralizeTokens = (text = '') => neutralizeInvoke(neutralizeHarnessDir(text));

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

// The classification stage has two shapes, and which one it gets is the whole
// point of the project-type setting. With no decided type the agent scans and
// classifies. With one — a scope default or a member's explicit choice for this
// intent, true OR false — the decision WINS: the stage records the decided value
// instead of scanning, because a scan that contradicted it would silently
// overrule the decision and upstream's own mid-run reclassification transaction
// is refused by name in the annex.
const renderWorkspaceDetectionContract = (stageId, policy = null) => {
  if (stageId !== 'workspace-detection') return '';
  const decided = policy?.existingCode;
  if (decided != null) {
    const type = decided === true ? 'brownfield' : 'greenfield';
    const origin =
      policy.existingCodeChoice?.source === 'intent'
        ? 'chosen for this intent by a project member'
        : "the AI-DLC scope's own setting";
    return [
      '## Workspace classification contract',
      '',
      `The project type for this run is already decided: **${type}** (${origin}).`,
      `Call \`record_project_type\` exactly once with \`${type}\`. Do NOT re-classify`,
      'the workspace against that decision; if what you find disagrees, say so in',
      'your summary and let a human rewind rather than overruling the choice.',
      'Do this before `send_output`; the structured value is required by later',
      'workflow stages and native workspace exports.',
    ].join('\n');
  }
  return [
    '## Workspace classification contract',
    '',
    'After scanning the workspace and deciding its project type, call',
    '`record_project_type` exactly once with `greenfield` or `brownfield`.',
    'Do this before `send_output`; the structured value is required by later',
    'workflow stages and native workspace exports.',
  ].join('\n');
};

// The engine commits this stage's work with the agent's Conventional Commits
// description, which release tooling reads for the version and changelog.
const CHANGE_DESCRIPTION_CONTRACT = [
  '## Commit description contract',
  '',
  'The engine commits your work when you finish, and repositories release from those',
  'commit messages. Before `send_output`, call `describe_changes` once with the',
  'Conventional Commits type that matches what you changed in the repository: `feat`',
  'for new behaviour, `fix` for a bug fix, `docs` when you only wrote documentation or',
  'AI-DLC artifacts, and so on. Mark it breaking only when existing users must change',
  'something, and say what breaks and how to migrate. Leave issue keys out of the',
  "summary: the engine adds the intent's own. If you change nothing, skip it.",
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

// Render the resolved per-scope execution policy. PURE,
// and '' unless the plan actually resolved a policy — so a legacy plan's prompt
// is unchanged. Only the rituals the AGENT can honour are stated; the platform
// enforces the rest (sensor selection, reviewer class) before the prompt exists.
export const renderScopePolicy = (policy) => {
  if (!policy) return '';
  const lines = [];
  if (policy.summaryConfirmation === 'required') {
    lines.push(
      '- **Summary confirmation is REQUIRED.** Before you record ANY stage output,',
      '  call `confirm_summary` with your understanding of the task and every',
      '  decision you are about to commit, and wait for "Looks correct". The normal',
      '  platform completion path checks for its receipt; this is a workflow check,',
      '  not a boundary against direct writes made with the container credentials.',
      '  On "Request',
      '  changes", revise and call it again.',
    );
  } else if (policy.summaryConfirmation === 'if-present') {
    lines.push(
      '- **Summary confirmation if-present.** If a consolidated understanding',
      '  question is genuinely needed to avoid guessing, call `confirm_summary`',
      '  once before producing outputs; otherwise proceed.',
    );
  }
  if (policy.planApproval === 'required') {
    lines.push(
      '- **Plan approval is REQUIRED.** Before you write any code, call',
      '  `request_plan_approval` with your implementation plan and how to test it,',
      '  and wait for "Approve plan". The normal platform completion path checks for',
      '  its receipt; this is a workflow check, not a boundary against direct writes',
      '  made with the container credentials.',
    );
  }
  // `learnings: off` states nothing here on purpose: the MCP server does not
  // register `record_team_knowledge` / `record_learning_rule` at all for that
  // scope, so a prompt bullet asking the agent not to call them would describe
  // tools it cannot see.
  if (policy.changeControl === 'relaxed') {
    lines.push(
      '- **Change control is RELAXED.** If an already-approved input changed,',
      '  continue with the new content and state the acceptance explicitly in your',
      '  summary (`CHANGE_ACCEPTED: <what changed>`) instead of stopping.',
    );
  } else if (policy.changeControl === 'strict') {
    lines.push(
      '- **Change control is STRICT.** If an already-approved input appears to',
      '  have changed, do NOT silently build on it: say so in your summary so the',
      '  human can reopen the affected checkpoint.',
    );
  }
  // `true` and `false` are both decisions; only absence says nothing. An
  // explicit Greenfield choice has to reach the agent, or a member's answer to
  // "is there existing code?" would change no prompt at all.
  if (policy.existingCode === true) {
    lines.push(
      '- **Project type: BROWNFIELD.** This run works on an existing codebase:',
      '  read what is already there before proposing anything new, and keep the',
      '  conventions you find.',
    );
  } else if (policy.existingCode === false) {
    lines.push(
      '- **Project type: GREENFIELD.** This run starts from nothing: there is no',
      '  existing codebase to respect, so do not look for prior conventions to',
      '  follow and do not report their absence as a problem.',
    );
  }
  if (policy.skeleton === 'on') {
    lines.push(
      '- **Walking skeleton is ON.** For the first construction work, deliver the',
      '  thinnest end-to-end slice that actually runs before broadening scope.',
    );
  } else if (policy.skeleton === 'off') {
    lines.push('- **Walking skeleton is OFF.** Do not add a skeleton-only ceremony pass.');
  }
  if (policy.reviewClass === 'advisory') {
    lines.push(
      '- **Review is ADVISORY.** An independent reviewer inspects your output once',
      '  after you finish; there is no repair round, so do not hold work back for',
      '  it.',
    );
  } else if (policy.reviewClass === 'none') {
    lines.push('- **No independent reviewer runs for this scope.**');
  }
  if (lines.length === 0) return '';
  return ['## Scope policy (authoritative for these rituals)', '', ...lines].join('\n');
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
  attachments = [],
  // The engine writes Conventional Commits and this session has describe_changes.
  describeChanges = false,
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
  sections.push('', annexFor(stage.policy));
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
  if (conductor) sections.push('', '## Execution quality (conductor)', neutralizeTokens(conductor));
  if (agentPersona) sections.push('', '## Your role', neutralizeTokens(agentPersona));
  if (compiledContext) sections.push('', neutralizeTokens(compiledContext));
  const attachmentManifest = attachmentPromptManifest(attachments);
  if (attachmentManifest) sections.push('', attachmentManifest);
  // Unit lane: the fan-out scoping must precede the stage prose (which is
  // worded once-per-workflow) so the agent reads its lane boundary first.
  const unitScope = renderUnitScope(unit);
  if (unitScope) sections.push('', unitScope);
  const workspaceDetectionContract = renderWorkspaceDetectionContract(stage.stageId, stage.policy);
  if (workspaceDetectionContract) sections.push('', workspaceDetectionContract);
  if (describeChanges) sections.push('', CHANGE_DESCRIPTION_CONTRACT);
  const scopePolicy = renderScopePolicy(stage.policy);
  if (scopePolicy) sections.push('', scopePolicy);
  sections.push(
    '',
    '## Stage instructions',
    neutralizeTokens(stageBody) || '(no stage body supplied)',
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
  if (knowledge) sections.push('', '## Reference knowledge', neutralizeTokens(knowledge));
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
  // The dialect annex is gated on the parts a release authors to INSTRUCT the
  // agent: the stage body, the conductor doctrine, the persona and the reference
  // knowledge. `shared/annex-reach.js` keeps that set and the promotion guard's
  // one definition, so the guard never counts a command answered in a session
  // this prompt leaves without the answer. The compiled context is runtime data
  // the platform assembles, not authored release content, so it is neutralized
  // above but never gated on.
  if (hasInvokeToken(stageBody, conductor, agentPersona, knowledge)) {
    // The stage's own session: it owns the checkpoints and can ask, so only the
    // resolved policy decides whether a summary confirmation exists.
    sections.push(
      '',
      invokeDialectAnnex({
        policy: stage.policy,
        checkpointLogInvoked: invokesCheckpointLog(stageBody, conductor, agentPersona, knowledge),
      }),
    );
  }
  return sections.join('\n');
};

// Claude, Kiro, and OpenCode merge a custom stdio server's explicit env over the
// CLI process env. The CLI needs the invocation-scoped model credential, but a
// project-configured child must never inherit it. Put an explicit empty value in
// every custom local server and spread it LAST so even a malicious/buggy config
// cannot restore the selected user's token. Provider-controlled names are
// blanked too: credential adapters may write only these names. Custom MCP
// `${VAR}` refs use their own non-reserved names and remain intact.
export const CUSTOM_MCP_AUTH_ENV_SCRUB = Object.freeze({
  ...Object.fromEntries(
    [
      ...APPLICATION_CREDENTIAL_ENV,
      ...INFERENCE_CREDENTIAL_ENV,
      ...CREDENTIAL_ADAPTER_ENV_NAMES,
    ].map((name) => [name, '']),
  ),
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  BOTO_CONFIG: '/dev/null',
});

const scrubCustomMcpAuth = (customServers = {}) =>
  Object.fromEntries(
    Object.entries(customServers ?? {}).map(([name, server]) => {
      if (!server?.command) return [name, server];
      return [
        name,
        {
          ...server,
          env: {
            ...server.env,
            ...CUSTOM_MCP_AUTH_ENV_SCRUB,
          },
        },
      ];
    }),
  );

// Build the --mcp-config JSON the CLI loads. Points at our stdio MCP server and
// passes the TRUSTED scope as the child's ENV (the agent can't override it). The
// command/args are server-controlled. `customServers` (a name→spec map, already
// validated + reserved-name-filtered upstream) are scrubbed and spread FIRST so
// the reserved `aidlc` entry, written last, always wins a name collision — a
// custom entry can never override the runtime bridge.
export const buildMcpConfig = ({ mcpEntry, scope, env = {}, customServers = {} }) => ({
  mcpServers: {
    ...scrubCustomMcpAuth(customServers),
    aidlc: env.AIDLC_MCP_SOCKET
      ? {
          command: process.execPath,
          args: [new URL('./mcp/stdio-relay.js', import.meta.url).pathname, env.AIDLC_MCP_SOCKET],
          env: CUSTOM_MCP_AUTH_ENV_SCRUB,
        }
      : {
          command: 'node',
          args: [mcpEntry],
          env: {
            V2_EXECUTION_ID: scope.executionId,
            V2_INTENT_ID: scope.intentId,
            V2_PROJECT_ID: scope.projectId ?? '',
            V2_STAGE_ID: scope.stageId ?? '',
            V2_STAGE_INSTANCE_ID: scope.stageInstanceId ?? '',
            V2_ORCHESTRATOR_RUN_ID: scope.orchestratorRunId ?? '',
            V2_STAGE_CALLBACK_ID: scope.stageCallbackId ?? '',
            V2_SECTION_INDEX:
              scope.sectionIndex === undefined || scope.sectionIndex === null
                ? ''
                : String(scope.sectionIndex),
            V2_STAGE_ATTEMPT:
              scope.stageAttempt === undefined || scope.stageAttempt === null
                ? '0'
                : String(scope.stageAttempt),
            // Unit lane attribution (docs/v2-parallel.md WP4): the bridge stamps
            // this on every gate/output/metric/event row it writes. Empty → null.
            V2_UNIT_SLUG: scope.unitSlug ?? '',
            V2_RESOLVED_MODEL: scope.model ?? '',
            V2_MCP_ROLE: scope.role ?? '',
            V2_MCP_MODE: scope.mode ?? 'stage',
            // The resolved release policy, so the MCP server registers the checkpoint
            // tools the policy requires and withholds the ones it turns off. Written
            // ONLY when the plan resolved a policy, so an unpinned or 2.3.3-era run
            // produces a byte-identical config.
            ...(scope.policy ? { V2_STAGE_POLICY: JSON.stringify(scope.policy) } : {}),
            // Written ONLY for a session that is NOT the checkpoint owner (a dispatched
            // persona under a resolved policy), so the MCP server withholds the
            // checkpoint tools there. Absent everywhere else, which keeps the lead's and
            // every unpinned run's config byte-identical.
            ...(scope.policy && scope.checkpointOwner === false
              ? { V2_CHECKPOINT_OWNER: '0' }
              : {}),
            // Written ONLY for a dispatched persona session: nothing threads an answer
            // back into one, so the MCP server withholds ask_question there. Absent
            // everywhere else — independent of the policy, because the absence of an
            // answer path does not depend on what the release enables.
            ...(scope.canAsk === false ? { V2_ASK_QUESTION: '0' } : {}),
            // Written ONLY when the engine writes Conventional Commits, for the session
            // that owns the stage, so it gets describe_changes. Absent everywhere else.
            ...(scope.describeChanges === true && scope.checkpointOwner !== false
              ? { V2_DESCRIBE_CHANGES: '1' }
              : {}),
            // The validation revision the checkpoint receipts are scoped to. Absent
            // for the first run and for every run without a policy.
            ...(scope.policy && scope.validationRound
              ? { V2_VALIDATION_ROUND: String(scope.validationRound) }
              : {}),
            // Trusted reviewer identity (reviewer role only): the bridge stamps this
            // on the verdict row instead of trusting the agent's self-reported name
            // (upstream §12a identity marker, enforced server-side). Empty → null.
            V2_REVIEWER_AGENT: scope.reviewerAgent ?? '',
            // Trusted author identity (dispatched persona sessions, and the lead under
            // a resolved policy): graph-writer pins a `contribution`'s collaborator
            // to it. Absent on an unpinned/2.3.3 run, whose config must stay
            // byte-identical.
            ...(scope.agentRef ? { V2_AGENT_REF: scope.agentRef } : {}),
            V2_PROCESS_TABLE: env.V2_PROCESS_TABLE ?? '',
            // Local E2E only. Production leaves this empty and uses the normal AWS
            // endpoint; the MCP child does not reliably inherit arbitrary CLI env.
            DYNAMODB_LOCAL_ENDPOINT: env.DYNAMODB_LOCAL_ENDPOINT ?? '',
            NEPTUNE_ENDPOINT: env.NEPTUNE_ENDPOINT ?? '',
            GREMLIN_PROTOCOL: env.GREMLIN_PROTOCOL ?? 'wss',
            GREMLIN_PORT: env.GREMLIN_PORT ?? '8182',
            CONNECTIONS_TABLE: env.CONNECTIONS_TABLE ?? '',
            WEBSOCKET_ENDPOINT: env.WEBSOCKET_ENDPOINT ?? '',
            AWS_REGION: env.AWS_REGION ?? '',
            ARTIFACTS_BUCKET: env.ARTIFACTS_BUCKET ?? '',
            V2_QUESTION_POLL_MS: env.V2_QUESTION_POLL_MS ?? '',
            V2_QUESTION_PARK_GRACE_MS: env.V2_QUESTION_PARK_GRACE_MS ?? '',
          },
        },
  },
});

const prepareMcpEnvironment = async ({ mcpEntry, scope, env }) => {
  const session = currentCredentialSession();
  if (!session) return env; // Pure/local harness callers own their process lifetime.
  const trustedEnv = buildMcpConfig({ mcpEntry, scope, env }).mcpServers.aidlc.env;
  const bridge = await createRuntimeMcpBridge({ entry: mcpEntry, trustedEnv });
  try {
    session.own(() => bridge.dispose());
  } catch (error) {
    await bridge.dispose();
    throw error;
  }
  return { ...env, AIDLC_MCP_SOCKET: bridge.socketPath, AIDLC_MCP_CONTEXT_ID: randomUUID() };
};

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
  env = await prepareMcpEnvironment({ mcpEntry, scope, env });
  const mcpConfig = buildMcpConfig({ mcpEntry, scope, env, customServers });
  const mcpConfigPath = path.join(
    aidlcDir,
    env.AIDLC_MCP_CONTEXT_ID ? `mcp-${env.AIDLC_MCP_CONTEXT_ID}.json` : 'mcp-config.json',
  );
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  currentCredentialSession()?.own(() => rm(mcpConfigPath, { force: true }));
  return mcpConfigPath;
};

// The Kiro agent-config name we register our MCP server under. Kiro (unlike
// Claude) has NO `--mcp-config` flag — it discovers MCP servers from an AGENT
// config at <cwd>/.kiro/agents/<name>.json and is told to use it via `--agent`.
export const KIRO_AGENT_NAME = 'aidlc';

// Build the Kiro agent config that wires our stdio MCP server. Reuses the exact
// server spec buildMcpConfig produces (command/args/scope-env) — just wrapped in
// Kiro's agent envelope. `tools:["*"]` exposes the MCP tools (we also pass
// --trust-all-tools so none prompt for approval). No `allowedTools`: it only
// duplicates --trust-all-tools, and Kiro's v3 engine ignores agent JSON that
// carries that CLI-only field. `resources` points Kiro at the
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
  env = await prepareMcpEnvironment({ mcpEntry, scope, env });
  const config = buildKiroAgentConfig({ mcpEntry, scope, env, customServers });
  const agentName = env.AIDLC_MCP_CONTEXT_ID
    ? `${KIRO_AGENT_NAME}-${env.AIDLC_MCP_CONTEXT_ID}`
    : KIRO_AGENT_NAME;
  config.name = agentName;
  const configPath = path.join(agentsDir, `${agentName}.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  currentCredentialSession()?.own(() => rm(configPath, { force: true }));
  return agentName;
};

const openCodeEnvRef = (value) =>
  typeof value === 'string' ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{env:$1}') : value;

const openCodeStringMap = (value = {}) =>
  Object.fromEntries(Object.entries(value).map(([key, item]) => [key, openCodeEnvRef(item)]));

// Convert the validated common MCP shape to OpenCode's native config:
// local servers use one command argv array; HTTP and SSE both use the remote
// transport. OpenCode's env interpolation is `{env:VAR}`, so `${VAR}` refs are
// translated without exposing their resolved values.
export const toOpenCodeMcp = (mcpServers = {}) => {
  const out = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!server || typeof server !== 'object') continue;
    if (server.command) {
      out[name] = {
        type: 'local',
        command: [server.command, ...(server.args ?? [])],
        ...(server.env ? { environment: openCodeStringMap(server.env) } : {}),
      };
    } else if (server.url) {
      out[name] = {
        type: 'remote',
        url: server.url,
        ...(server.headers ? { headers: openCodeStringMap(server.headers) } : {}),
      };
    }
  }
  return out;
};

export const OPENCODE_INSTRUCTIONS = ['.aidlc/rules.md', '.aidlc/opencode-instructions/*.md'];

// AGENT.maxTurns (≥2.6.18) is upstream's hard turn cap on the two reviewer
// agents. OpenCode's native equivalent is the agent-level `steps` limit
// (`agent.<name>.steps`, a positive integer: the max agentic iterations before
// the model is forced to a text-only answer). `opencode run` drives the `build`
// agent, so that is where the cap lands. Omitted unless the block declares it,
// so a legacy config is byte-identical. Claude honours its own native cap; Kiro
// exposes no equivalent and is inert by design (see the compatibility matrix).
export const OPENCODE_DEFAULT_AGENT = 'build';
const openCodeTurnLimit = (maxTurns) =>
  Number.isInteger(maxTurns) && maxTurns > 0
    ? { agent: { [OPENCODE_DEFAULT_AGENT]: { steps: maxTurns } } }
    : {};

export const buildOpenCodeConfig = ({
  mcpEntry,
  scope,
  env = {},
  customServers = {},
  instructions = OPENCODE_INSTRUCTIONS,
  maxTurns = null,
}) => {
  // buildMcpConfig writes the reserved server last. Preserve that insertion
  // order through conversion so repository/user config cannot replace `aidlc`
  // when this inline config is merged after project configuration.
  const common = buildMcpConfig({ mcpEntry, scope, env, customServers }).mcpServers;
  const { aidlc, ...others } = toOpenCodeMcp(common);
  return {
    $schema: 'https://opencode.ai/config.json',
    share: 'disabled',
    instructions,
    ...openCodeTurnLimit(maxTurns),
    mcp: { ...others, aidlc },
  };
};

// OpenCode reads inline config after repository configuration. Returning the
// JSON through OPENCODE_CONFIG_CONTENT leaves AGENTS.md and .opencode untouched
// while retaining non-conflicting repository settings.
export const materializeOpenCodeConfig = async ({
  mcpEntry,
  scope,
  env = process.env,
  customServers = {},
  maxTurns = null,
}) => {
  env = await prepareMcpEnvironment({ mcpEntry, scope, env });
  return JSON.stringify(buildOpenCodeConfig({ mcpEntry, scope, env, customServers, maxTurns }));
};

// ── Codex config (per-stage CODEX_HOME) ──
//
// Codex reads all behavioral config from $CODEX_HOME/config.toml. Every
// invocation gets a PRIVATE home on ephemeral local disk so its continuously
// appended rollout JSONL never touches AgentCore's managed-session mount. The
// stage runner copies only the selected rollout to/from durable storage around
// resumable author runs (cli/codex-store.js). Config, global guidance, reviewer
// sessions, and SQLite state always remain local.

// TOML value emitters — config values here are flat strings/arrays/maps, so a
// tiny local emitter beats a dependency. Strings are emitted as TOML basic
// strings via JSON.stringify (valid TOML for our value space: no control-char
// escapes beyond \n\t\", which JSON and TOML share).
const tomlString = (value) => JSON.stringify(String(value));
const tomlArray = (values) => `[${values.map(tomlString).join(', ')}]`;

// Resolve `${VAR}` references against the provided lookup (container env merged
// with the resolved MCP secret env). Used only for the LITERAL-fallback cases
// below — values codex cannot forward by name.
const codexEnvValue = (value, refEnv) =>
  typeof value === 'string'
    ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => refEnv[name] ?? '')
    : String(value);

// A value that is EXACTLY one `${VAR}` token (nothing around it) — forwardable
// by name; an embedded ref like `Bearer ${VAR}` is not.
const FULL_REF_TOKEN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

// Codex spawns MCP stdio servers with a SANITIZED environment (verified live:
// the aidlc bridge got "Could not load credentials from any providers" while
// the other CLIs' children inherit the container env). Codex's `env_vars` key
// is a NAME whitelist — listed vars are forwarded from the codex process env
// into the MCP child, so no value is ever written to config.toml. The standard
// AWS credential-chain vars are forwarded to the RESERVED aidlc server ONLY so
// its SDK clients resolve credentials — static keys (local e2e's inert pair),
// container-credentials URIs (the AgentCore runtime role), or web identity.
// Absent names are skipped by codex at spawn time. Custom servers NEVER get
// this list (a user-configured server must not silently inherit runtime
// credentials).
const CODEX_AIDLC_FORWARD_ENV = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_DEFAULT_REGION',
];

// Convert the validated common MCP shape to codex [mcp_servers.*] TOML tables.
// `aidlc` is emitted LAST (buildMcpConfig's insertion order preserved) and is
// marked required — if the runtime bridge fails to initialize, codex exits with
// an error instead of running the stage toolless.
//
// Secret handling: run-stage injects the resolved `${VAR}` values into the codex
// CHILD env (mcpSecretEnv), so wherever codex can forward an env var / header BY
// NAME, we do that and the secret never lands in this file:
//   - stdio env value that IS `${VAR}` with key === VAR  → `env_vars` whitelist
//   - remote header value that IS `${VAR}`               → `env_http_headers`
// Only the remaining shapes (embedded refs like `Bearer ${VAR}`, or a ref
// renamed to a different key) fall back to a literal resolved against `refEnv`
// — which MUST include the resolved secret env, or they resolve empty.
export const toCodexMcpToml = (mcpServers = {}, refEnv = {}) => {
  const sections = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!server || typeof server !== 'object') continue;
    const lines = [`[mcp_servers.${JSON.stringify(name)}]`];
    if (server.command) {
      lines.push(`command = ${tomlString(server.command)}`);
      if (Array.isArray(server.args) && server.args.length) {
        lines.push(`args = ${tomlArray(server.args)}`);
      }
      const forwarded = [];
      const literal = [];
      for (const [key, value] of Object.entries(server.env ?? {})) {
        const full = typeof value === 'string' ? value.match(FULL_REF_TOKEN) : null;
        if (full && full[1] === key) forwarded.push(key);
        else literal.push([key, codexEnvValue(value, refEnv)]);
      }
      if (
        name === MCP_SERVER_NAME &&
        !server.args?.some((arg) => String(arg).endsWith('stdio-relay.js'))
      )
        forwarded.push(...CODEX_AIDLC_FORWARD_ENV);
      // TOML: plain keys (env_vars) must precede any nested table ([….env]).
      if (forwarded.length) lines.push(`env_vars = ${tomlArray(forwarded)}`);
      if (literal.length) {
        lines.push(`[mcp_servers.${JSON.stringify(name)}.env]`);
        for (const [key, value] of literal) {
          lines.push(`${JSON.stringify(key)} = ${tomlString(value)}`);
        }
      }
    } else if (server.url) {
      lines.push(`url = ${tomlString(server.url)}`);
      const literalHeaders = [];
      const envHeaders = [];
      for (const [key, value] of Object.entries(server.headers ?? {})) {
        const full = typeof value === 'string' ? value.match(FULL_REF_TOKEN) : null;
        if (full) envHeaders.push([key, full[1]]);
        else literalHeaders.push([key, codexEnvValue(value, refEnv)]);
      }
      if (literalHeaders.length) {
        lines.push(`[mcp_servers.${JSON.stringify(name)}.http_headers]`);
        for (const [key, value] of literalHeaders) {
          lines.push(`${JSON.stringify(key)} = ${tomlString(value)}`);
        }
      }
      if (envHeaders.length) {
        // Values are ENV VAR NAMES — codex reads each header's value from its
        // own process env at request time (never written here).
        lines.push(`[mcp_servers.${JSON.stringify(name)}.env_http_headers]`);
        for (const [key, varName] of envHeaders) {
          lines.push(`${JSON.stringify(key)} = ${tomlString(varName)}`);
        }
      }
    } else {
      continue;
    }
    if (name === MCP_SERVER_NAME) {
      // Required + generous timeouts: the bridge polls durable gates, so tool
      // calls (ask_question while a human answers) legitimately run long.
      // Inserted directly after the table header — TOML keys must precede any
      // nested table ([….env]) inside the same section.
      lines.splice(1, 0, 'required = true', 'startup_timeout_sec = 30', 'tool_timeout_sec = 600');
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
};

// Ephemeral-local SQLite home for codex state (see header comment). Overridable
// for tests/local runs via env.
const codexSqliteHome = (env) => env.V2_CODEX_SQLITE_HOME || '/home/node/.codex-state';

export const buildCodexConfigToml = ({
  mcpEntry,
  scope,
  env = {},
  customServers = {},
  secretEnv = {},
}) => {
  // A custom server named `aidlc` keeps its FIRST insertion position through the
  // buildMcpConfig spread (JS re-assignment preserves key order) even though the
  // reserved VALUE wins — re-append it so the emitted table is also last.
  const { [MCP_SERVER_NAME]: aidlc, ...others } = buildMcpConfig({
    mcpEntry,
    scope,
    env,
    customServers,
  }).mcpServers;
  const mcpServers = { ...others, [MCP_SERVER_NAME]: aidlc };
  return [
    '# Materialized by the AI-DLC runtime — regenerated every stage run.',
    'model_provider = "amazon-bedrock"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    // The rendered rules doc doubles as the project doc when the repo has no
    // AGENTS.md. When it HAS one, the global $CODEX_HOME/AGENTS.md (written by
    // materializeCodexHome) still points codex at the runtime rules.
    'project_doc_fallback_filenames = [".aidlc/rules.md"]',
    `sqlite_home = ${tomlString(codexSqliteHome(env))}`,
    '',
    '[history]',
    'persistence = "save-all"',
    '',
    // Refs resolve against the RESOLVED MCP secret env only (fail-closed SSM
    // values) — never the raw container env, whose reserved keys a ref may not
    // name anyway (mcp-secret-resolver RESERVED_MCP_ENV_KEYS).
    toCodexMcpToml(mcpServers, secretEnv),
    '',
  ].join('\n');
};

// Global-guidance doc written into the codex home. Codex merges
// $CODEX_HOME/AGENTS.md ahead of the project doc, so this survives even when
// the repo ships its own AGENTS.md (which would shadow the
// project_doc_fallback_filenames entry).
const CODEX_GLOBAL_AGENTS_MD = [
  '# AI-DLC runtime guidance',
  '',
  'This session is driven by the AI-DLC stage runner. If the files exist,',
  'read and follow `.aidlc/rules.md` (methodology rules for this stage) and',
  'every markdown file under `.aidlc/codex-instructions/` (project custom',
  'rules) before acting.',
  '',
].join('\n');

// A deterministic private home keeps concurrent stages/reviewers isolated while
// allowing run-stage to resolve the destination before it restores a rollout.
export const resolveCodexHome = ({ scope = {}, env = process.env } = {}) => {
  const identity = {
    ...(currentCredentialSession() ? { invocationId: currentCredentialSession().id } : {}),
    executionId: scope.executionId ?? null,
    intentId: scope.intentId ?? null,
    projectId: scope.projectId ?? null,
    stageInstanceId: scope.stageInstanceId ?? null,
    unitSlug: scope.unitSlug ?? null,
    sectionIndex: scope.sectionIndex ?? null,
    stageAttempt: scope.stageAttempt ?? null,
    role: scope.role ?? null,
    reviewerAgent: scope.reviewerAgent ?? null,
    discussionId: scope.discussionId ?? null,
    messageId: scope.messageId ?? null,
  };
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
  return path.join(path.resolve(env.V2_CODEX_HOME_ROOT || DEFAULT_CODEX_HOME_ROOT), digest);
};

// Effectful: recreate the scoped local home and write config.toml + AGENTS.md.
// A resume passes reset=false after codex-store restored its sessions subtree.
export const materializeCodexHome = async ({
  mcpEntry,
  scope,
  env = process.env,
  customServers = {},
  secretEnv = {},
  reset = true,
}) => {
  const homeDir = resolveCodexHome({ scope, env });
  if (reset) await rm(homeDir, { recursive: true, force: true });
  await mkdir(homeDir, { recursive: true });
  env = await prepareMcpEnvironment({ mcpEntry, scope, env });
  const toml = buildCodexConfigToml({ mcpEntry, scope, env, customServers, secretEnv });
  const configPath = path.join(homeDir, 'config.toml');
  await writeFile(configPath, toml, { encoding: 'utf8', mode: 0o600 });
  currentCredentialSession()?.own(() => rm(configPath, { force: true }));
  await writeFile(path.join(homeDir, 'AGENTS.md'), CODEX_GLOBAL_AGENTS_MD, 'utf8');
  return homeDir;
};

// Materialize only the selected CLI's context and return the kwargs accepted by
// its driver. This is shared by stages, reviewers, conflict resolution, and
// one-shot surfaces so no execution writes another CLI's repository files.
export const materializeCliContext = async ({
  cli,
  workspaceDir,
  mcpEntry,
  scope,
  env = process.env,
  customServers = {},
  secretEnv = {},
  maxTurns = null,
}) => {
  if (cli === 'kiro') {
    return {
      agentName: await materializeKiroAgent({
        workspaceDir,
        mcpEntry,
        scope,
        env,
        customServers,
      }),
    };
  }
  if (cli === 'opencode') {
    return {
      opencodeConfigContent: await materializeOpenCodeConfig({
        workspaceDir,
        mcpEntry,
        scope,
        env,
        customServers,
        maxTurns,
      }),
    };
  }
  if (cli === 'codex') {
    return {
      codexHome: await materializeCodexHome({
        workspaceDir,
        mcpEntry,
        scope,
        env,
        customServers,
        secretEnv,
      }),
    };
  }
  return {
    mcpConfigPath: await materializeMcpConfig({
      workspaceDir,
      mcpEntry,
      scope,
      env,
      customServers,
    }),
  };
};

// Per-driver NATIVE rules directory (relative to the workspace). The CLI
// auto-loads markdown here at session start — even headless:
//   Claude  → .claude/rules/*.md  (https://code.claude.com/docs/en/memory)
//   Kiro    → .kiro/steering/*.md (loaded via the agent `resources` glob)
const CLI_RULES_DIR = {
  claude: path.join('.claude', 'rules'),
  kiro: path.join('.kiro', 'steering'),
  opencode: path.join('.aidlc', 'opencode-instructions'),
  // Referenced from the codex-home AGENTS.md (materializeCodexHome) — codex has
  // no native auto-loaded rules dir, so the global doc directs it here.
  codex: path.join('.aidlc', 'codex-instructions'),
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
  secretEnv = {},
  cli = null,
  customRules = [],
  attachments = [],
  maxTurns = null,
}) => {
  const aidlcDir = path.join(workspaceDir, '.aidlc');
  await mkdir(aidlcDir, { recursive: true });

  if (rulesDoc) await writeFile(path.join(aidlcDir, 'rules.md'), rulesDoc, 'utf8');

  await materializeCustomRules({ workspaceDir, cli, customRules });

  const cliContext = await materializeCliContext({
    cli: cli ?? 'claude',
    workspaceDir,
    mcpEntry,
    scope,
    env,
    customServers,
    secretEnv,
    maxTurns,
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
    attachments,
    describeChanges: scope?.describeChanges === true && scope?.checkpointOwner !== false,
  });
  return { prompt, ...cliContext, rulesPath: rulesDoc ? path.join(aidlcDir, 'rules.md') : null };
};
