// Serial native turns. HTTP authorization, verified package intake,
// repository checkout and immutable upload are injected ports.
// Neither local owner files nor workflow question evidence confer human authority.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDriver } from '../cli/drivers.js';
import { nativeInteractionReceipt } from '../../shared/native-interaction.js';
import {
  classifyNativeFirstWait,
  nativeMethodReport,
  nativeRequirementsForm,
  clearNativePendingSpec,
  decodeNativeTurnInteraction,
  NATIVE_PENDING_SPEC_PATH,
  readNativePendingSpec,
} from './turn-interaction.js';
import {
  nativeAnswerText,
  NATIVE_AIDLC_INTERACTION_CONTRACT,
} from '../../shared/native-pending-input.js';
import { nativeWorkspaceRecovery } from '../../shared/native-recovery-mode.js';
import {
  nativeRuntimeCommand,
  NATIVE_SELECTION_CAPABILITY,
} from '../../shared/native-runtime-command.js';
import { createNativeTurnOutput } from './turn-output.js';
import { resolveKiroPromptEvidence } from './kiro-prompt.js';
import { nativeExecutionInputs } from '../../shared/native-inputs.js';
import { attachmentPromptManifest, attachmentReferences } from '../attachments.js';
import { kiroAssistantHash } from './kiro-acp-turn.js';
import {
  currentQuestionFile,
  ordinaryFileForm,
  fillQuestionFile,
  fillQuestionCheckpoint,
  fileCompletionForm,
  persistQuestionFile,
} from './question-file.js';
import { observedTurnForm, offeredPlanAlternatives } from './method-output.js';
import { runNativeCommand } from './command-runner.js';
import { recordNativeBoundary } from '../../shared/native-lifecycle.js';
import {
  createNativeActivityLog,
  readNativeActivitySpool,
  NATIVE_ACTIVITY_CAPABILITY,
} from './activity.js';
import {
  captureNativeInitializationBaseline,
  inspectNativeInitialization,
  nativeInitializationBaselineReason,
  nativeInitializationCheckStatuses,
} from './initialization-evidence.js';
import { inspectNativeEfsWorkspace } from './efs-workspace.js';
import { observeNativeWorkflowResumeState } from './workflow-resume-state.js';
import { prepareNativeTransportInstructions } from './transport-instructions.js';
import { snapshotNativeExecutionFiles } from './execution-files.js';
import {
  nativeRuntimeFailureCode,
  nativeSnapshotDiagnostic,
} from '../../shared/native-execution-failure.js';
import { NATIVE_DEPENDENCY_POLICY } from '../../shared/native-project-files.js';
const HARNESSES = ['claude', 'codex', 'kiro', 'opencode'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;
const SCOPE = ['projectId', 'executionId', 'bindingId'];
const IDENTITY = [...SCOPE, 'attemptId', 'epoch', 'runtimeSessionId'];
const ACTIVE = new Set(['preparing', 'running', 'publishing', 'cancelling']);
const HOST_PATH =
  '/opt/kiro/bin:/opt/opencode/bin:/opt/bun/bin:/opt/uv/bin:/usr/local/bin:/usr/bin:/bin';
const BINARIES = {
  claude: '/usr/local/bin/claude',
  codex: '/usr/local/bin/codex',
  opencode: '/opt/opencode/bin/opencode',
};
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const text = (value, max = 512) =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= max &&
  !value.includes('\0');
const safeText = (value, max) =>
  text(value, max) &&
  ![...value].some(
    (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
  );
const digest = (value) => createHash('sha256').update(value).digest('hex');
const snapshotIdentity = (files) => digest(JSON.stringify(files.map(fileRef)));
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameIdentity = (a, b) => IDENTITY.every((key) => a[key] === b[key]);
const within = (base, path) => path === base || path.startsWith(`${base}/`);
const identityOf = (payload) => Object.fromEntries(IDENTITY.map((key) => [key, payload[key]]));

export const nativeFirstTurnPrompt = ({ harness, request } = {}) => {
  if (!HARNESSES.includes(harness)) fail('native_execution_harness_invalid');
  // Codex expands a named skill from $aidlc in exec as well as interactive mode.
  const marker = harness === 'codex' ? '$aidlc' : '/aidlc';
  return `${marker} ${request}`;
};

export const nativeWorkspaceResumePrompt = ({ harness }) => {
  if (!HARNESSES.includes(harness)) fail('native_execution_harness_invalid');
  return `${harness === 'codex' ? '$aidlc' : '/aidlc'} --resume`;
};

// The pinned engine consumes the entire /aidlc message as human input. Keep
// platform guidance in the harness instruction channel: adding an annex here
// changes both command parsing and the provenance of recorded human answers.
export const nativeTransportInstructions = () => {
  return (
    'Platform transport instruction: The user message contains the exact request, reply, ' +
    'or explicitly confirmed fresh-session resume entrypoint. Follow the pinned AI-DLC ' +
    'entrypoint and its normal filesystem artifacts. This platform guidance is not a human ' +
    'answer, interaction-mode selection or workflow approval. ' +
    'Do not invent missing scope, requirements, or human answers. At the first workflow ' +
    'question or approval that needs a person, present the complete proposal and questions ' +
    'in your normal assistant response, preserve any normal workflow artifacts, leave ' +
    'the native workflow waiting, and end this turn. The platform will show your response and files to ' +
    'the user. Do not approve a gate, answer on behalf of the user, or continue past that wait. ' +
    'Native filesystem capability: ordinary npm installs, local file: dependencies and builds ' +
    'are supported. Generated node_modules trees, including bounded relative internal links, ' +
    'remain in this persistent workspace. Authored files, package manifests and lockfiles ' +
    'remain published. Other public symbolic links, external/absolute or private targets, ' +
    'cycles and missing targets are unsupported. Do not skip required dependencies or tests ' +
    'or copy private files as a workaround. ' +
    'For an explicitly confirmed fresh-session resume, use the pinned AI-DLC recovery ' +
    'protocol and its supported resume entrypoint on this same surviving workspace. ' +
    'The workspace contains its existing workflow records and may contain interrupted, unpublished edits. ' +
    'Do not initialize another project, replace this directory from a publication, or reconstruct a workflow in parallel. ' +
    'AI-DLC must reconcile its artifacts, audit, state and runtime graph, continue incomplete work, or ask the member. ' +
    'This confirmation grants no workflow approval and contains no replay of an earlier answer or command. ' +
    'Do not infer that a prior answer was consumed or repeat uncertain external effects. ' +
    'Never route a resume message through an earlier plan offer or treat it as plan consent. ' +
    'At the next required question or human gate, preserve work, present it and end this turn. ' +
    NATIVE_QUESTION_MODE_INSTRUCTION +
    NATIVE_PENDING_SPEC_INSTRUCTION +
    NATIVE_INTAKE_ANSWER_INSTRUCTION
  );
};

// The grouped form is a platform renderer, not evidence that a person selected
// an AI-DLC interaction mode. Its normal mode question and human gates remain.
const NATIVE_QUESTION_MODE_INSTRUCTION =
  "Native UI presentation: show the current workflow step's available questions together in one form. " +
  "Follow the pinned workflow's normal interaction-mode question unless the person has already " +
  'expressed a genuine preference in their retained request or answers. Never record these ' +
  'platform instructions as words spoken by the person. Honor genuine later user changes ' +
  "and the engine's answer_mode reuse. This rendering guidance grants no autonomy over " +
  'answers, summaries, approvals or stage gates. ' +
  'The native form is the question renderer for this noninteractive invocation: it supports ' +
  'up to 32 questions and 16 options per question, plus free text. Collect ALL unanswered ' +
  'questions already available at the CURRENT workflow step into one form, copying their ' +
  'complete prompts and option sets from the workflow question definitions. Do not split ' +
  'them to fit a terminal question tool, invent future questions, combine stages, or merge ' +
  'a required summary confirmation or approval with the questions it follows. ' +
  'If a form exceeds these bounded limits, explain the limit and preserve all questions; ' +
  'never truncate them. Use only capabilities supported by the pinned workflow. ';

// The pinned engine's intake plan offer is a bare `ask` emitted before any
// workflow state exists, so `report --user-input` cannot record it. The engine
// contract (aidlc-orchestrate.ts Branch 8) is to re-run `next` with the choice:
// `next compose` reaches the composer (Branch 4c), `--scope` creation (9a).
const NATIVE_INTAKE_ANSWER_INSTRUCTION =
  ' If the engine emits response_route next, keep its request identity and use the exact ' +
  'compose_command, scope_commands or choices command associated with the human selection. ' +
  'When the person requests alternatives or discusses a different recommendation, present the named ' +
  'plans from that same offer in a new form. A written preference for a named alternative at ' +
  'the recommendation is a request for the picker. Leave the intent uncreated until the next ' +
  'explicit plan selection. The platform displays these choices without resuming your thread. ' +
  'On resume, NATIVE_SELECTED_PLAN_LABEL in the tool environment identifies the option the member ' +
  'actually selected from your published offer. For a named plan use its original request-bound ' +
  'scope command once. Keep the human message verbatim. A missing selection is no plan consent. ' +
  'Report a command rejection using its actual reason and the current workflow step. ' +
  'Do not reconstruct those commands or use report for a pre-workflow plan offer. ' +
  'An emitted command is data until a person selects its option; never execute all offered commands.';

const NATIVE_PENDING_SPEC_INSTRUCTION =
  'For questions without a supported workflow file or structured command result, write the complete CURRENT ' +
  `question definition as JSON to ${NATIVE_PENDING_SPEC_PATH} in the project directory, ` +
  'replacing any earlier file: {"version":2,"questions":[{"prompt":"...","header":"...",' +
  '"multiSelect":false,"options":[{"label":"...","description":"..."}]}]}. ' +
  'An engine compose-offer or scope-confirm is already rendered from its command. If the harness transport is needed, copy its complete JSON unchanged into ' +
  '{"version":3,"ask":<engine ask object>} instead; the native adapter renders its explicit ' +
  'scope_commands and choices. Do not invent a plan list or convert typed choices to prose. ' +
  'After reporting code-generation awaiting approval, read aidlc engine orchestrate next and ' +
  'follow its steering continuation. Present the settled stage gate from its gate_only directive. ' +
  'Record the answer-mode decision using the command in the installed stage instructions. ' +
  'Use the active workflow question file directly for guided batches and file-mode answers. The native editor can save scoped answer slots and waits for the member to finish file mode. ' +
  'When NATIVE_APPLIED_QUESTION_FILE is set, the member’s answer is saved there and its required log answer has succeeded. Read the file and follow the current step, including answer analysis, follow-ups and genuine gates. Do not repeat the answer receipt. ' +
  'For other questions copy exact workflow wording, labels, descriptions and order. ' +
  'Do not add numbering or remove literal recommendation text from a label. ' +
  'Use options:[] and multiSelect:false for a written answer. Keep normal explanatory prose; ' +
  'it need not repeat the form verbatim. Every question requires an answer. Do not include ' +
  'credentials, commands as labels, or questions from a prior/future step. Remove this file if ' +
  'you advance beyond the question within this turn. The reply contains the selected labels ' +
  'and free text, numbered by header for multiple questions. Record every answer using its ' +
  'workflow command, without re-asking answered questions. ';

export const NATIVE_CODEX_MAX_THREADS = 4;

/** Native projected hooks/config are used; no platform MCP or probe prompts. */
export const nativeExecutionInvocation = ({
  harness,
  prompt,
  model,
  project,
  nativeSessionId = null,
  promptEvidence = null,
  priorAssistantSha256 = null,
  systemPrompt = null,
}) => {
  const modelArgs = model ? [harness === 'codex' ? '-m' : '--model', model] : [];
  if (harness === 'codex')
    return {
      command: BINARIES.codex,
      args: [
        'exec',
        ...(nativeSessionId ? ['resume', nativeSessionId] : []),
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust',
        '-c',
        'features.default_mode_request_user_input=false',
        '-c',
        'tools.experimental_request_user_input.enabled=false',
        // Each Codex tool call starts five concurrent aidlc hook processes
        // (~140-250 MB each); bound concurrent sub-agents so a stage cannot
        // exhaust the runtime's memory (aidlc-workflows#2066).
        '-c',
        `agents.max_threads=${NATIVE_CODEX_MAX_THREADS}`,
        '-c',
        'model_provider="amazon-bedrock"',
        '-c',
        `projects.${JSON.stringify(project)}.trust_level="trusted"`,
        ...modelArgs,
        '-',
      ],
      stdin: prompt,
    };
  if (harness === 'claude')
    return {
      command: BINARIES.claude,
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
        ...(nativeSessionId ? ['--resume', nativeSessionId] : []),
        ...modelArgs,
      ],
      stdin: prompt,
    };
  if (harness === 'opencode')
    return {
      command: BINARIES.opencode,
      args: [
        'run',
        '--format',
        'json',
        '--auto',
        ...(nativeSessionId ? ['--session', nativeSessionId] : []),
        ...(model ? ['--model', model.includes('/') ? model : `amazon-bedrock/${model}`] : []),
      ],
      stdin: prompt,
    };
  if (harness === 'kiro')
    return {
      command: process.execPath,
      args: [
        fileURLToPath(new URL('./kiro-acp-turn.js', import.meta.url)),
        '--production',
        '--project',
        project,
        ...(nativeSessionId
          ? [
              '--resume-id',
              nativeSessionId,
              '--history-mode',
              'latest-turn',
              '--prior-user-prompt-sha256',
              promptEvidence?.userPromptSha256,
              '--prior-assistant-sha256',
              priorAssistantSha256,
            ]
          : []),
        ...modelArgs,
        '--prompt',
        prompt,
      ],
    };
  fail('native_execution_harness_invalid');
};

const fileRef = (file) => ({ path: file.path, sha256: file.sha256 });
const privateDirectory = async (path) => {
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) ||
    (await fs.realpath(path)) !== path
  )
    fail('native_execution_directory_invalid');
  return stat;
};
const syncDirectory = async (path) => {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const createPrivateDirectory = async (path) => {
  await fs.mkdir(path, { mode: 0o700 });
  return privateDirectory(path);
};
const readLocalRecord = async (path) => {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > 32n * 1024n ||
      (before.mode & 0o077n) !== 0n
    )
      fail('native_execution_local_record_invalid');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail('native_execution_local_record_invalid');
      offset += bytesRead;
    }
    for (const after of [
      await handle.stat({ bigint: true }),
      await fs.lstat(path, { bigint: true }),
    ]) {
      if (
        !sameNode(before, after) ||
        ['size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key])
      )
        fail('native_execution_local_record_invalid');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    await handle.close();
  }
};
// The projected native Claude SessionEnd hook needs longer than Claude's
// short default on EFS (qualified in the existing operator experiment). This
// bounds hook teardown only, not the model turn. Never alter the signed package.
export const configureNativeClaudeSessionEnd = async (project) => {
  const projectStat = await privateDirectory(project);
  const directory = join(project, '.claude');
  const directoryStat = await fs.lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (await fs.realpath(directory)) !== directory
  )
    fail('native_execution_claude_settings_invalid');
  const path = join(directory, 'settings.json');
  const handle = await fs.open(
    path,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 1024n * 1024n)
      fail('native_execution_claude_settings_invalid');
    const recheck = async () => {
      if (
        !sameNode(projectStat, await privateDirectory(project)) ||
        !sameNode(directoryStat, await fs.lstat(directory)) ||
        (await fs.realpath(directory)) !== directory
      )
        fail('native_execution_claude_settings_invalid');
      const current = await fs.lstat(path, { bigint: true });
      const opened = await handle.stat({ bigint: true });
      if (
        !current.isFile() ||
        current.nlink !== 1n ||
        opened.nlink !== 1n ||
        !sameNode(before, current) ||
        !sameNode(before, opened)
      )
        fail('native_execution_claude_settings_invalid');
      return opened;
    };
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail('native_execution_claude_settings_invalid');
      offset += bytesRead;
    }
    const current = await recheck();
    if (['size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== current[key]))
      fail('native_execution_claude_settings_invalid');
    const settings = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const groups = settings?.hooks?.SessionEnd;
    const hooks = (Array.isArray(groups) ? groups : [])
      .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
      .filter(
        (hook) => hook?.type === 'command' && hook.command === 'aidlc engine hook session-end',
      );
    if (hooks.length !== 1) fail('native_execution_claude_settings_invalid');
    if (Object.hasOwn(hooks[0], 'timeout')) return;
    hooks[0].timeout = 30;
    const output = Buffer.from(`${JSON.stringify(settings, null, 2)}\n`);
    if (output.length > 1024 * 1024) fail('native_execution_claude_settings_invalid');
    await handle.writeFile(output);
    await handle.truncate(output.length);
    await handle.sync();
    await recheck();
  } finally {
    await handle.close();
  }
};
const canonicalConfig = (configuration) => {
  if (
    !configuration ||
    !nativeWorkspaceRecovery(configuration) ||
    !HARNESSES.includes(configuration.harness) ||
    !(configuration.model === null || safeText(configuration.model, 256)) ||
    !text(configuration.prompt, 64 * 1024) ||
    !VERSION.test(configuration.packageVersion ?? '') ||
    !['github', 'gitlab', 'bitbucket'].includes(configuration.repository?.provider) ||
    !safeText(configuration.repository?.repository, 1024) ||
    !safeText(configuration.repository?.branch, 1024) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(configuration.repository?.commit ?? '')
  )
    fail('native_execution_configuration_invalid');
  const { harness, model, prompt, packageVersion, repository } = configuration;
  let inputs;
  try {
    inputs = nativeExecutionInputs(configuration.inputs);
  } catch {
    fail('native_execution_configuration_invalid');
  }
  return {
    harness,
    recoveryMode: configuration.recoveryMode,
    model,
    prompt,
    packageVersion,
    inputs,
    repository: Object.fromEntries(
      ['provider', 'repository', 'branch', 'commit'].map((key) => [key, repository[key]]),
    ),
  };
};
// A turn carries its admitted command, report, task and cancellation signal.
// Every asynchronous phase and observer keeps this explicit context.
const createTurn = (owner, payload, { session = null, workspacePackageId = null } = {}) => ({
  owner,
  payload,
  signal: owner.controller.signal,
  session,
  workspacePackageId,
  nextSession: null,
  activity: null,
  task: null,
  report: {
    schemaVersion: 1,
    ...owner.identity,
    writerGeneration: owner.writerGeneration,
    sequence: payload.command === 'native-start' ? 1 : payload.sequence,
    ...(payload.command === 'native-resume'
      ? { recoveryId: payload.recoveryId, requestId: payload.recoveryId }
      : payload.command === 'native-continue'
        ? {
            requestId: payload.requestId,
            priorInteractionId: payload.priorInteractionId,
            priorPublicationId: payload.priorPublicationId,
          }
        : {}),
    status: 'preparing',
    updatedAt: Date.now(),
  },
});

const releaseTurn = (turn) => {
  // Keep only the public report and the next session's verified continuation
  // evidence. Request text, credentials and completed activity belong to this turn.
  turn.payload = null;
  turn.session = null;
  turn.workspacePackageId = null;
  turn.activity = null;
  turn.task = null;
};

const checkDirectories = async (owner) => {
  for (const [path, initial] of owner.directories) {
    if (!sameNode(initial, await privateDirectory(path)))
      fail('native_execution_directory_changed');
  }
};

const writeJson = async (owner, path, data, replace = false) => {
  await checkDirectories(owner);
  const temp = replace ? `${path}.${randomUUID()}.tmp` : path;
  const handle = await fs.open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(data)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await checkDirectories(owner);
  if (replace) await fs.rename(temp, path);
  await syncDirectory(owner.directory);
};

const activityLog = (turn) => {
  turn.report.activityProtocol = NATIVE_ACTIVITY_CAPABILITY;
  const { owner } = turn;
  return (owner.activityLog ??= createNativeActivityLog({
    writerGeneration: owner.writerGeneration,
    spoolDirectory: join(owner.directory, 'activity'),
  }));
};

const timing = (turn, boundary, counts = {}) => {
  turn.report.timings ??= {};
  turn.report.timings[boundary] = Date.now();
  recordNativeBoundary(turn.owner.identity, boundary, turn.report.timings[boundary], {
    sequence: turn.report.sequence,
    writerGeneration: turn.owner.writerGeneration,
    ...counts,
  });
};

const report = (turn) =>
  structuredClone({
    ...turn.report,
    recovered: false,
    capabilities: [NATIVE_ACTIVITY_CAPABILITY, NATIVE_SELECTION_CAPABILITY],
  });

const persist = (turn) =>
  writeJson(turn.owner, join(turn.owner.directory, 'status.json'), turn.report, true);

const setStatus = async (turn, status, extra = {}) => {
  turn.report = { ...turn.report, ...extra, status, updatedAt: Date.now() };
  await persist(turn);
};

const checkCancelled = (turn) => {
  if (turn.signal.aborted) fail('native_execution_cancelled');
};

/**
 * Required production ports:
 * prepare({payload,root,project,home,signal}) -> {
 *   package:{directory,binaryPath,version,packageId,sourceRepository?},
 *   repositoryCommit, authEnv:{AWS_BEARER_TOKEN_BEDROCK?,KIRO_API_KEY?,BEDROCK_REGION?},
 *   forbiddenBytes?:Array<string|Buffer>
 * }
 * prepare must authorize/load the immutable pinned release on EFS outside
 * project/control, and checkout exactly configuration.repository.commit into
 * the empty private project. Git credentials must be removed before returning.
 *
 * publish({identity,packageId,nativeSessionId,outcome,repository,files,
 * questionPath,signal}) -> {uploaded:true,receipt:<shared-publication receipt>}. outcome is
 * WAITING_FOR_INPUT or STOPPED; repository is {branch,commit}; files carry exact
 * Buffer content. The controller must verify the receipt and fence the current
 * epoch/cancellation before committing its publication head/outbox. A receipt
 * in local status is NOT that authority. No auto publish retry or new writer.
 *
 * assertActive({identity,signal}) is optional for injected local tests and
 * required in the production ports. It reads the trusted cancellation fence
 * afresh and throws unless ACTIVE. Immediately after it resolves the executor
 * performs only a synchronous abort check and calls commandRunner; no local
 * filesystem/publication awaits are allowed between this check and spawn.
 *
 * start(payload) durably claims one owner, returns a quick ack, and schedules
 * work. status/cancel accept the six identity fields. settle() awaits work.
 * root/homeRoot/inspectMount/inspectInitialization/snapshot are injectable for
 * local tests. Default paths are EFS /mnt/native and local /home/node/.native-homes.
 * Caller must authenticate every method and keep the host alive while isBusy().
 */
const questionScope = (source) => [
  '--stage',
  source.stage,
  ...(source.unit ? ['--unit', source.unit] : []),
];

export const createNativeExecutor = ({
  env = process.env,
  prepare,
  prepareContinuation,
  prepareInputs,
  publish,
  publishInteraction,
  assertActive,
  assertRecoveryAdmission,
  prepareRecovery,
  commandRunner = runNativeCommand,
  root = '/mnt/native',
  homeRoot = '/home/node/.native-homes',
  inspectMount = inspectNativeEfsWorkspace,
  inspectInitialization = inspectNativeInitialization,
  snapshot = snapshotNativeExecutionFiles,
} = {}) => {
  const scope = Object.fromEntries(
    SCOPE.map((key) => [key, env[`NATIVE_RUNTIME_${key.replace(/Id$/, '_ID').toUpperCase()}`]]),
  );
  if (
    env.NATIVE_RUNTIME_MODE !== 'isolated' ||
    SCOPE.some((key) => !ID.test(scope[key] ?? '')) ||
    typeof prepare !== 'function' ||
    typeof publish !== 'function' ||
    typeof publishInteraction !== 'function' ||
    (prepareContinuation !== undefined && typeof prepareContinuation !== 'function') ||
    (assertActive !== undefined && typeof assertActive !== 'function') ||
    ![root, homeRoot].every(
      (path) => typeof path === 'string' && isAbsolute(path) && resolve(path) === path,
    ) ||
    within(root, homeRoot) ||
    within(homeRoot, root)
  )
    fail('native_execution_options_invalid');
  const control = join(root, '.native-control');
  const directoryForGeneration = (generation) =>
    join(control, generation === 1 ? 'first-turn' : `writer-${generation}`);
  const project = join(root, 'project');
  let activeOwner = null;
  let admitting = false;
  const generationOf = (value) => {
    const generation = value?.writerGeneration;
    if (!Number.isSafeInteger(generation) || generation < 1)
      fail('native_execution_scope_mismatch');
    return generation;
  };
  const validateIdentity = (value) => {
    if (
      !value ||
      SCOPE.some((key) => value[key] !== scope[key]) ||
      !ID.test(value.attemptId ?? '') ||
      !ID.test(value.runtimeSessionId ?? '') ||
      value.epoch !== 1
    )
      fail('native_execution_scope_mismatch');
    return identityOf(value);
  };
  const createOwner = ({
    identity,
    writerGeneration,
    configurationSha256,
    directories,
    controller = new AbortController(),
  }) => ({
    identity,
    writerGeneration,
    configurationSha256,
    directories,
    directory: directoryForGeneration(writerGeneration),
    controller,
    poisoned: false,
    turn: null,
  });
  const assertCreatedWorkflow = async () => {
    const state = await observeNativeWorkflowResumeState({ project });
    if (state !== 'created')
      fail(
        state === 'not_created'
          ? 'native_execution_workflow_not_created'
          : 'native_execution_workflow_state_unavailable',
      );
  };
  const workspaceResumeObservation = async (identity, configurationSha256) => {
    try {
      const workspace = await readLocalRecord(join(control, 'workspace.json'));
      if (
        workspace.schemaVersion !== 1 ||
        !sameIdentity(workspace.identity ?? {}, identity) ||
        workspace.configurationSha256 !== configurationSha256 ||
        !/^sha256:[a-f0-9]{64}$/.test(workspace.packageId ?? '')
      )
        return 'unavailable';
      const paths = [
        ['root', root],
        ['project', project],
        ['machine', join(root, 'machine')],
      ];
      const nodes = [];
      for (const [name, path] of paths) {
        nodes.push(await privateDirectory(path));
        if (String((await fs.lstat(path, { bigint: true })).ino) !== workspace.nodes?.[name]?.ino)
          return 'unavailable';
      }
      const state = await observeNativeWorkflowResumeState({ project });
      for (const [index, [, path]] of paths.entries())
        if (!sameNode(nodes[index], await privateDirectory(path))) return 'unavailable';
      return state;
    } catch {
      // Status is observation only. Missing, substituted or unrecognized
      // workspace state cannot grant fresh-session recovery.
      return 'unavailable';
    }
  };
  const run = async (turn, invocation, commandEnv, model = false) => {
    checkCancelled(turn);
    const options = {
      ...invocation,
      cwd: project,
      env: commandEnv,
      timeoutMs: model ? null : 300_000,
      outputLimitAction: model ? 'truncate' : 'terminate',
      signal: turn.signal,
    };
    if (model && assertActive) {
      await assertActive({
        identity: { ...turn.owner.identity },
        writerGeneration: turn.owner.writerGeneration,
        signal: turn.signal,
      });
    }
    // Keep the next spawn in this continuation: adding an await here would
    // reopen a local scheduling gap after the latest cancellation observation.
    checkCancelled(turn);
    if (model) timing(turn, 'harnessLaunched');
    const result = await commandRunner(options);
    if (result.cleanupComplete !== true) fail('native_execution_cleanup_incomplete');
    checkCancelled(turn);
    if (
      result.exitCode !== 0 ||
      result.signal ||
      result.spawnError ||
      result.timedOut ||
      (!model && result.outputLimitExceeded)
    )
      fail(model ? 'native_execution_command_failed' : 'native_execution_initialization_failed');
    return result;
  };
  const ensureTurnInputs = async (turn) => {
    const { payload, owner, signal, activity: activityTurn } = turn;
    const configuration = payload.configuration;
    if (configuration.inputs.attachments.length) {
      if (typeof prepareInputs !== 'function') fail('native_execution_preparation_invalid');
      activityTurn.lifecycle({ title: 'Verifying reference inputs' });
      await prepareInputs({ payload, project, signal });
      checkCancelled(turn);
      await checkDirectories(owner);
    }
  };
  // Preparation owns package/harness installation and returns this turn's execution inputs.
  const prepareNativeTurn = async (turn) => {
    const { owner, payload, signal } = turn;
    timing(turn, 'preparationStarted');
    const continuing = payload.command !== 'native-start';
    if (payload.command === 'native-resume') {
      const resumed = await prepareRecovery({
        payload,
        root,
        project,
        home: owner.home,
        signal,
      });
      if (resumed?.package?.packageId !== turn.workspacePackageId)
        fail('native_execution_workspace_invalid');
      owner.package = resumed.package;
    }
    const prepared = continuing
      ? await prepareContinuation({ payload, signal })
      : await prepare({ payload, root, project, home: owner.home, signal });
    if (!continuing) owner.sourceBaseline = prepared?.sourceBaseline ?? null;
    timing(turn, 'preparationCompleted');
    checkCancelled(turn);
    await checkDirectories(owner);
    const pkg = continuing ? owner.package : prepared?.package;
    const configuration = payload.configuration;
    if (
      !pkg ||
      pkg.version !== configuration.packageVersion ||
      !safeText(pkg.packageId, 128) ||
      ![pkg.directory, pkg.binaryPath].every(
        (path) => typeof path === 'string' && isAbsolute(path) && resolve(path) === path,
      ) ||
      !within(root, pkg.directory) ||
      within(project, pkg.directory) ||
      within(control, pkg.directory) ||
      !pkg.binaryPath.startsWith(`${pkg.directory}/`) ||
      (!continuing && prepared.repositoryCommit !== configuration.repository.commit) ||
      !prepared.authEnv ||
      typeof prepared.authEnv !== 'object'
    )
      fail('native_execution_preparation_invalid');
    await privateDirectory(pkg.directory);
    const auth = getDriver(configuration.harness).envForAuth(prepared.authEnv);
    if (
      !text(
        configuration.harness === 'kiro' ? auth.KIRO_API_KEY : auth.AWS_BEARER_TOKEN_BEDROCK,
        64 * 1024,
      )
    )
      fail('native_execution_credentials_missing');
    let harnessBaseline;
    try {
      // prepare has verified the checkout commit and removed Git credentials.
      // Never learn baseline directories after any package command has run.
      if (!continuing)
        harnessBaseline = await captureNativeInitializationBaseline({
          projectDirectory: project,
          harness: configuration.harness,
        });
    } catch (error) {
      turn.report.initializationChecks = [{ id: 'harness-layout', status: 'failed' }];
      turn.report.initializationBaselineReason =
        nativeInitializationBaselineReason(error?.baselineReason) ?? 'baseline-read-failed';
      fail('native_execution_initialization_unverified');
    }
    const forbiddenBytes = [
      ...(owner.forbiddenBytes ?? []),
      ...[prepared.authEnv.AWS_BEARER_TOKEN_BEDROCK, prepared.authEnv.KIRO_API_KEY].filter(Boolean),
      ...(prepared.forbiddenBytes ?? []),
    ];
    const activityTurn = activityLog(turn).turn({
      sequence: turn.report.sequence,
      harness: configuration.harness,
      model: configuration.model,
      // Native does not retain a trusted cumulative usage baseline. A resumed
      // Codex thread therefore has unknown per-turn usage; fresh sessions start
      // at zero, including explicitly confirmed fresh-session EFS recovery.
      usageBaseline: continuing ? null : undefined,
      forbiddenBytes,
      signal,
      onObservation: (boundary, counts) => timing(turn, boundary, counts),
    });
    turn.activity = activityTurn;
    activityTurn.lifecycle({ title: 'Preparing native harness' });
    timing(turn, 'installationStarted');
    // Kept only in the hot owner for subsequent credential leak checks.
    // Never serialize these values into local status, messages or Git.
    owner.forbiddenBytes = [...new Set(forbiddenBytes)];
    const baseEnv = {
      HOME: owner.home,
      TMPDIR: '/tmp',
      PATH: `${join(root, 'machine/bin')}:${HOST_PATH}`,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      AIDLC_INSTALL_ROOT: join(root, 'machine/data'),
      AIDLC_BIN_DIR: join(root, 'machine/bin'),
      AIDLC_OFFLINE: '1',
      AIDLC_PROJECT_DIR: project,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...(safeText(pkg.sourceRepository, 1024)
        ? {
            AIDLC_RELEASE_REPOSITORY: pkg.sourceRepository,
            AIDLC_RELEASE_WORKFLOW: `${pkg.sourceRepository}/.github/workflows/release.yml`,
          }
        : {}),
    };
    const binary = join(root, 'machine/bin/aidlc');
    if (!continuing)
      for (const invocation of [
        {
          phase: 'packageInstallation',
          title: 'Installing verified workflow package',
          command: pkg.binaryPath,
          args: ['use', pkg.version, '--from', pkg.directory, '--offline', '--json'],
        },
        {
          phase: 'projectPin',
          title: 'Pinning workflow to this workspace',
          command: binary,
          args: [
            'config',
            '--pin',
            pkg.version,
            '--project-dir',
            project,
            '--from',
            pkg.directory,
            '--offline',
            '--json',
          ],
        },
        {
          phase: 'harnessConfiguration',
          title: 'Configuring native harness',
          command: binary,
          args: [
            'config',
            '--harness',
            configuration.harness,
            '--project-dir',
            project,
            '--from',
            join(root, 'machine/data/versions', pkg.version, 'runtime', configuration.harness),
            '--mcp',
            'none',
            '--yes',
            '--json',
          ],
        },
      ]) {
        const { phase, title, ...command } = invocation;
        activityTurn.lifecycle({ title });
        timing(turn, `${phase}Started`);
        await run(turn, command, baseEnv);
        timing(turn, `${phase}Completed`);
      }
    if (!continuing) {
      timing(turn, 'initializationVerificationStarted');
      activityTurn.lifecycle({ title: 'Verifying workflow installation' });
      const inspection = await inspectInitialization({
        projectDirectory: project,
        installRoot: join(root, 'machine/data'),
        version: pkg.version,
        harness: configuration.harness,
        harnessBaseline,
      });
      if (inspection?.ok !== true) {
        turn.report.initializationChecks = nativeInitializationCheckStatuses(inspection?.checks);
        fail('native_execution_initialization_unverified');
      }
      await checkDirectories(owner);
      if (configuration.harness === 'claude') await configureNativeClaudeSessionEnd(project);
      owner.package = structuredClone(pkg);
      const nodes = {};
      for (const [name, path] of [
        ['root', root],
        ['project', project],
        ['machine', join(root, 'machine')],
      ]) {
        await privateDirectory(path);
        // NFS st_dev belongs to the owner client mount, not the surviving
        // EFS directory. Persist its full-width file ID, never that device ID.
        nodes[name] = { ino: String((await fs.lstat(path, { bigint: true })).ino) };
      }
      await writeJson(owner, join(control, 'workspace.json'), {
        schemaVersion: 1,
        identity: owner.identity,
        configurationSha256: owner.configurationSha256,
        packageId: pkg.packageId,
        sourceBaseline: owner.sourceBaseline,
        nodes,
      });
      timing(turn, 'initializationVerificationCompleted');
    }
    timing(turn, 'installationCompleted');
    await ensureTurnInputs(turn);
    return { pkg, forbiddenBytes, auth, baseEnv };
  };

  // One turn returns quiescent output. No publication or recovery head is admitted here.
  const questionCommands = (turn, baseEnv) => {
    const { owner, payload, session, signal } = turn;
    const assertWriter = async () => {
      await checkDirectories(owner);
      if (assertActive)
        await assertActive({
          identity: owner.identity,
          writerGeneration: owner.writerGeneration,
          signal,
        });
      checkCancelled(turn);
    };
    const method = async (args, stdin) => {
      await assertWriter();
      const result = await run(
        turn,
        {
          command: join(root, 'machine/bin/aidlc'),
          args: ['engine', ...args],
          ...(stdin ? { stdin } : {}),
        },
        baseEnv,
      );
      return result.stdout;
    };
    const recordBatch = async (source, form) => {
      const batch = JSON.parse(
        await method([
          'log',
          'decision',
          ...questionScope(source),
          '--decision',
          form.ids.join(', '),
          '--options',
          form.spec.questions.flatMap((q) => q.options.map((o) => o.label)).join(', '),
        ]),
      );
      if (batch.emitted !== 'DECISION_RECORDED' || batch.stage !== source.stage)
        fail('native_execution_reply_conflict');
    };
    const recordHumanTurn = () =>
      method(
        ['hook', 'record-human-turn'],
        JSON.stringify({
          cwd: project,
          hook_event_name: 'UserPromptSubmit',
          session_id: session.nativeSessionId,
          prompt: payload.text,
        }),
      );
    const recordAnswer = async (source, details, checkpoint) => {
      await recordHumanTurn();
      const summary = checkpoint === 'Consolidated Summary Confirmation';
      const result = JSON.parse(
        await method([
          'log',
          'answer',
          ...questionScope(source),
          ...(summary
            ? ['--checkpoint', 'summary-confirmation', '--questions-file', source.path]
            : []),
          '--details',
          details,
        ]),
      );
      if (
        result.emitted !== (summary ? 'SUMMARY_CONFIRMATION_RECORDED' : 'QUESTION_ANSWERED') ||
        result.stage !== source.stage
      )
        fail('native_execution_file_answer_conflict');
    };
    const openSavedBatch = async (receipt) => {
      const ledger = JSON.parse(await method(['log', 'answers', ...questionScope(receipt.source)]));
      return (
        ledger.stage === receipt.source.stage &&
        ledger.open?.length === 1 &&
        ledger.open[0].question === receipt.decision &&
        (ledger.open[0].unit ?? null) === receipt.source.unit &&
        !ledger.open[0].workflow &&
        ledger.ambiguous?.length === 0
      );
    };
    return { assertWriter, method, recordBatch, recordAnswer, openSavedBatch };
  };

  const reconciledQuestionFile = async (turn, baseline) => {
    const { owner, payload } = turn;
    const configuration = payload.configuration;
    let recoveredFile = null;
    if (payload.command === 'native-resume') {
      const directory = directoryForGeneration(owner.writerGeneration - 1);
      const status = await readLocalRecord(join(directory, 'status.json'));
      if (
        status.status !== 'publication_ready' &&
        status.requestId &&
        sameIdentity(status, owner.identity) &&
        status.writerGeneration === owner.writerGeneration - 1
      ) {
        let receipt;
        try {
          receipt = await readLocalRecord(join(directory, `file-answer-${status.sequence}.json`));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (receipt) {
          const admission = await readLocalRecord(
            join(directory, `request-${status.requestId}.json`),
          );
          const saved = baseline.files.find(
            (f) => f.path === receipt.path && f.role === 'question',
          );
          if (
            !sameIdentity(receipt.identity, owner.identity) ||
            receipt.writerGeneration !== status.writerGeneration ||
            receipt.sequence !== status.sequence ||
            receipt.requestId !== status.requestId ||
            admission.ack?.requestId !== receipt.requestId ||
            status.priorInteractionId !== receipt.priorInteractionId ||
            status.priorPublicationId !== receipt.priorPublicationId ||
            !saved ||
            !Number.isSafeInteger(receipt.bytes) ||
            receipt.bytes < 1 ||
            saved.sha256 !== receipt.after ||
            saved.content.length !== receipt.bytes
          )
            fail('native_execution_file_answer_conflict');
          if (
            (receipt.decision || receipt.fileEdit) &&
            currentQuestionFile(
              baseline,
              { issuedFile: receipt.source, state: receipt.state },
              configuration.harness,
            )
          )
            recoveredFile = receipt;
          timing(turn, 'fileAnswerReconciled');
        }
      }
    }
    return recoveredFile;
  };

  const prepareQuestionReply = async (
    turn,
    { baseline, snapshotWorkspace, pkg, forbiddenBytes, commands, choice },
  ) => {
    const { owner, payload } = turn;
    const configuration = payload.configuration;
    const continuing = payload.command === 'native-continue';
    const { assertWriter, recordAnswer, recordBatch, openSavedBatch } = commands;
    const session = turn.session;
    const binding = continuing ? session.questionFile : null;
    if (
      continuing &&
      session.planApprovalWorkspace &&
      session.planApprovalWorkspace !== snapshotIdentity(baseline.files)
    )
      fail('native_execution_reply_conflict');
    const selected = payload.selection?.answers[0];
    const modeLabel =
      session?.answerMode && selected?.selectedOptions.length === 1 && !selected.freeText
        ? session.pendingInput.questions[0].options[choice]?.label
        : null;
    const fileMode =
      modeLabel === 'Guide me' ? 'guide' : modeLabel === "I'll edit the file" ? 'file' : null;
    let appliedFile = null;
    const directCheckpoint =
      session?.checkpoint &&
      selected &&
      (selected.selectedOptions.length || session.checkpoint === 'Requested Changes Feedback');
    const applySlots = async (current, display, changed) => {
      const edit = session.fileStep === 'file';
      const result = directCheckpoint
        ? fillQuestionCheckpoint(current.parsed, session.checkpoint, selected)
        : fillQuestionFile(current.parsed, session.fileQuestionIds, payload.selection, edit);
      if (!result)
        return display(
          'Your reply was saved, but its answer slots could not be applied. Use Other with a written answer. Keep literal workflow question headings and answer markers outside your answer. Review the current file and ask to reopen the questions.',
        );
      if (forbiddenBytes.some((secret) => secret && result.bytes.includes(Buffer.from(secret))))
        fail('native_execution_output_credential');
      // This receipt records the write intent before the atomic rename, including
      // the exact accepted reply and original publication. Recovery only compares.
      const receipt = {
        identity: owner.identity,
        writerGeneration: owner.writerGeneration,
        requestId: payload.requestId,
        sequence: payload.sequence,
        priorInteractionId: payload.priorInteractionId,
        priorPublicationId: payload.priorPublicationId,
        path: binding.path,
        before: binding.sha256,
        after: result.sha256,
        bytes: result.bytes.length,
        source: binding.issuedFile,
        state: binding.state,
        fileEdit: edit,
        ...(session.fileStep === 'guide'
          ? {
              decision: session.fileDecision ?? session.fileQuestionIds.join(', '),
              details: result.details,
            }
          : {}),
      };
      await writeJson(
        owner,
        join(owner.directory, `file-answer-${payload.sequence}.json`),
        receipt,
      );
      timing(turn, 'fileAnswerStarted');
      try {
        await persistQuestionFile(project, binding, result, assertWriter);
      } catch (error) {
        if (error.code === 'native_execution_reply_conflict') return changed();
        throw error;
      }
      timing(turn, 'fileAnswerPersisted');
      appliedFile = { ...binding, sha256: result.sha256, bytes: result.bytes.length };
      if (edit) {
        const saved = await snapshotWorkspace('baseline');
        const now = currentQuestionFile(saved, binding, configuration.harness);
        if (!now || now.file.sha256 !== result.sha256) return changed();
        const remaining = ordinaryFileForm(now.parsed);
        if (remaining)
          return display(
            'Your edits are saved in the question file. Complete the remaining slots.',
            {
              ...remaining,
              fileStep: 'file',
              questionFile: { ...binding, sha256: result.sha256 },
            },
          );
        const ready = fileCompletionForm({ ...binding, sha256: result.sha256 });
        return display(ready.spec.questions[0].prompt, ready);
      }
      await recordAnswer(binding.issuedFile, result.details, session.checkpoint);
    };
    const applyFileReply = async () => {
      if (
        binding?.issuedFile &&
        (fileMode || (session.fileStep && payload.selection) || directCheckpoint)
      ) {
        const nativeSessionId = session.nativeSessionId;
        const current = currentQuestionFile(baseline, binding, configuration.harness);
        const display = async (message, requirements = null) => {
          const files = await snapshotWorkspace('final');
          const completed = { messages: [{ type: 'text', text: message }] };
          if (requirements) {
            const next = currentQuestionFile(files, binding, configuration.harness);
            if (!next || next.file.sha256 !== requirements.questionFile.sha256)
              fail('native_execution_reply_conflict');
            requirements.questionFile.directive = next.cursorHash;
          }
          const form = decodeNativeTurnInteraction({
            interactionContract: pkg.interactionContract,
            snapshot: files,
            rendered: requirements ?? { spec: null, reason: 'stale_spec', bytes: 0 },
            messages: completed.messages,
            forbiddenBytes,
            onDiagnostic: (d) => timing(turn, 'questionPresentation', d),
          });
          const outcome = classifyNativeFirstWait({
            snapshot: files,
            harness: configuration.harness,
            issuedFile: binding.issuedFile,
          });
          await setStatus(turn, 'publishing', { nativeSessionId, outputTruncated: false });
          return {
            ...form,
            files,
            completed,
            nativeSessionId,
            outcome,
            requirements,
            displayOnly: true,
          };
        };
        const changed = () =>
          display(
            'The published questions changed before these answers could be applied. Your reply is saved. Review the current published file and ask AI-DLC to show the remaining questions.',
          );
        if (
          binding.workspaceSha256 !== snapshotIdentity(baseline.files) ||
          !current ||
          current.cursorHash !== binding.directive ||
          current.file.sha256 !== binding.sha256 ||
          !current.parsed
        )
          return changed();
        const form = ordinaryFileForm(current.parsed, fileMode ? null : session.fileQuestionIds);
        if (!form && !directCheckpoint)
          return display(
            'The current file contains a different or unsupported question layout. Your reply is retained. Open the published file and ask AI-DLC to present the current step.',
          );
        if (fileMode) {
          await recordAnswer(binding.issuedFile, modeLabel);
          if (fileMode === 'guide') await recordBatch(binding.issuedFile, form);
          return display(
            fileMode === 'guide'
              ? 'Answer the questions below. Use Other to answer in your own words.'
              : `Edit the answer slots in ${binding.path}.`,
            { ...form, fileStep: fileMode, questionFile: { ...binding } },
          );
        }
        return applySlots(current, display, changed);
      }
    };
    const publication = await applyFileReply();
    if (publication) return { publication };
    if (
      continuing &&
      (session.fileReady ||
        (session.checkpoint && !directCheckpoint) ||
        (session.fileStep === 'guide' && !payload.selection)) &&
      binding?.issuedFile
    ) {
      const current = currentQuestionFile(baseline, binding, configuration.harness);
      if (
        binding.workspaceSha256 !== snapshotIdentity(baseline.files) ||
        current?.file.sha256 !== binding.sha256 ||
        current.cursorHash !== binding.directive
      )
        fail('native_execution_file_answer_conflict');
    }
    if (
      continuing &&
      session.savedBatch &&
      selected?.selectedOptions.length === 1 &&
      choice === 0 &&
      !selected.freeText
    ) {
      const receipt = session.savedBatch;
      if (
        snapshotIdentity(baseline.files) !== binding.workspaceSha256 ||
        !(await openSavedBatch(receipt))
      )
        fail('native_execution_file_answer_conflict');
      await recordAnswer(receipt.source, receipt.details);
      appliedFile = { path: receipt.path, sha256: receipt.after, bytes: receipt.bytes };
    }
    return { appliedFile, directCheckpoint };
  };

  const invokeInstalledHarness = async (
    turn,
    { auth, baseEnv, forbiddenBytes, pkg, recoveredFile, appliedFile, plan, choice },
  ) => {
    const { owner, payload, activity: activityTurn } = turn;
    const configuration = payload.configuration;
    const continuing = payload.command === 'native-continue';
    const modelEnv = {
      ...auth,
      ...baseEnv,
      ...(appliedFile
        ? { NATIVE_APPLIED_QUESTION_FILE: appliedFile.path, AIDLC_UNATTENDED: '1' }
        : {}),
      ...(plan && choice !== undefined
        ? {
            NATIVE_SELECTED_PLAN_LABEL:
              turn.session.pendingInput.questions[0].options[choice].label,
          }
        : {}),
      ...(auth.AWS_REGION ? { AWS_REGION: auth.AWS_REGION } : {}),
      CLAUDE_CONFIG_DIR: join(owner.home, '.claude'),
      CODEX_HOME: join(owner.home, '.codex'),
      XDG_CONFIG_HOME: join(owner.home, '.config'),
      XDG_DATA_HOME: join(owner.home, '.data'),
      XDG_CACHE_HOME: join(owner.home, '.cache'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    const transport = await prepareNativeTransportInstructions({
      harness: configuration.harness,
      project,
      home: owner.home,
      instructions: [
        nativeTransportInstructions(configuration),
        ...(continuing && turn.session.pendingInput?.fileGuide && !payload.selection
          ? [
              'The member chose to discuss the published Guide me questions. Respond to their written question. Leave the file answers and batch receipt open until they submit settled answers. Follow the installed method to return to the current questions.',
            ]
          : []),
        ...(recoveredFile?.fileEdit
          ? [
              'The member saved file edits before the session stopped. Use the normal resume entrypoint. Stop at the remaining slots or ask for the file-mode completion signal. The fresh-session request does not supply that signal.',
            ]
          : []),
        attachmentPromptManifest(attachmentReferences(configuration.inputs.attachments)),
      ]
        .filter(Boolean)
        .join('\n\n'),
      env: modelEnv,
    });
    const prompt =
      payload.command === 'native-resume'
        ? nativeWorkspaceResumePrompt(configuration)
        : continuing
          ? payload.text
          : nativeFirstTurnPrompt({
              harness: configuration.harness,
              request: configuration.prompt,
            });
    const nextPromptEvidence =
      configuration.harness === 'kiro'
        ? await resolveKiroPromptEvidence({ project, prompt })
        : null;
    const output = createNativeTurnOutput({
      harness: configuration.harness,
      nativeSessionId: continuing ? turn.session.nativeSessionId : null,
      observeMethod: pkg.interactionContract === NATIVE_AIDLC_INTERACTION_CONTRACT,
      forbiddenBytes,
      onDiagnostic: (diagnostic) => {
        turn.report.outputDiagnostic = diagnostic;
        timing(turn, 'outputRejected', diagnostic);
      },
    });
    await setStatus(turn, 'running', { packageId: pkg.packageId });
    activityTurn.lifecycle({ title: 'Agent started' });
    // Recheck after package/credential preparation as well as at admission.
    // No workflow command is used to discover state or answer a pending offer.
    if (payload.command === 'native-resume') await assertCreatedWorkflow();
    const result = await run(
      turn,
      {
        ...nativeExecutionInvocation({
          harness: configuration.harness,
          model: configuration.model,
          prompt,
          project,
          nativeSessionId: continuing ? turn.session.nativeSessionId : null,
          promptEvidence: turn.session?.promptEvidence,
          priorAssistantSha256: turn.session?.priorAssistantSha256,
          ...transport.invocation,
        }),
        onStdoutChunk: (chunk) => {
          if (!turn.report.timings.firstOutput) timing(turn, 'firstOutput');
          output.write(chunk);
          return activityTurn.write(chunk);
        },
      },
      transport.env,
      true,
    );
    timing(turn, 'harnessCompleted');
    activityTurn.finishOutput();
    const completed = output.finish();
    return { result, completed, nextPromptEvidence };
  };

  const nextQuestionFileForm = async ({
    files,
    snapshotWorkspace,
    configuration,
    session,
    choice,
    pkg,
    beforeFiles,
    completed,
    rendered,
    appliedFile,
    directCheckpoint,
    recoveredFile,
    commands,
  }) => {
    const { method, recordBatch, openSavedBatch } = commands;
    if (appliedFile && !directCheckpoint) {
      const current = files.files.find((f) => f.path === appliedFile.path && f.role === 'question');
      if (!current || digest(current.content.subarray(0, appliedFile.bytes)) !== appliedFile.sha256)
        fail('native_execution_file_answer_conflict');
    }
    const guidedQuestions = session?.answerMode
      ? session.pendingInput.questions[0].options[choice]?.label === 'Guide me'
        ? session.questionFile
        : null
      : session?.guidedQuestions;
    let requirements =
      pkg.interactionContract === NATIVE_AIDLC_INTERACTION_CONTRACT &&
      nativeRequirementsForm({
        snapshot: files,
        beforeFiles,
        harness: configuration.harness,
        method: completed.method,
        guidedQuestions,
      });
    if (
      recoveredFile?.decision &&
      completed.method?.printed &&
      !requirements &&
      !rendered.spec &&
      files.files.find((f) => f.path === recoveredFile.path)?.sha256 === recoveredFile.after &&
      files.files.find(
        (f) => f.path === recoveredFile.path.split('/').slice(0, 5).join('/') + '/aidlc-state.md',
      )?.sha256 === recoveredFile.state &&
      (await openSavedBatch(recoveredFile))
    ) {
      const prompt = `Your answers are saved in ${recoveredFile.path}. AI-DLC still has this batch open. Use the saved answers to record the batch and continue, or discuss them first.`;
      const spec = {
        version: 2,
        questions: [
          { prompt, options: [{ label: 'Use my saved answers' }, { label: 'Discuss my answers' }] },
        ],
      };
      requirements = {
        spec,
        bytes: Buffer.byteLength(JSON.stringify(spec)),
        savedBatch: recoveredFile,
        questionFile: { path: recoveredFile.path },
      };
    }
    // On a resumed stage the installed directive explicitly names the kept
    // questions and the earlier recorded mode. The member need not choose it
    // again. A later ask, rejected command or recovery instruction wins.
    const issuedFile = completed.method?.stageFile;
    if (recoveredFile?.fileEdit) {
      const binding = {
        issuedFile: recoveredFile.source,
        state: recoveredFile.state,
        path: recoveredFile.path,
        sha256: recoveredFile.after,
      };
      const current = currentQuestionFile(files, binding, configuration.harness);
      if (current?.file.sha256 !== binding.sha256 || !current.parsed)
        fail('native_execution_file_answer_conflict');
      if (issuedFile?.path === binding.path && issuedFile.mode === 'file' && !requirements) {
        binding.directive = current.cursorHash;
        const remaining = ordinaryFileForm(current.parsed);
        if (remaining) requirements = { ...remaining, fileStep: 'file', questionFile: binding };
        else if (
          !current.parsed.blocks.some((b) => b.pending) &&
          !current.parsed.checkpoints.some((c) => !c.value)
        )
          requirements = fileCompletionForm(binding);
      }
    }
    await presentIssuedFile();
    return { files, requirements };
    async function presentIssuedFile() {
      if (
        !requirements &&
        !rendered.spec &&
        completed.method?.advanced &&
        issuedFile &&
        ['file', 'guide'].includes(issuedFile.mode)
      ) {
        const { evidence } = classifyNativeFirstWait({
          snapshot: files,
          harness: configuration.harness,
          issuedFile,
        });
        if (evidence) {
          const questionFile = {
            ...evidence.questions[0],
            state: evidence.state.sha256,
            directive: evidence.directive.sha256,
            issuedFile,
          };
          const current = currentQuestionFile(files, questionFile, configuration.harness);
          const form = ordinaryFileForm(current?.parsed);
          if (form) {
            let canPresent = true;
            if (issuedFile.mode === 'guide') {
              const ledger = JSON.parse(
                await method(['log', 'answers', ...questionScope(issuedFile)]),
              );
              canPresent =
                ledger.stage === issuedFile.stage &&
                ledger.ambiguous?.length === 0 &&
                (ledger.open?.length === 0 ||
                  (ledger.open?.length === 1 &&
                    ledger.open[0].question === form.ids.join(', ') &&
                    (ledger.open[0].unit ?? null) === issuedFile.unit &&
                    !ledger.open[0].workflow));
              if (canPresent && !ledger.open.length) {
                await recordBatch(issuedFile, form);
                files = await snapshotWorkspace('final');
                const checked = currentQuestionFile(files, questionFile, configuration.harness);
                if (checked?.file.sha256 !== questionFile.sha256)
                  fail('native_execution_reply_conflict');
                questionFile.directive = checked.cursorHash;
              }
            }
            if (canPresent) requirements = { ...form, questionFile, fileStep: issuedFile.mode };
          }
        }
      }
    }
  };

  const runNativeTurn = async (turn, { pkg, forbiddenBytes, auth, baseEnv }) => {
    const { owner, payload, signal, activity: activityTurn } = turn;
    const configuration = payload.configuration;
    const continuing = payload.command === 'native-continue';
    // A spec from an earlier turn must never describe this turn's question.
    await clearNativePendingSpec(project);
    activityTurn.lifecycle({ title: 'Inspecting workspace' });
    timing(turn, 'workspaceBaselineStarted');
    const snapshotWorkspace = (phase) =>
      snapshot({
        project,
        signal,
        forbiddenBytes,
        ...(phase === 'final' && owner.sourceBaseline?.receipt
          ? { identity: owner.identity, sourceBaseline: owner.sourceBaseline }
          : {}),
        filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
        onDiagnostic: (details) => {
          const safe = nativeSnapshotDiagnostic(details);
          if (!safe) return;
          turn.report.snapshotDiagnostic = { ...safe, phase };
          timing(turn, 'snapshotRejected', turn.report.snapshotDiagnostic);
        },
      });
    const plan = continuing ? turn.session.planAlternatives : null;
    const choice = payload.selection?.answers[0]?.selectedOptions[0];
    const showPlans =
      plan && (choice === undefined || (!plan.named && choice === plan.alternativeIndex));
    // A chooser has no child process. Publish the same quiescent workspace at
    // the new admitted sequence and leave the installed thread and request intact.
    if (showPlans) timing(turn, 'workspaceSnapshotStarted');
    const baseline = await snapshotWorkspace(showPlans ? 'final' : 'baseline');
    if (showPlans)
      timing(turn, 'workspaceSnapshotCompleted', {
        files: baseline.files.length,
        bytes: baseline.totalBytes,
      });
    const beforeFiles = baseline.files.map((file) => ({
      ...fileRef(file),
      bytes: file.content.length,
    }));
    timing(turn, 'workspaceBaselineCompleted', {
      files: baseline.files.length,
      bytes: baseline.totalBytes,
    });
    if (plan && snapshotIdentity(baseline.files) !== plan.workspaceSha256)
      fail('native_execution_reply_conflict');
    if (showPlans) {
      const spec = {
        version: 2,
        questions: [{ prompt: plan.prompt ?? 'Choose a plan.', options: plan.options }],
      };
      const completed = { messages: [{ type: 'text', text: spec.questions[0].prompt }] };
      const form = decodeNativeTurnInteraction({
        interactionContract: pkg.interactionContract,
        snapshot: baseline,
        rendered: { spec, bytes: Buffer.byteLength(JSON.stringify(spec)) },
        messages: completed.messages,
        forbiddenBytes,
        onDiagnostic: (details) => timing(turn, 'questionPresentation', details),
      });
      if (!form.pendingInput) fail('native_execution_reply_conflict');
      const nativeSessionId = turn.session.nativeSessionId;
      await setStatus(turn, 'publishing', { nativeSessionId, outputTruncated: false });
      return {
        ...form,
        completed,
        nativeSessionId,
        files: baseline,
        outcome: {
          kind: 'stopped_needs_review',
          code: 'native_wait_format_unrecognized',
          methodReport: null,
        },
        planAlternatives: { ...plan, named: true },
        displayOnly: true,
      };
    }
    const session = turn.session;
    const commands = questionCommands(turn, baseEnv);
    const { publication, appliedFile, directCheckpoint } = await prepareQuestionReply(turn, {
      baseline,
      snapshotWorkspace,
      pkg,
      forbiddenBytes,
      commands,
      choice,
    });
    if (publication) return publication;
    const recoveredFile = await reconciledQuestionFile(turn, baseline);
    const { result, completed, nextPromptEvidence } = await invokeInstalledHarness(turn, {
      auth,
      baseEnv,
      forbiddenBytes,
      pkg,
      recoveredFile,
      appliedFile,
      plan,
      choice,
    });
    activityTurn.lifecycle({ title: 'Checking completed workspace' });
    await checkDirectories(owner);
    const formDiagnostic = (details) => {
      recordNativeBoundary(owner.identity, 'questionPresentation', Date.now(), {
        sequence: turn.report.sequence,
        writerGeneration: owner.writerGeneration,
        ...details,
      });
    };
    const rendered = await readNativePendingSpec(project, {
      forbiddenBytes,
      onDiagnostic: formDiagnostic,
    });
    timing(turn, 'workspaceSnapshotStarted');
    let files = await snapshotWorkspace('final');
    timing(turn, 'workspaceSnapshotCompleted', {
      files: files.files.length,
      bytes: files.totalBytes,
    });
    const nextFile = await nextQuestionFileForm({
      files,
      snapshotWorkspace,
      configuration,
      session,
      choice,
      pkg,
      beforeFiles,
      completed,
      rendered,
      appliedFile,
      directCheckpoint,
      recoveredFile,
      commands,
    });
    files = nextFile.files;
    let requirements = nextFile.requirements;
    const currentForm = requirements || observedTurnForm(completed, rendered, plan, null, files);
    if (currentForm === completed.method?.planApproval)
      requirements = { planApprovalWorkspace: snapshotIdentity(files.files) };
    const { pendingInput, presentation } = decodeNativeTurnInteraction({
      interactionContract: pkg.interactionContract,
      snapshot: files,
      rendered: currentForm,
      messages: completed.messages,
      forbiddenBytes,
      onDiagnostic: (diagnostic) => {
        turn.report.presentation = diagnostic;
        formDiagnostic(diagnostic);
      },
    });
    const nativeSessionId = completed.nativeSessionId;
    let outcome = classifyNativeFirstWait({
      snapshot: files,
      harness: configuration.harness,
      beforeFiles: requirements ? [] : beforeFiles,
    });
    outcome = {
      ...outcome,
      // A terminal command can supersede an earlier display. A surviving
      // question file makes the ordering ambiguous for a completion report.
      methodReport: nativeMethodReport(files, completed.method, pendingInput ?? rendered.spec),
      nativeSessionId,
      outputTruncated: result.outputLimitExceeded === true,
    };
    checkCancelled(turn);
    await setStatus(turn, 'publishing', {
      nativeSessionId,
      outputTruncated: outcome.outputTruncated,
    });
    return {
      completed,
      files,
      pendingInput,
      presentation: outcome.methodReport ? null : presentation,
      nativeSessionId,
      outcome,
      nextPromptEvidence,
      planAlternatives: pendingInput && offeredPlanAlternatives(currentForm),
      requirements,
    };
  };

  // Public receipts complete before the local head moves.
  const publishNativeTurn = async (
    turn,
    { pkg },
    {
      completed,
      files,
      pendingInput,
      presentation,
      nativeSessionId,
      outcome,
      nextPromptEvidence,
      planAlternatives,
      requirements,
      displayOnly,
    },
  ) => {
    const { owner, signal, activity: activityTurn } = turn;
    const configuration = turn.payload.configuration;
    const publicationOutcome =
      outcome.kind === 'waiting_for_input' ? 'WAITING_FOR_INPUT' : 'STOPPED';
    const questionPath = outcome.evidence?.questions[0]?.path ?? null;
    activityTurn.lifecycle({ title: 'Saving workflow files' });
    timing(turn, 'publicationStarted', { files: files.files.length, bytes: files.totalBytes });
    const uploaded = await publish({
      identity: owner.identity,
      sequence: turn.report.sequence,
      packageId: pkg.packageId,
      nativeSessionId,
      outcome: publicationOutcome,
      ...(outcome.methodReport ? { methodReport: outcome.methodReport } : {}),
      repository: {
        branch: configuration.repository.branch,
        commit: configuration.repository.commit,
      },
      files: files.files,
      git: files.git,
      filesystemPolicy: files.filesystemPolicy,
      ...(owner.sourceBaseline ? { sourceBaseline: owner.sourceBaseline } : {}),
      questionPath,
      signal,
    });
    checkCancelled(turn);
    timing(turn, 'publicationCompleted', { files: files.files.length, bytes: files.totalBytes });
    const publication = uploaded?.receipt;
    if (
      uploaded?.uploaded !== true ||
      !/^[a-f0-9]{64}$/.test(publication?.id ?? '') ||
      publication.sequence !== turn.report.sequence ||
      publication.outcome !== publicationOutcome ||
      publication.nativeSessionId !== nativeSessionId ||
      publication.filesCount !== files.files.length ||
      !publication.manifest ||
      publication.manifest.sha256 !== publication.id ||
      !safeText(publication.manifest.key, 4096) ||
      !safeText(publication.manifest.versionId, 1024) ||
      !Number.isSafeInteger(publication.manifest.bytes) ||
      publication.manifest.bytes < 1 ||
      (questionPath
        ? publication.question?.path !== questionPath ||
          publication.question?.sha256 !== outcome.evidence.questions[0].sha256
        : publication.question !== null)
    )
      fail('native_execution_publication_unconfirmed');
    // Copy only the documented receipt, never arbitrary callback properties
    // (such as a request context, SDK metadata or credential-bearing debug).
    const receipt = {
      id: publication.id,
      sequence: publication.sequence,
      manifest: Object.fromEntries(
        ['key', 'versionId', 'sha256', 'bytes'].map((key) => [key, publication.manifest[key]]),
      ),
      question: publication.question
        ? {
            path: publication.question.path,
            sha256: publication.question.sha256,
          }
        : null,
      outcome: publication.outcome,
      nativeSessionId: publication.nativeSessionId,
      filesCount: publication.filesCount,
    };
    timing(turn, 'interactionUploadStarted');
    activityTurn.lifecycle({ title: 'Saving response and form' });
    const saveInteraction = async (input, display) => {
      const interaction = nativeInteractionReceipt(
        await publishInteraction({
          identity: owner.identity,
          packageId: pkg.packageId,
          sequence: turn.report.sequence,
          harness: configuration.harness,
          nativeSessionId,
          publicationId: receipt.id,
          messages: completed.messages,
          pendingInput: input,
          presentation: display,
          signal,
        }),
        owner.identity,
      );
      checkCancelled(turn);
      if (
        interaction.sequence !== receipt.sequence ||
        interaction.publicationId !== receipt.id ||
        interaction.nativeSessionId !== nativeSessionId
      )
        fail('native_execution_interaction_unconfirmed');
      return interaction;
    };
    const interaction = await saveInteraction(pendingInput, presentation);
    timing(turn, 'interactionUploadCompleted');
    const continuation = {
      pendingInput,
      answerMode: requirements?.answerMode,
      questionFile: requirements?.questionFile
        ? { ...requirements.questionFile, workspaceSha256: snapshotIdentity(files.files) }
        : null,
      guidedQuestions: requirements && !requirements.answerMode ? requirements.questionFile : null,
      fileStep: requirements?.fileStep,
      fileQuestionIds: requirements?.ids,
      fileDecision: requirements?.decision,
      savedBatch: requirements?.savedBatch,
      planApprovalWorkspace: requirements?.planApprovalWorkspace,
      fileReady: requirements?.fileReady,
      checkpoint: requirements?.checkpoint,
      planAlternatives: planAlternatives
        ? { ...planAlternatives, workspaceSha256: snapshotIdentity(files.files) }
        : null,
      promptEvidence: displayOnly ? turn.session.promptEvidence : (nextPromptEvidence ?? null),
      priorAssistantSha256: displayOnly
        ? turn.session.priorAssistantSha256
        : kiroAssistantHash(completed.messages.map((message) => message.text).join('')),
    };
    await setStatus(turn, 'publication_ready', {
      activityMeasurements: turn.activity.measurements(),
      outcome: publicationOutcome,
      waitEvidence: outcome.evidence ?? null,
      stopCode: outcome.code,
      receipt,
      interaction,
    });
    checkCancelled(turn);
    turn.nextSession = Object.freeze({ nativeSessionId, ...continuation });
  };

  const execute = async (turn) => {
    const { owner } = turn;
    turn.report.timings = { accepted: turn.report.updatedAt };
    recordNativeBoundary(owner.identity, 'accepted', turn.report.updatedAt, {
      sequence: turn.report.sequence,
      writerGeneration: owner.writerGeneration,
    });
    try {
      checkCancelled(turn);
      const prepared = await prepareNativeTurn(turn);
      const result = await runNativeTurn(turn, prepared);
      await publishNativeTurn(turn, prepared, result);
    } catch (error) {
      // Never expose raw port/subprocess errors (which may contain credentials).
      const code = nativeRuntimeFailureCode(error);
      // Preparation also runs owned Git commands. Missing proof in either
      // phase takes precedence over a concurrent cancellation.
      if (code === 'native_execution_cleanup_incomplete') owner.poisoned = true;
      turn.report = {
        ...turn.report,
        status: owner.poisoned
          ? 'stopped_needs_review'
          : turn.signal.aborted || code === 'native_execution_cancelled'
            ? 'cancelled'
            : 'failed',
        code,
        updatedAt: Date.now(),
      };
      recordNativeBoundary(owner.identity, 'executionFailed', turn.report.updatedAt, {
        code,
        sequence: turn.report.sequence,
        writerGeneration: owner.writerGeneration,
      });
      // Unconfirmed subprocess cleanup must halt all subsequent filesystem
      // reads/writes: a surviving writer could race the supervisor.
      if (!owner.poisoned) {
        try {
          await persist(turn);
        } catch {
          turn.report.status = 'stopped_needs_review';
          turn.report.code = 'native_execution_status_unconfirmed';
        }
      }
    } finally {
      turn.activity?.close({ failed: turn.report.status !== 'publication_ready' });
      releaseTurn(turn);
    }
  };
  const scheduleTurn = (turn) => {
    // Every entrypoint reaches this boundary only after durable admission.
    // Capture this turn, not the owner's next mutable turn pointer.
    turn.task = new Promise((resolveTask) => setImmediate(() => resolveTask(execute(turn))));
  };
  const readExisting = async (identity, generation = 1) => {
    try {
      const directory = directoryForGeneration(generation);
      const paths = [root, control, directory];
      const before = await Promise.all(paths.map(privateDirectory));
      const owner = await readLocalRecord(join(directory, 'owner.json'));
      for (let i = 0; i < paths.length; i++) {
        if (!sameNode(before[i], await privateDirectory(paths[i])))
          fail('native_execution_directory_changed');
      }
      if (!sameIdentity(owner.identity ?? {}, identity)) fail('native_execution_owner_conflict');
      if (generationOf(owner) !== generation) fail('native_execution_owner_conflict');
      if (owner.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(owner.configurationSha256 ?? ''))
        fail('native_execution_owner_invalid');
      return { schemaVersion: 1, identity, configurationSha256: owner.configurationSha256 };
    } catch (error) {
      if (/^native_execution_[a-z_]{1,64}$/.test(error?.code ?? '')) throw error;
      fail('native_execution_local_record_unavailable');
    }
  };
  const createFreshHome = async (identity, generation, directories) => {
    await fs.mkdir(homeRoot, { recursive: true, mode: 0o700 });
    directories.set(homeRoot, await privateDirectory(homeRoot));
    const bindingHome = join(homeRoot, identity.bindingId);
    await fs.mkdir(bindingHome, { mode: 0o700 }).catch((error) => {
      if (generation === 1 || error.code !== 'EEXIST') throw error;
    });
    directories.set(bindingHome, await privateDirectory(bindingHome));
    const home = join(
      bindingHome,
      generation === 1 ? identity.attemptId : `${identity.attemptId}-writer-${generation}`,
    );
    directories.set(home, await createPrivateDirectory(home));
    await createPrivateDirectory(join(home, '.codex'));
    await fs.writeFile(
      join(home, '.codex/config.toml'),
      `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return home;
  };
  const status = async (value) => {
    const identity = validateIdentity(value);
    const writerGeneration = generationOf(value);
    if (activeOwner) {
      if (
        !sameIdentity(activeOwner.identity, identity) ||
        activeOwner.writerGeneration !== writerGeneration
      )
        fail('native_execution_owner_conflict');
      const observation = {
        workflowResumeState: await workspaceResumeObservation(
          identity,
          activeOwner.configurationSha256,
        ),
      };
      return { ...report(activeOwner.turn), ...observation };
    }
    const savedOwner = await readExisting(identity, writerGeneration);
    const observation = {
      workflowResumeState: await workspaceResumeObservation(
        identity,
        savedOwner.configurationSha256,
      ),
    };
    // Restore completed upload evidence or fixed initialization diagnostics.
    // Neither is authority or permission to start a new writer on restart.
    try {
      const saved = await readLocalRecord(
        join(directoryForGeneration(writerGeneration), 'status.json'),
      );
      if (generationOf(saved) !== writerGeneration) fail('native_execution_owner_conflict');
      if (
        saved.schemaVersion === 1 &&
        sameIdentity(saved, identity) &&
        saved.status === 'failed' &&
        saved.code === 'native_execution_initialization_unverified'
      ) {
        return {
          schemaVersion: 1,
          ...identity,
          writerGeneration,
          status: 'failed',
          code: 'native_execution_initialization_unverified',
          initializationChecks: nativeInitializationCheckStatuses(saved.initializationChecks),
          ...(nativeInitializationBaselineReason(saved.initializationBaselineReason)
            ? { initializationBaselineReason: saved.initializationBaselineReason }
            : {}),
          recovered: true,
          ...observation,
        };
      }
      if (
        saved.schemaVersion === 1 &&
        sameIdentity(saved, identity) &&
        saved.status === 'publication_ready' &&
        ['WAITING_FOR_INPUT', 'STOPPED'].includes(saved.outcome) &&
        ((saved.outcome === 'STOPPED' && saved.nativeSessionId === null) ||
          ID.test(saved.nativeSessionId ?? '')) &&
        saved.receipt?.nativeSessionId === saved.nativeSessionId &&
        saved.receipt?.outcome === saved.outcome &&
        /^[a-f0-9]{64}$/.test(saved.receipt?.id ?? '') &&
        saved.receipt?.manifest?.sha256 === saved.receipt.id
      ) {
        const interaction = nativeInteractionReceipt(saved.interaction, identity);
        if (
          interaction.sequence !== saved.sequence ||
          interaction.sequence !== saved.receipt.sequence ||
          interaction.nativeSessionId !== saved.nativeSessionId ||
          interaction.publicationId !== saved.receipt.id
        )
          fail('native_execution_interaction_unconfirmed');
        return {
          schemaVersion: 1,
          ...identity,
          writerGeneration,
          status: 'publication_ready',
          ...(saved.activityProtocol === NATIVE_ACTIVITY_CAPABILITY
            ? { capabilities: [NATIVE_ACTIVITY_CAPABILITY] }
            : {}),
          nativeSessionId: saved.nativeSessionId,
          outcome: saved.outcome,
          receipt: saved.receipt,
          interaction,
          sequence: saved.sequence,
          ...(saved.requestId ? { requestId: saved.requestId } : {}),
          waitEvidence: saved.waitEvidence ?? null,
          recovered: true,
          ...observation,
        };
      }
    } catch {
      /* Missing/incomplete status cannot authorize replay. */
    }
    return {
      schemaVersion: 1,
      ...identity,
      writerGeneration,
      status: 'stopped_needs_review',
      code: 'native_execution_existing_owner',
      ...observation,
    };
  };
  const start = async (value) => {
    const input = structuredClone(value);
    const identity = validateIdentity(input);
    const writerGeneration = generationOf(input);
    nativeRuntimeCommand(input, 'native-start');
    const configuration = canonicalConfig(input.configuration);
    const configurationSha256 = digest(JSON.stringify(configuration));
    if (admitting) fail('native_execution_busy');
    if (activeOwner) {
      if (
        !sameIdentity(activeOwner.identity, identity) ||
        activeOwner.configurationSha256 !== configurationSha256
      )
        fail('native_execution_owner_conflict');
      return { ...report(activeOwner.turn), accepted: true, duplicate: true };
    }
    const ownerDirectory = directoryForGeneration(writerGeneration);
    admitting = true;
    try {
      await inspectMount({ workspaceDir: root });
      const directories = new Map([[root, await privateDirectory(root)]]);
      await fs.mkdir(control, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      directories.set(control, await privateDirectory(control));
      try {
        directories.set(ownerDirectory, await createPrivateDirectory(ownerDirectory));
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const savedOwner = await readExisting(identity);
        if (savedOwner.configurationSha256 !== configurationSha256)
          fail('native_execution_owner_conflict');
        return {
          schemaVersion: 1,
          ...identity,
          writerGeneration,
          accepted: false,
          duplicate: true,
          status: 'stopped_needs_review',
          code: 'native_execution_existing_owner',
        };
      }
      activeOwner = createOwner({
        identity,
        writerGeneration,
        configurationSha256,
        directories,
      });
      const turn = createTurn(activeOwner, { ...input, configuration });
      activeOwner.turn = turn;
      await writeJson(activeOwner, join(ownerDirectory, 'owner.json'), {
        schemaVersion: 1,
        identity,
        writerGeneration,
        configurationSha256,
      });
      await syncDirectory(control);
      await syncDirectory(root);
      // These must be new. Existing project/install/home residue never grants
      // permission to silently reuse an old checkout or launch a second writer.
      for (const path of [
        project,
        join(root, 'machine'),
        join(root, 'machine/data'),
        join(root, 'machine/bin'),
      ])
        directories.set(path, await createPrivateDirectory(path));
      activeOwner.home = await createFreshHome(identity, writerGeneration, directories);
      await persist(turn);
      scheduleTurn(turn);
      return { ...report(turn), accepted: true, duplicate: false };
    } catch (error) {
      if (activeOwner) {
        activeOwner.turn.report.status = 'stopped_needs_review';
        activeOwner.turn.report.code = 'native_execution_start_incomplete';
        releaseTurn(activeOwner.turn);
      }
      if (/^native_execution_[a-z_]{1,64}$/.test(error?.code ?? '')) throw error;
      fail('native_execution_start_failed');
    } finally {
      admitting = false;
    }
  };
  const resumeWorkspace = async (value) => {
    const input = structuredClone(value);
    const identity = validateIdentity(input);
    const writerGeneration = generationOf(input);
    nativeRuntimeCommand(input, 'native-resume');
    const configuration = canonicalConfig(input.configuration);
    const configurationSha256 = digest(JSON.stringify(configuration));
    const controller = new AbortController();
    if (
      input.imageDigest !== env.NATIVE_EXECUTION_IMAGE_DIGEST ||
      ![assertRecoveryAdmission, prepareRecovery, prepareContinuation].every(
        (port) => typeof port === 'function',
      )
    )
      fail('native_execution_request_invalid');
    if (admitting) fail('native_execution_busy');
    if (activeOwner) {
      if (
        activeOwner.poisoned ||
        !sameIdentity(activeOwner.identity, identity) ||
        activeOwner.writerGeneration !== writerGeneration ||
        activeOwner.configurationSha256 !== configurationSha256 ||
        activeOwner.turn.report.recoveryId !== input.recoveryId ||
        activeOwner.turn.report.sequence !== input.sequence
      )
        fail('native_execution_owner_conflict');
      return { ...report(activeOwner.turn), accepted: true, duplicate: true };
    }
    admitting = true;
    try {
      await assertRecoveryAdmission({
        identity,
        writerGeneration,
        recoveryId: input.recoveryId,
        recoveryMode: configuration.recoveryMode,
        signal: controller.signal,
      });
      await inspectMount({ workspaceDir: root });
      const previous = await readExisting(identity, writerGeneration - 1);
      const workspace = await readLocalRecord(join(control, 'workspace.json'));
      if (
        previous.configurationSha256 !== configurationSha256 ||
        workspace.schemaVersion !== 1 ||
        !sameIdentity(workspace.identity ?? {}, identity) ||
        workspace.configurationSha256 !== configurationSha256 ||
        !/^sha256:[a-f0-9]{64}$/.test(workspace.packageId ?? '')
      )
        fail('native_execution_workspace_invalid');
      const directories = new Map();
      for (const [name, path] of [
        ['root', root],
        ['project', project],
        ['machine', join(root, 'machine')],
      ]) {
        const node = await privateDirectory(path);
        if (String((await fs.lstat(path, { bigint: true })).ino) !== workspace.nodes?.[name]?.ino)
          fail('native_execution_workspace_invalid');
        directories.set(path, node);
      }
      for (const path of [control, join(root, 'machine/data'), join(root, 'machine/bin')])
        directories.set(path, await privateDirectory(path));
      await assertCreatedWorkflow();
      const ownerDirectory = directoryForGeneration(writerGeneration);
      // An existing cold owner may already have delivered this resume action.
      // Never reconstruct its ACK or execute it again; require another stopped,
      // explicitly confirmed generation through the authority.
      try {
        directories.set(ownerDirectory, await createPrivateDirectory(ownerDirectory));
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await readExisting(identity, writerGeneration);
        if (existing.configurationSha256 !== configurationSha256)
          fail('native_execution_owner_conflict');
        return {
          schemaVersion: 1,
          ...identity,
          writerGeneration,
          recoveryId: input.recoveryId,
          status: 'stopped_needs_review',
          code: 'native_execution_existing_owner',
          accepted: false,
          duplicate: true,
          workflowResumeState: await workspaceResumeObservation(identity, configurationSha256),
        };
      }
      activeOwner = createOwner({
        identity,
        writerGeneration,
        configurationSha256,
        directories,
        controller,
      });
      activeOwner.sourceBaseline = workspace.sourceBaseline;
      const turn = createTurn(
        activeOwner,
        { ...input, configuration },
        {
          workspacePackageId: workspace.packageId,
        },
      );
      activeOwner.turn = turn;
      await writeJson(activeOwner, join(ownerDirectory, 'owner.json'), {
        schemaVersion: 1,
        identity,
        writerGeneration,
        configurationSha256,
      });
      await syncDirectory(control);
      activeOwner.home = await createFreshHome(identity, writerGeneration, directories);
      await persist(turn);
      scheduleTurn(turn);
      return { ...report(turn), accepted: true, duplicate: false };
    } catch (error) {
      if (activeOwner) {
        activeOwner.poisoned = true;
        activeOwner.turn.report.status = 'stopped_needs_review';
        activeOwner.turn.report.code = 'native_execution_workspace_invalid';
        releaseTurn(activeOwner.turn);
      }
      if (error?.code === 'EEXIST') fail('native_execution_existing_owner');
      if (/^native_execution_[a-z_]{1,64}$/.test(error?.code ?? '')) throw error;
      fail('native_execution_workspace_invalid');
    } finally {
      admitting = false;
    }
  };
  const continueTurn = async (value) => {
    const input = structuredClone(value);
    const identity = validateIdentity(input);
    const writerGeneration = generationOf(input);
    nativeRuntimeCommand(input, 'native-continue');
    const configuration = canonicalConfig(input.configuration);
    const configurationSha256 = digest(JSON.stringify(configuration));
    // Cold recovery is observation only. A local record never grants a fresh
    // writer ownership, even if the caller supplies apparently valid receipts.
    if (!activeOwner || activeOwner.poisoned) fail('native_execution_existing_owner');
    if (
      !sameIdentity(activeOwner.identity, identity) ||
      activeOwner.writerGeneration !== writerGeneration ||
      activeOwner.configurationSha256 !== configurationSha256
    )
      fail('native_execution_owner_conflict');
    if (admitting) fail('native_execution_busy');
    const requestHash = digest(
      JSON.stringify({
        identity,
        configurationSha256,
        sequence: input.sequence,
        requestId: input.requestId,
        priorInteractionId: input.priorInteractionId,
        priorPublicationId: input.priorPublicationId,
        textSha256: digest(input.text),
        ...(input.selection ? { selection: input.selection } : {}),
      }),
    );
    const requestPath = join(activeOwner.directory, `request-${input.requestId}.json`);
    let admissionStarted = false;
    let turn;
    admitting = true;
    try {
      await checkDirectories(activeOwner);
      let prior;
      try {
        prior = await readLocalRecord(requestPath);
      } catch (error) {
        if (error.code !== 'ENOENT') fail('native_execution_local_record_invalid');
      }
      if (prior) {
        if (
          prior.requestHash !== requestHash ||
          prior.ack?.requestId !== input.requestId ||
          prior.ack?.sequence !== input.sequence ||
          !sameIdentity(prior.ack ?? {}, identity)
        )
          fail('native_execution_reply_conflict');
        return { ...prior.ack, duplicate: true };
      }
      const previous = activeOwner.turn;
      checkCancelled(previous);
      if (previous.task) fail('native_execution_busy');
      if (
        typeof prepareContinuation !== 'function' ||
        previous.report.status !== 'publication_ready' ||
        !previous.nextSession ||
        previous.report.sequence + 1 !== input.sequence ||
        previous.report.receipt?.id !== input.priorPublicationId ||
        previous.report.interaction?.id !== input.priorInteractionId
      )
        fail('native_execution_reply_conflict');
      if (input.selection) {
        try {
          if (nativeAnswerText(previous.nextSession.pendingInput, input.selection) !== input.text)
            fail('native_execution_reply_conflict');
        } catch {
          fail('native_execution_reply_conflict');
        }
      }
      turn = createTurn(
        activeOwner,
        { ...input, configuration },
        { session: previous.nextSession },
      );
      const ack = { ...turn.report, accepted: true, duplicate: false };
      // Immutable idempotency record, without reply text or credentials. If
      // later persistence fails it is deliberately not safe to replay a writer.
      admissionStarted = true;
      await writeJson(activeOwner, requestPath, { requestHash, ack });
      checkCancelled(turn);
      activeOwner.turn = turn;
      await persist(turn);
      checkCancelled(turn);
      scheduleTurn(turn);
      return structuredClone(ack);
    } catch (error) {
      if (admissionStarted) {
        // A request file may already exist even if write/fsync/rename failed.
        // Do not accept its stored ACK or advertise a writer that was never
        // scheduled. Further writes, including automatic replay, are forbidden.
        activeOwner.poisoned = true;
        activeOwner.turn = turn;
        turn.report = {
          schemaVersion: 1,
          ...identity,
          writerGeneration,
          sequence: input.sequence,
          requestId: input.requestId,
          status: 'stopped_needs_review',
          code: 'native_execution_reply_admission_unconfirmed',
          updatedAt: Date.now(),
        };
        releaseTurn(turn);
        fail('native_execution_reply_admission_unconfirmed');
      }
      if (/^native_execution_[a-z_]{1,64}$/.test(error?.code ?? '')) throw error;
      fail('native_execution_start_failed');
    } finally {
      admitting = false;
    }
  };
  const cancel = async (value) => {
    const identity = validateIdentity(value);
    if (!activeOwner) return status(value);
    if (
      !sameIdentity(activeOwner.identity, identity) ||
      activeOwner.writerGeneration !== generationOf(value)
    )
      fail('native_execution_owner_conflict');
    const turn = activeOwner.turn;
    if (!ACTIVE.has(turn.report.status) && turn.report.status !== 'publication_ready')
      return report(turn);
    activeOwner.controller.abort();
    if (turn.report.status === 'publication_ready' && !turn.task && !admitting) {
      turn.report = { ...turn.report, status: 'cancelled', updatedAt: Date.now() };
      // There is no active child or execute() persistence owner at this point.
      await persist(turn);
      return report(turn);
    }
    turn.report = { ...turn.report, status: 'cancelling', updatedAt: Date.now() };
    // execute owns persistence, serialized after child cleanup; do not race it.
    return report(turn);
  };
  const activity = async (value) => {
    const identity = validateIdentity(value);
    const writerGeneration = generationOf(value);
    if (!Number.isSafeInteger(value.after) || value.after < 0)
      fail('native_execution_request_invalid');
    if (activeOwner) {
      if (
        !sameIdentity(activeOwner.identity, identity) ||
        activeOwner.writerGeneration !== writerGeneration
      )
        fail('native_execution_owner_conflict');
      return { ...identity, ...activityLog(activeOwner.turn).pull(value.after) };
    }
    await readExisting(identity, writerGeneration);
    const saved = readNativeActivitySpool({
      spoolDirectory: join(directoryForGeneration(writerGeneration), 'activity'),
      writerGeneration,
      after: value.after,
    });
    if (!saved) fail('native_execution_local_record_unavailable');
    return { ...identity, ...saved };
  };
  return {
    activity,
    start,
    continue: continueTurn,
    resume: resumeWorkspace,
    status,
    cancel,
    isBusy: () => admitting || activeOwner?.poisoned === true || Boolean(activeOwner?.turn?.task),
    settle: async () => {
      const turn = activeOwner?.turn;
      await turn?.task;
      return turn ? report(turn) : null;
    },
  };
};
