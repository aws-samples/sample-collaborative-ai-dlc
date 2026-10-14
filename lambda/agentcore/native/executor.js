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
  buildNativePendingInput,
  NATIVE_PENDING_INPUT_LIMITS,
} from '../../shared/native-pending-input.js';
import { NATIVE_RECOVERY_LIMITS } from '../../shared/native-recovery-checkpoint.js';
import { createNativeTurnOutput } from './turn-output.js';
import { resolveKiroPromptEvidence } from './kiro-prompt.js';
import { kiroAssistantHash } from './kiro-acp-turn.js';
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
import { snapshotNativeExecutionFiles } from './execution-files.js';
import {
  captureNativeSessionRecovery,
  restoreNativeSessionRecovery,
} from './session-recovery-files.js';

const HARNESSES = ['claude', 'codex', 'kiro', 'opencode'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;
const SCOPE = ['projectId', 'executionId', 'bindingId'];
const IDENTITY = [...SCOPE, 'attemptId', 'epoch', 'runtimeSessionId'];
const ACTIVE = new Set(['preparing', 'running', 'publishing', 'recovering', 'cancelling']);
const HOST_PATH =
  '/opt/kiro/bin:/opt/opencode/bin:/opt/bun/bin:/opt/uv/bin:/usr/local/bin:/usr/bin:/bin';
const BINARIES = {
  claude: '/usr/local/bin/claude',
  codex: '/usr/local/bin/codex',
  opencode: '/opt/opencode/bin/opencode',
};
const RECOVERY_CAPTURE_LIMITS = Object.freeze({
  maxFiles: NATIVE_RECOVERY_LIMITS.files,
  maxEntries: NATIVE_RECOVERY_LIMITS.entries,
  maxFileBytes: NATIVE_RECOVERY_LIMITS.fileBytes,
  maxTotalBytes: NATIVE_RECOVERY_LIMITS.totalBytes,
  maxDepth: NATIVE_RECOVERY_LIMITS.depth,
});
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
const segment = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameIdentity = (a, b) => IDENTITY.every((key) => a[key] === b[key]);
const within = (base, path) => path === base || path.startsWith(`${base}/`);
const identityOf = (payload) => Object.fromEntries(IDENTITY.map((key) => [key, payload[key]]));

export const nativeFirstTurnPrompt = ({ harness, request } = {}) => {
  if (!HARNESSES.includes(harness)) fail('native_execution_harness_invalid');
  // Codex expands a named skill from $aidlc in exec as well as interactive mode.
  const marker = harness === 'codex' ? '$aidlc' : '/aidlc';
  return (
    `${marker} ${request}\n\n` +
    'Platform transport instruction: The request above is the exact user request. ' +
    'Start a new native AI-DLC workflow using its normal filesystem artifacts. ' +
    'Do not invent missing scope, requirements, or human answers. At the first workflow ' +
    'question or approval that needs a person, present the complete proposal and questions ' +
    'in your normal assistant response, preserve any normal workflow artifacts, leave ' +
    'the native workflow waiting, and end this turn. The platform will show your response and files to ' +
    'the user. Do not approve a gate, answer on behalf of the user, or continue past that wait. ' +
    NATIVE_PENDING_SPEC_INSTRUCTION +
    NATIVE_INTAKE_ANSWER_INSTRUCTION
  );
};

// The pinned engine's intake plan offer is a bare `ask` emitted before any
// workflow state exists, so `report --user-input` cannot record it. The engine
// contract (aidlc-orchestrate.ts Branch 8) is to re-run `next` with the choice:
// `next compose` reaches the composer (Branch 4c), `--scope` creation (9a).
const NATIVE_INTAKE_ANSWER_INSTRUCTION =
  " If the question was the engine's plan offer made before any workflow state exists " +
  '(no aidlc-state.md yet), then when the user replies, record their choice by re-running ' +
  'the engine with the chosen plan in front of the original request text, passed unchanged ' +
  'as one shell-safe argument: `aidlc engine orchestrate next compose <original request>` for ' +
  'compose, or `aidlc engine orchestrate next --scope <plan> <original request>` for a named ' +
  'plan. Do not use report for that answer.';

// Task-3 structured questions. The workflow renders each human question from a
// `question` spec; the platform asks for that same spec so members can select
// options instead of typing numbers. The file is display data only: options are
// validated against the visible response, and the member's reply is still the
// only answer. It lives in a reserved, unpublished project directory.
export const NATIVE_PENDING_SPEC_PATH = '.native-control/pending-question.json';
const NATIVE_PENDING_SPEC_INSTRUCTION =
  'Whenever you end a turn with a structured question or approval for the user, also write ' +
  `the exact question spec you rendered as JSON to ${NATIVE_PENDING_SPEC_PATH} in the project ` +
  'directory, replacing any earlier file: {"version":1,"questions":[{"prompt":"...","header":"...",' +
  '"multiSelect":false,"options":[{"label":"...","description":"..."}]}]}. Use the exact option ' +
  'labels from the spec, without numbers, letters or "(Recommended)", and keep rendering the ' +
  "question normally in your response. The user's reply will contain the exact selected " +
  'label(s); record it with the workflow command that question requires.';

/** Stage held at an engine approval gate ([?]) in this snapshot, or null. */
export const nativeGateFromSnapshot = (snapshot) => {
  try {
    const files = new Map(snapshot.files.map((file) => [file.path, file]));
    const read = (path) => {
      const file = files.get(path);
      if (!file) throw new Error('missing');
      return new TextDecoder('utf-8', { fatal: true }).decode(file.content);
    };
    const space = read('aidlc/active-space').trim();
    if (!segment(space)) return null;
    const intent = read(`aidlc/spaces/${space}/intents/active-intent`).trim();
    if (!segment(intent)) return null;
    const state = read(`aidlc/spaces/${space}/intents/${intent}/aidlc-state.md`);
    const stages = [...state.matchAll(/^- \*\*Current Stage\*\*:\s*([a-z][a-z0-9-]*)[ \t]*$/gm)];
    if (stages.length !== 1) return null;
    const stage = stages[0][1];
    const held = state
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`- [?] ${stage} `) || line === `- [?] ${stage}`);
    return held.length === 1 ? { stage } : null;
  } catch {
    return null;
  }
};

// The reserved spec directory must be a real directory inside the project; the
// file is read without following links, bounded, and removed after each read.
const pendingSpecDirectory = async (project) => {
  const dir = join(project, '.native-control');
  try {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory()) {
      await fs.rm(dir, { force: true });
      await fs.mkdir(dir, { mode: 0o700 });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(dir, { mode: 0o700 });
  }
  return dir;
};
export const clearNativePendingSpec = async (project) => {
  const dir = await pendingSpecDirectory(project);
  await fs.rm(join(dir, 'pending-question.json'), { force: true });
};
export const readNativePendingSpec = async (project) => {
  const dir = join(project, '.native-control');
  let realDirectory = false;
  try {
    realDirectory = (await fs.lstat(dir)).isDirectory();
  } catch {
    return null;
  }
  // Never read or remove anything through a link out of the project.
  if (!realDirectory) return null;
  const file = join(dir, 'pending-question.json');
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > NATIVE_PENDING_INPUT_LIMITS.specBytes) return null;
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile()));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  } finally {
    // rm removes a file or a link entry itself, never a link target.
    if ((await fs.lstat(dir).catch(() => null))?.isDirectory())
      await fs.rm(file, { force: true }).catch(() => {});
  }
};

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
/**
 * Recognize only the observed v2 native active-space/intent, stage cursor and
 * unanswered-question format. A successful CLI exit is never workflow success.
 * The directive's state hash can precede the question write (observed v2.9);
 * these references describe exact evidence, not an approval or signed state.
 */
export const classifyNativeFirstWait = ({ snapshot, harness, beforeFiles = [] }) => {
  const unknown = { kind: 'stopped_needs_review', code: 'native_wait_format_unrecognized' };
  try {
    const files = new Map(snapshot.files.map((file) => [file.path, file]));
    const read = (path) => {
      const file = files.get(path);
      if (!file) throw new Error('missing');
      return new TextDecoder('utf-8', { fatal: true }).decode(file.content);
    };
    const space = read('aidlc/active-space').trim();
    if (!segment(space)) return unknown;
    const intent = read(`aidlc/spaces/${space}/intents/active-intent`).trim();
    if (!segment(intent)) return unknown;
    const nativeIntentPath = `aidlc/spaces/${space}/intents/${intent}`;
    const statePath = `${nativeIntentPath}/aidlc-state.md`;
    const directivePath = `${nativeIntentPath}/.aidlc-engine/active-directive.json`;
    const state = read(statePath);
    const stages = [...state.matchAll(/^- \*\*Current Stage\*\*:\s*([a-z][a-z0-9-]*)[ \t]*$/gm)];
    if (stages.length !== 1) return unknown;
    const stage = stages[0][1];
    const directive = JSON.parse(read(directivePath));
    if (
      directive.version !== 2 ||
      directive.kind !== 'run-stage' ||
      directive.stage !== stage ||
      directive.cursor_harness !== harness ||
      directive.active_attempt?.status !== 'settled' ||
      !state.includes(`- [-] ${stage} — EXECUTE`) ||
      !/^- \*\*Status\*\*: Running[ \t]*$/m.test(state)
    )
      return unknown;
    const questions = snapshot.files.filter(
      (file) =>
        file.role === 'question' &&
        file.path.startsWith(`${nativeIntentPath}/`) &&
        file.path.endsWith(`/${stage}/${stage}-questions.md`),
    );
    if (questions.length !== 1) return unknown;
    const question = questions[0];
    if (beforeFiles.some((file) => file.path === question.path && file.sha256 === question.sha256))
      return { ...unknown, code: 'native_wait_unchanged_question' };
    const blocks = read(question.path)
      .split(/^## Q\d+[.)][ \t]+/m)
      .slice(1);
    if (!blocks.length) return unknown;
    let pending = 0;
    for (const block of blocks) {
      const answers = [...block.matchAll(/^\[Answer\]:([^\r\n]*)\r?$/gm)];
      if (answers.length !== 1) return unknown;
      const answer = answers[0];
      // A blank marker followed by free text is an answer too. Do not surface
      // an answered question simply because its answer starts on another line.
      if (!answer[1].trim() && !block.slice(answer.index + answer[0].length).trim()) pending++;
    }
    if (!pending) return unknown;
    return {
      kind: 'waiting_for_input',
      code: 'native_question_pending',
      evidence: {
        nativeIntentPath,
        stage,
        pendingQuestions: pending,
        state: fileRef(files.get(statePath)),
        directive: fileRef(files.get(directivePath)),
        questions: questions.map(fileRef),
        authority: 'workflow-evidence-only',
      },
    };
  } catch {
    return unknown;
  }
};

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
  return {
    harness,
    model,
    prompt,
    packageVersion,
    repository: Object.fromEntries(
      ['provider', 'repository', 'branch', 'commit'].map((key) => [key, repository[key]]),
    ),
  };
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
export const createNativeExecutor = ({
  env = process.env,
  prepare,
  prepareContinuation,
  publish,
  publishInteraction,
  assertActive,
  assertRecoveryAdmission,
  publishRecovery,
  loadRecovery,
  prepareRecovery,
  captureRecovery = captureNativeSessionRecovery,
  restoreRecovery = restoreNativeSessionRecovery,
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
  let ownerDirectory = directoryForGeneration(1);
  const project = join(root, 'project');
  let current = null;
  let launching = false;
  let task = null;
  let poisoned = false;
  const generationOf = (value) => {
    const generation = value?.writerGeneration ?? 1;
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
  const checkDirectories = async () => {
    for (const [path, initial] of current.directories) {
      if (!sameNode(initial, await privateDirectory(path)))
        fail('native_execution_directory_changed');
    }
  };
  const writeJson = async (path, data, replace = false) => {
    await checkDirectories();
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
    await checkDirectories();
    if (replace) await fs.rename(temp, path);
    await syncDirectory(ownerDirectory);
  };
  const activityLog = () => {
    current.report.activityProtocol = NATIVE_ACTIVITY_CAPABILITY;
    return (current.activity ??= createNativeActivityLog({
      writerGeneration: current.writerGeneration,
      spoolDirectory: join(ownerDirectory, 'activity'),
    }));
  };
  const timing = (boundary) => {
    current.report.timings ??= {};
    current.report.timings[boundary] = Date.now();
    recordNativeBoundary(current.identity, boundary, current.report.timings[boundary], {
      sequence: current.report.sequence,
      writerGeneration: current.writerGeneration,
    });
  };
  const report = () =>
    structuredClone({
      ...current.report,
      recovered: false,
      capabilities: [NATIVE_ACTIVITY_CAPABILITY],
    });
  const persist = () => writeJson(join(ownerDirectory, 'status.json'), current.report, true);
  const checkpoint = async (status, extra = {}) => {
    current.report = { ...current.report, ...extra, status, updatedAt: Date.now() };
    await persist();
  };
  const checkCancelled = () => {
    if (current.controller.signal.aborted) fail('native_execution_cancelled');
  };
  const run = async (invocation, commandEnv, model = false) => {
    checkCancelled();
    const options = {
      ...invocation,
      cwd: project,
      env: commandEnv,
      timeoutMs: model ? null : 300_000,
      outputLimitAction: model ? 'truncate' : 'terminate',
      signal: current.controller.signal,
    };
    if (model && assertActive) {
      await assertActive({
        identity: { ...current.identity },
        writerGeneration: current.writerGeneration,
        signal: current.controller.signal,
      });
    }
    // Keep the next spawn in this continuation: adding an await here would
    // reopen a local scheduling gap after the latest cancellation observation.
    checkCancelled();
    if (model) timing('harnessLaunched');
    const result = await commandRunner(options);
    if (result.cleanupComplete !== true) {
      poisoned = true;
      fail('native_execution_cleanup_incomplete');
    }
    checkCancelled();
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
  // Preparation owns package/harness installation; it returns the exact one-turn context.
  const prepareNativeTurn = async (payload, onActivity) => {
    timing('preparationStarted');
    const signal = current.controller.signal;
    const continuing = payload.command === 'native-continue';
    const prepared = continuing
      ? await prepareContinuation({ payload, signal })
      : await prepare({ payload, root, project, home: current.home, signal });
    if (!continuing) current.sourceBaseline = prepared?.sourceBaseline ?? null;
    timing('preparationCompleted');
    checkCancelled();
    await checkDirectories();
    const pkg = continuing ? current.package : prepared?.package;
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
      current.report.initializationChecks = [{ id: 'harness-layout', status: 'failed' }];
      current.report.initializationBaselineReason =
        nativeInitializationBaselineReason(error?.baselineReason) ?? 'baseline-read-failed';
      fail('native_execution_initialization_unverified');
    }
    const forbiddenBytes = [
      ...(current.forbiddenBytes ?? []),
      ...[prepared.authEnv.AWS_BEARER_TOKEN_BEDROCK, prepared.authEnv.KIRO_API_KEY].filter(Boolean),
      ...(prepared.forbiddenBytes ?? []),
    ];
    const activityTurn = activityLog().turn({
      sequence: current.report.sequence,
      harness: configuration.harness,
      model: configuration.model,
      forbiddenBytes,
      signal,
    });
    onActivity(activityTurn);
    activityTurn.lifecycle({ title: 'Preparing native harness' });
    timing('installationStarted');
    // Kept only in the hot owner for subsequent credential leak checks.
    // Never serialize these values into local status, messages or Git.
    current.forbiddenBytes = [...new Set(forbiddenBytes)];
    const baseEnv = {
      HOME: current.home,
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
          command: pkg.binaryPath,
          args: ['use', pkg.version, '--from', pkg.directory, '--offline', '--json'],
        },
        {
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
      ])
        await run(invocation, baseEnv);
    if (!continuing) {
      const inspection = await inspectInitialization({
        projectDirectory: project,
        installRoot: join(root, 'machine/data'),
        version: pkg.version,
        harness: configuration.harness,
        harnessBaseline,
      });
      if (inspection?.ok !== true) {
        current.report.initializationChecks = nativeInitializationCheckStatuses(inspection?.checks);
        fail('native_execution_initialization_unverified');
      }
      await checkDirectories();
      if (configuration.harness === 'claude') await configureNativeClaudeSessionEnd(project);
      current.package = structuredClone(pkg);
    }
    timing('installationCompleted');
    return {
      payload,
      signal,
      continuing,
      pkg,
      configuration,
      forbiddenBytes,
      activityTurn,
      auth,
      baseEnv,
    };
  };

  // One turn returns quiescent output. No publication or recovery head is admitted here.
  const runNativeTurn = async ({
    payload,
    signal,
    continuing,
    pkg,
    configuration,
    forbiddenBytes,
    activityTurn,
    auth,
    baseEnv,
  }) => {
    // A spec from an earlier turn must never describe this turn's question.
    await clearNativePendingSpec(project);
    const beforeFiles = (await snapshot({ project, signal, forbiddenBytes })).files.map(fileRef);
    const modelEnv = {
      ...auth,
      ...baseEnv,
      ...(auth.AWS_REGION ? { AWS_REGION: auth.AWS_REGION } : {}),
      CLAUDE_CONFIG_DIR: join(current.home, '.claude'),
      CODEX_HOME: join(current.home, '.codex'),
      XDG_CONFIG_HOME: join(current.home, '.config'),
      XDG_DATA_HOME: join(current.home, '.data'),
      XDG_CACHE_HOME: join(current.home, '.cache'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    const prompt = continuing
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
      nativeSessionId: continuing ? current.head.nativeSessionId : null,
      forbiddenBytes,
    });
    await checkpoint('running', { packageId: pkg.packageId });
    activityTurn.lifecycle({ title: 'Agent started' });
    const result = await run(
      {
        ...nativeExecutionInvocation({
          harness: configuration.harness,
          model: configuration.model,
          prompt,
          project,
          nativeSessionId: continuing ? current.head.nativeSessionId : null,
          promptEvidence: current.promptEvidence,
          priorAssistantSha256: current.priorAssistantSha256,
        }),
        onStdoutChunk: (chunk) => {
          if (!current.report.timings.firstOutput) timing('firstOutput');
          output.write(chunk);
          return activityTurn.write(chunk);
        },
      },
      modelEnv,
      true,
    );
    timing('harnessCompleted');
    const completed = output.finish();
    await checkDirectories();
    const renderedSpec = await readNativePendingSpec(project);
    const files = await snapshot({ project, signal, forbiddenBytes });
    const pendingInput = buildNativePendingInput({
      gate: nativeGateFromSnapshot(files),
      spec: renderedSpec,
      messagesText: completed.messages.map((message) => message.text).join('\n'),
    });
    const nativeSessionId = completed.nativeSessionId;
    let outcome = classifyNativeFirstWait({
      snapshot: files,
      harness: configuration.harness,
      beforeFiles,
    });
    outcome = {
      ...outcome,
      nativeSessionId,
      outputTruncated: result.outputLimitExceeded === true,
    };
    checkCancelled();
    await checkpoint('publishing', { nativeSessionId, outputTruncated: outcome.outputTruncated });
    return { completed, files, pendingInput, nativeSessionId, outcome, nextPromptEvidence };
  };

  // Public receipts and private CLI recovery bytes complete before the local head moves.
  const publishNativeTurn = async (
    { signal, pkg, configuration, forbiddenBytes },
    { completed, files, pendingInput, nativeSessionId, outcome, nextPromptEvidence },
  ) => {
    const publicationOutcome =
      outcome.kind === 'waiting_for_input' ? 'WAITING_FOR_INPUT' : 'STOPPED';
    const questionPath = outcome.evidence?.questions[0]?.path ?? null;
    timing('publicationStarted');
    const uploaded = await publish({
      identity: current.identity,
      sequence: current.report.sequence,
      packageId: pkg.packageId,
      nativeSessionId,
      outcome: publicationOutcome,
      repository: {
        branch: configuration.repository.branch,
        commit: configuration.repository.commit,
      },
      files: files.files,
      ...(current.sourceBaseline ? { sourceBaseline: current.sourceBaseline } : {}),
      questionPath,
      signal,
    });
    checkCancelled();
    timing('publicationCompleted');
    const publication = uploaded?.receipt;
    if (
      uploaded?.uploaded !== true ||
      !/^[a-f0-9]{64}$/.test(publication?.id ?? '') ||
      publication.sequence !== current.report.sequence ||
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
    const interaction = nativeInteractionReceipt(
      await publishInteraction({
        identity: current.identity,
        packageId: pkg.packageId,
        sequence: current.report.sequence,
        harness: configuration.harness,
        nativeSessionId,
        publicationId: receipt.id,
        messages: completed.messages,
        pendingInput,
        signal,
      }),
      current.identity,
    );
    checkCancelled();
    if (
      interaction.sequence !== receipt.sequence ||
      interaction.publicationId !== receipt.id ||
      interaction.nativeSessionId !== nativeSessionId
    )
      fail('native_execution_interaction_unconfirmed');
    let recoveryCheckpoint;
    const continuation = {
      promptEvidence: nextPromptEvidence ?? null,
      priorAssistantSha256: kiroAssistantHash(
        completed.messages.map((message) => message.text).join(''),
      ),
    };
    if (publishRecovery) {
      // Quiescent private session state is required for the next reply.
      // Public artifact/message uploads alone are not a resumable session.
      const captured = await captureRecovery({
        project,
        home: current.home,
        harness: configuration.harness,
        nativeSessionId,
        forbiddenBytes,
        signal,
        limits: RECOVERY_CAPTURE_LIMITS,
      });
      await checkDirectories();
      checkCancelled();
      timing('checkpointUploadStarted');
      recoveryCheckpoint = await publishRecovery({
        identity: current.identity,
        writerGeneration: current.writerGeneration,
        sequence: receipt.sequence,
        nativeSessionId,
        harness: configuration.harness,
        configurationSha256: current.configurationSha256,
        packageId: pkg.packageId,
        imageDigest: env.NATIVE_EXECUTION_IMAGE_DIGEST,
        publicationId: receipt.id,
        interactionId: interaction.id,
        continuation,
        filesystem: captured.metadata,
        files: captured.files,
        forbiddenBytes,
        signal,
      });
      checkCancelled();
      if (
        recoveryCheckpoint?.sequence !== receipt.sequence ||
        !/^[a-f0-9]{64}$/.test(recoveryCheckpoint.id ?? '') ||
        recoveryCheckpoint.manifest?.sha256 !== recoveryCheckpoint.id
      )
        fail('native_execution_recovery_unconfirmed');
      timing('checkpointUploadCompleted');
    }
    await checkpoint('publication_ready', {
      outcome: publicationOutcome,
      waitEvidence: outcome.evidence ?? null,
      stopCode: outcome.code,
      receipt,
      interaction,
      ...(recoveryCheckpoint ? { checkpoint: recoveryCheckpoint } : {}),
    });
    checkCancelled();
    current.head = structuredClone(current.report);
    current.promptEvidence = continuation.promptEvidence;
    current.priorAssistantSha256 = continuation.priorAssistantSha256;
  };

  const execute = async (payload) => {
    current.executing = true;
    current.report.timings = { accepted: current.report.updatedAt };
    recordNativeBoundary(current.identity, 'accepted', current.report.updatedAt, {
      sequence: current.report.sequence,
      writerGeneration: current.writerGeneration,
    });
    let activityTurn;
    try {
      const prepared = await prepareNativeTurn(payload, (turn) => {
        activityTurn = turn;
      });
      activityTurn = prepared.activityTurn;
      const result = await runNativeTurn(prepared);
      await publishNativeTurn(prepared, result);
    } catch (error) {
      // Never expose raw port/subprocess errors (which may contain credentials).
      const code = /^(native_execution|native_snapshot|native_recovery)_[a-z_]{1,64}$/.test(
        error?.code ?? '',
      )
        ? error.code
        : 'native_execution_failed';
      current.report = {
        ...current.report,
        status: poisoned
          ? 'stopped_needs_review'
          : current.controller.signal.aborted || code === 'native_execution_cancelled'
            ? 'cancelled'
            : 'failed',
        code,
        updatedAt: Date.now(),
      };
      // Unconfirmed subprocess cleanup must halt all subsequent filesystem
      // reads/writes: a surviving writer could race the supervisor.
      if (!poisoned) {
        try {
          await persist();
        } catch {
          current.report.status = 'stopped_needs_review';
          current.report.code = 'native_execution_status_unconfirmed';
        }
      }
    } finally {
      activityTurn?.close({
        failed: !['publication_ready', 'recovery_ready'].includes(current.report.status),
      });
      current.executing = false;
    }
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
  const status = async (value) => {
    const identity = validateIdentity(value);
    const writerGeneration = generationOf(value);
    if (current) {
      if (
        !sameIdentity(current.identity, identity) ||
        current.writerGeneration !== writerGeneration
      )
        fail('native_execution_owner_conflict');
      return report();
    }
    await readExisting(identity, writerGeneration);
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
        };
      }
      if (
        saved.schemaVersion === 1 &&
        sameIdentity(saved, identity) &&
        ['publication_ready', 'recovery_ready'].includes(saved.status) &&
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
          ...(saved.checkpoint ? { checkpoint: saved.checkpoint } : {}),
          recovered: true,
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
    };
  };
  const start = async (input) => {
    const identity = validateIdentity(input);
    const writerGeneration = generationOf(input);
    if (
      input.command !== 'native-start' ||
      input.schemaVersion !== 1 ||
      writerGeneration !== 1 ||
      (input.sequence !== undefined && input.sequence !== 1)
    )
      fail('native_execution_request_invalid');
    const configuration = canonicalConfig(input.configuration);
    const configurationSha256 = digest(JSON.stringify(configuration));
    if (launching) fail('native_execution_busy');
    if (current) {
      if (
        !sameIdentity(current.identity, identity) ||
        current.configurationSha256 !== configurationSha256
      )
        fail('native_execution_owner_conflict');
      return { ...report(), accepted: true, duplicate: true };
    }
    launching = true;
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
        const owner = await readExisting(identity);
        if (owner.configurationSha256 !== configurationSha256)
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
      current = {
        identity,
        writerGeneration,
        configurationSha256,
        directories,
        controller: new AbortController(),
        report: {
          schemaVersion: 1,
          ...identity,
          writerGeneration,
          sequence: 1,
          status: 'preparing',
          updatedAt: Date.now(),
        },
      };
      await writeJson(join(ownerDirectory, 'owner.json'), {
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
      await fs.mkdir(homeRoot, { recursive: true, mode: 0o700 });
      directories.set(homeRoot, await privateDirectory(homeRoot));
      current.home = join(homeRoot, identity.bindingId, identity.attemptId);
      await fs.mkdir(join(homeRoot, identity.bindingId), { mode: 0o700 });
      directories.set(
        join(homeRoot, identity.bindingId),
        await privateDirectory(join(homeRoot, identity.bindingId)),
      );
      directories.set(current.home, await createPrivateDirectory(current.home));
      await createPrivateDirectory(join(current.home, '.codex'));
      await fs.writeFile(
        join(current.home, '.codex/config.toml'),
        `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`,
        { flag: 'wx', mode: 0o600 },
      );
      await persist();
      // Freeze the normalized configuration rather than retaining mutable
      // caller objects across the acknowledgement/async boundary.
      const payload = structuredClone({ ...input, configuration });
      task = new Promise((resolveTask) => setImmediate(() => resolveTask(execute(payload))));
      return { ...report(), accepted: true, duplicate: false };
    } catch (error) {
      if (current) {
        current.report.status = 'stopped_needs_review';
        current.report.code = 'native_execution_start_incomplete';
      }
      if (/^native_execution_[a-z_]{1,64}$/.test(error?.code ?? '')) throw error;
      fail('native_execution_start_failed');
    } finally {
      launching = false;
    }
  };
  const continueTurn = async (value) => {
    const input = structuredClone(value);
    const identity = validateIdentity(input);
    const writerGeneration = generationOf(input);
    if (
      input.command !== 'native-continue' ||
      input.schemaVersion !== 1 ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 2 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        input.requestId ?? '',
      ) ||
      !/^[a-f0-9]{64}$/.test(input.priorInteractionId ?? '') ||
      !/^[a-f0-9]{64}$/.test(input.priorPublicationId ?? '') ||
      !text(input.text, 16 * 1024) ||
      !input.text.trim() ||
      Buffer.from(input.text).toString('utf8') !== input.text ||
      [...input.text].some((character) => {
        const code = character.codePointAt(0);
        return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
      })
    )
      fail('native_execution_request_invalid');
    const configuration = canonicalConfig(input.configuration);
    const configurationSha256 = digest(JSON.stringify(configuration));
    // Cold recovery is observation only. A local record never grants a fresh
    // writer ownership, even if the caller supplies apparently valid receipts.
    if (!current || poisoned) fail('native_execution_existing_owner');
    if (
      !sameIdentity(current.identity, identity) ||
      current.writerGeneration !== writerGeneration ||
      current.configurationSha256 !== configurationSha256
    )
      fail('native_execution_owner_conflict');
    if (launching) fail('native_execution_busy');
    const requestHash = digest(
      JSON.stringify({
        identity,
        configurationSha256,
        sequence: input.sequence,
        requestId: input.requestId,
        priorInteractionId: input.priorInteractionId,
        priorPublicationId: input.priorPublicationId,
        textSha256: digest(input.text),
      }),
    );
    const requestPath = join(ownerDirectory, `request-${input.requestId}.json`);
    let admissionStarted = false;
    launching = true;
    try {
      await checkDirectories();
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
      if (current.controller.signal.aborted) fail('native_execution_cancelled');
      if (ACTIVE.has(current.report.status)) fail('native_execution_busy');
      if (
        typeof prepareContinuation !== 'function' ||
        !['publication_ready', 'recovery_ready'].includes(current.report.status) ||
        !current.head ||
        current.head.sequence + 1 !== input.sequence ||
        current.head.receipt?.id !== input.priorPublicationId ||
        current.head.interaction?.id !== input.priorInteractionId
      )
        fail('native_execution_reply_conflict');
      const payload = structuredClone({ ...input, configuration });
      const next = {
        schemaVersion: 1,
        ...identity,
        writerGeneration,
        sequence: input.sequence,
        requestId: input.requestId,
        priorInteractionId: input.priorInteractionId,
        priorPublicationId: input.priorPublicationId,
        status: 'preparing',
        updatedAt: Date.now(),
      };
      const ack = { ...next, accepted: true, duplicate: false };
      // Immutable idempotency record, without reply text or credentials. If
      // later persistence fails it is deliberately not safe to replay a writer.
      admissionStarted = true;
      await writeJson(requestPath, { requestHash, ack });
      checkCancelled();
      current.report = next;
      await persist();
      checkCancelled();
      task = new Promise((resolveTask) => setImmediate(() => resolveTask(execute(payload))));
      return structuredClone(ack);
    } catch (error) {
      if (admissionStarted) {
        // A request file may already exist even if write/fsync/rename failed.
        // Do not accept its stored ACK or advertise a writer that was never
        // scheduled. Further writes, including automatic replay, are forbidden.
        poisoned = true;
        current.report = {
          schemaVersion: 1,
          ...identity,
          writerGeneration,
          sequence: input.sequence,
          requestId: input.requestId,
          status: 'stopped_needs_review',
          code: 'native_execution_reply_admission_unconfirmed',
          updatedAt: Date.now(),
        };
        fail('native_execution_reply_admission_unconfirmed');
      }
      if (/^native_execution_[a-z_]{1,64}$/.test(error?.code ?? '')) throw error;
      fail('native_execution_start_failed');
    } finally {
      launching = false;
    }
  };
  const recover = async (value) => {
    const input = structuredClone(value);
    const identity = validateIdentity(input);
    const writerGeneration = generationOf(input);
    const configuration = canonicalConfig(input.configuration);
    const configurationSha256 = digest(JSON.stringify(configuration));
    if (
      input.command !== 'native-recover' ||
      input.schemaVersion !== 1 ||
      writerGeneration < 2 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        input.recoveryId ?? '',
      ) ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 1 ||
      input.checkpoint?.sequence !== input.sequence ||
      !/^[a-f0-9]{64}$/.test(input.checkpoint?.id ?? '') ||
      input.publication?.sequence !== input.sequence ||
      input.interaction?.sequence !== input.sequence ||
      input.interaction?.publicationId !== input.publication?.id ||
      input.interaction?.nativeSessionId !== input.publication?.nativeSessionId ||
      !ID.test(input.publication?.nativeSessionId ?? '') ||
      input.imageDigest !== env.NATIVE_EXECUTION_IMAGE_DIGEST ||
      ![assertRecoveryAdmission, loadRecovery, prepareRecovery, restoreRecovery].every(
        (port) => typeof port === 'function',
      )
    )
      fail('native_execution_request_invalid');
    nativeInteractionReceipt(input.interaction, identity);
    if (launching) fail('native_execution_busy');
    if (current) {
      if (
        poisoned ||
        !sameIdentity(current.identity, identity) ||
        current.writerGeneration !== writerGeneration ||
        current.configurationSha256 !== configurationSha256 ||
        current.report.recoveryId !== input.recoveryId ||
        current.report.checkpointId !== input.checkpoint.id
      )
        fail('native_execution_owner_conflict');
      return { ...report(), accepted: true, duplicate: true };
    }
    launching = true;
    const controller = new AbortController();
    const admission = () =>
      assertRecoveryAdmission({
        identity,
        writerGeneration,
        recoveryId: input.recoveryId,
        checkpointId: input.checkpoint.id,
        signal: controller.signal,
      });
    try {
      // Only the protected controller can admit this exact successor and
      // checkpoint, after fencing and stopping its predecessor.
      await admission();
      await inspectMount({ workspaceDir: root });
      const directories = new Map([[root, await privateDirectory(root)]]);
      await fs.mkdir(control, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      directories.set(control, await privateDirectory(control));
      ownerDirectory = directoryForGeneration(writerGeneration);
      try {
        directories.set(ownerDirectory, await createPrivateDirectory(ownerDirectory));
      } catch (error) {
        // A cold partial restore cannot create another writer in the same
        // generation. The controller must fence and stop it before a retry.
        if (error.code === 'EEXIST') fail('native_execution_existing_owner');
        throw error;
      }
      current = {
        identity,
        writerGeneration,
        configurationSha256,
        directories,
        controller,
        home: join(homeRoot, identity.bindingId, identity.attemptId),
        report: {
          schemaVersion: 1,
          ...identity,
          writerGeneration,
          sequence: input.sequence,
          recoveryId: input.recoveryId,
          checkpointId: input.checkpoint.id,
          status: 'recovering',
          nativeSessionId: input.publication.nativeSessionId,
          updatedAt: Date.now(),
        },
      };
      await writeJson(join(ownerDirectory, 'owner.json'), {
        schemaVersion: 1,
        identity,
        writerGeneration,
        configurationSha256,
      });
      await persist();
      const executeRecovery = async () => {
        current.executing = true;
        try {
          const signal = controller.signal;
          timing('checkpointDownloadStarted');
          const loaded = await loadRecovery({ payload: input, signal });
          timing('checkpointDownloadCompleted');
          checkCancelled();
          const { manifest, files } = loaded ?? {};
          current.sourceBaseline = loaded?.sourceBaseline ?? null;
          if (
            manifest?.sequence !== input.sequence ||
            manifest.writerGeneration >= writerGeneration ||
            manifest.configurationSha256 !== configurationSha256 ||
            manifest.publicationId !== input.publication.id ||
            manifest.interactionId !== input.interaction.id ||
            manifest.nativeSessionId !== input.publication.nativeSessionId ||
            manifest.harness !== configuration.harness ||
            manifest.imageDigest !== env.NATIVE_EXECUTION_IMAGE_DIGEST
          )
            fail('native_execution_recovery_unconfirmed');
          await admission();
          await checkDirectories();
          // The complete immutable checkpoint is verified before touching the
          // workspace. Keep previous directories until restore is complete.
          const backups = [];
          const replaceDirectory = async (path, backup) => {
            try {
              await privateDirectory(path);
              await fs.rename(path, backup);
              backups.push(backup);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
            directories.set(path, await createPrivateDirectory(path));
          };
          await replaceDirectory(project, join(ownerDirectory, 'previous-project'));
          await replaceDirectory(join(root, 'machine'), join(ownerDirectory, 'previous-machine'));
          for (const path of [join(root, 'machine/data'), join(root, 'machine/bin')])
            directories.set(path, await createPrivateDirectory(path));
          await fs.mkdir(homeRoot, { recursive: true, mode: 0o700 });
          directories.set(homeRoot, await privateDirectory(homeRoot));
          const bindingHome = join(homeRoot, identity.bindingId);
          await fs.mkdir(bindingHome, { mode: 0o700 }).catch((error) => {
            if (error.code !== 'EEXIST') throw error;
          });
          directories.set(bindingHome, await privateDirectory(bindingHome));
          await replaceDirectory(
            current.home,
            join(bindingHome, `${identity.attemptId}-before-writer-${writerGeneration}`),
          );
          timing('filesystemRestoreStarted');
          const restored = await restoreRecovery({
            project,
            home: current.home,
            harness: configuration.harness,
            nativeSessionId: manifest.nativeSessionId,
            metadata: manifest.filesystem,
            files,
            signal,
            limits: RECOVERY_CAPTURE_LIMITS,
          });
          timing('filesystemRestoreCompleted');
          if (
            restored?.restored !== true ||
            restored.nativeSessionId !== manifest.nativeSessionId ||
            restored.harness !== configuration.harness
          )
            fail('native_execution_recovery_unconfirmed');
          checkCancelled();
          await checkDirectories();
          const prepared = await prepareRecovery({
            payload: input,
            root,
            project,
            home: current.home,
            signal,
          });
          const pkg = prepared?.package;
          if (
            !pkg ||
            pkg.packageId !== manifest.packageId ||
            pkg.version !== configuration.packageVersion ||
            !within(join(root, 'packages'), pkg.directory) ||
            !within(pkg.directory, pkg.binaryPath)
          )
            fail('native_execution_preparation_invalid');
          await privateDirectory(pkg.directory);
          current.package = structuredClone(pkg);
          // Reinstall the machine projection from verified pinned package
          // bytes. The restored project/session data is not reinitialized.
          const machineEnv = {
            HOME: current.home,
            TMPDIR: '/tmp',
            PATH: HOST_PATH,
            LANG: 'C.UTF-8',
            AIDLC_INSTALL_ROOT: join(root, 'machine/data'),
            AIDLC_BIN_DIR: join(root, 'machine/bin'),
            AIDLC_PROJECT_DIR: project,
            AIDLC_OFFLINE: '1',
          };
          await run(
            {
              command: pkg.binaryPath,
              args: ['use', pkg.version, '--from', pkg.directory, '--offline', '--json'],
            },
            machineEnv,
          );
          // The project pin is only honored when the machine pin registry
          // (machine/data/pins.json, rebuilt above) lists this project. Re-pin
          // the restored project; it rewrites only its own identical pin files.
          await run(
            {
              command: join(root, 'machine/bin/aidlc'),
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
            machineEnv,
          );
          await admission();
          await checkDirectories();
          current.promptEvidence = manifest.continuation.promptEvidence;
          current.priorAssistantSha256 = manifest.continuation.priorAssistantSha256;
          // These backups are transient restore safety data, not debug
          // archives. Only directories moved by this admitted restore qualify.
          const discard = async (path) => {
            const stat = await fs.lstat(path);
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
              if (
                (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) ||
                (await fs.realpath(path)) !== path
              )
                fail('native_execution_directory_invalid');
              await fs.chmod(path, 0o700);
              for (const name of await fs.readdir(path)) await discard(join(path, name));
              await fs.rmdir(path);
            } else await fs.unlink(path);
          };
          for (const path of backups) {
            await checkDirectories();
            await discard(path);
          }
          await admission();
          await checkpoint('recovery_ready', {
            receipt: input.publication,
            interaction: input.interaction,
            checkpoint: input.checkpoint,
            outcome: input.publication.outcome,
            packageId: pkg.packageId,
          });
          current.head = structuredClone(current.report);
        } catch (error) {
          current.report = {
            ...current.report,
            status: 'stopped_needs_review',
            code: 'native_execution_recovery_failed',
            recoveryFailureCode: /^(?:native_recovery|native_execution)_[a-z_]{1,64}$/.test(
              error?.code ?? '',
            )
              ? error.code
              : 'native_execution_recovery_failed',
            updatedAt: Date.now(),
          };
          if (!poisoned) {
            try {
              await persist();
            } catch {
              poisoned = true;
            }
          }
        } finally {
          current.executing = false;
        }
      };
      task = new Promise((resolveTask) => setImmediate(() => resolveTask(executeRecovery())));
      return { ...report(), accepted: true, duplicate: false };
    } catch (error) {
      if (current) {
        poisoned = true;
        current.report.status = 'stopped_needs_review';
        current.report.code = 'native_execution_recovery_failed';
      }
      if (/^native_execution_[a-z_]{1,64}$/.test(error?.code ?? '')) throw error;
      fail('native_execution_recovery_failed');
    } finally {
      launching = false;
    }
  };
  const cancel = async (value) => {
    const identity = validateIdentity(value);
    if (!current) return status(value);
    if (
      !sameIdentity(current.identity, identity) ||
      current.writerGeneration !== generationOf(value)
    )
      fail('native_execution_owner_conflict');
    if (
      !ACTIVE.has(current.report.status) &&
      !['publication_ready', 'recovery_ready'].includes(current.report.status)
    )
      return report();
    current.controller.abort();
    if (
      ['publication_ready', 'recovery_ready'].includes(current.report.status) &&
      !current.executing &&
      !launching
    ) {
      current.report = { ...current.report, status: 'cancelled', updatedAt: Date.now() };
      // There is no active child or execute() persistence owner at this point.
      await persist();
      return report();
    }
    current.report = { ...current.report, status: 'cancelling', updatedAt: Date.now() };
    // execute owns persistence, serialized after child cleanup; do not race it.
    return report();
  };
  const activity = async (value) => {
    const identity = validateIdentity(value);
    const writerGeneration = generationOf(value);
    if (!Number.isSafeInteger(value.after) || value.after < 0)
      fail('native_execution_request_invalid');
    if (current) {
      if (
        !sameIdentity(current.identity, identity) ||
        current.writerGeneration !== writerGeneration
      )
        fail('native_execution_owner_conflict');
      return { ...identity, ...activityLog().pull(value.after) };
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
    recover,
    status,
    cancel,
    isBusy: () => launching || poisoned || (current && ACTIVE.has(current.report.status)) === true,
    settle: async () => {
      await task;
      return current ? report() : null;
    },
  };
};
