import { isAbsolute, relative } from 'node:path';
import { engineFailure, engineDigest } from '../../shared/native-workflow-protocol.js';
import {
  canonicalNativePath,
  nativeFileExclusion,
  NATIVE_DEPENDENCY_POLICY,
} from '../../shared/native-project-files.js';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import {
  nativeAnswerText,
  nativeSelection,
  nativeTypedChoiceCommands,
  NATIVE_GATE_LABELS,
} from '../../shared/native-pending-input.js';

const flag = (args, name) => {
  const positions = args.flatMap((arg, index) => (arg === name ? [index] : []));
  if (positions.length > 1 || args.some((arg) => arg.startsWith(`${name}=`)))
    throw engineFailure('NATIVE_ENGINE_COMMAND_DENIED');
  return positions.length ? args[positions[0] + 1] : undefined;
};
const fail = () => {
  throw engineFailure('NATIVE_ENGINE_COMMAND_DENIED');
};
export const nativeEngineDirectiveSha = (value) => engineDigest(canonicalJson(value));

// Decode an engine-emitted argv, never evaluate a shell expression. This
// accepts literal POSIX quoting only. Expansion, pipes and redirection have no
// meaning on this service boundary.
export const nativeEngineCommandWords = (command) => {
  if (typeof command !== 'string' || command.length > 65_536) fail();
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const ch = command[index];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') {
        if (!['"', '\\'].includes(command[index + 1])) fail();
        word += command[++index];
      } else {
        if (quote === '"' && /[$`]/.test(ch)) fail();
        word += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === ' ') {
      if (started) words.push(word);
      word = '';
      started = false;
    } else if (['$', '`', ';', '&', '|', '<', '>', '\r', '\n', '\0', '\\'].includes(ch)) fail();
    else {
      word += ch;
      started = true;
    }
  }
  if (quote) fail();
  if (started) words.push(word);
  if (!['aidlc', '/usr/local/bin/aidlc'].includes(words.shift())) fail();
  return words;
};

export const nativeEngineSelectedCommand = (presentation, response) => {
  if (!presentation || !response.selection) return null;
  const selection = nativeSelection(presentation.pendingInput, response.selection);
  if (nativeAnswerText(presentation.pendingInput, selection) !== response.text) fail();
  if (selection.answers.length !== 1 || selection.answers[0].selectedOptions.length !== 1)
    return null;
  const index = selection.answers[0].selectedOptions[0];
  const label = presentation.pendingInput.questions[0].options[index]?.label;
  if (presentation.directive.kind === 'ask') {
    const choice = nativeTypedChoiceCommands(presentation.directive).find(
      (choice) => choice.label === label,
    );
    return choice?.command ? nativeEngineCommandWords(choice.command) : null;
  }
  if (presentation.directive.kind === 'present-gate' && NATIVE_GATE_LABELS.includes(label))
    return [
      'engine',
      'orchestrate',
      'report',
      '--stage',
      presentation.directive.stage,
      '--result',
      label === 'Approve' ? 'approved' : 'rejected',
      '--user-input',
      response.text,
    ];
  return null;
};

const withoutProject = (args, project) => {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--project-dir') {
      if (args[++index] !== project) fail();
    } else if (args[index].startsWith('--project-dir=')) fail();
    else result.push(args[index]);
  }
  return result;
};
export const normalizeNativeEngineCommand = (args, project) => {
  if (
    !Array.isArray(args) ||
    args.length > 128 ||
    args.some((arg) => typeof arg !== 'string' || arg.length > 65_536 || arg.includes('\0'))
  )
    fail();
  const selected = withoutProject(args, project);
  if (!selected.length) return ['engine', 'orchestrate', 'next'];
  return ['next', 'continue', 'report', 'park', 'team-board'].includes(selected[0])
    ? ['engine', 'orchestrate', ...selected]
    : selected;
};
const scopedArguments = (args, project) => {
  const textFlags =
    args[1] === 'log'
      ? ({
          decision: ['--decision', '--options', '--rationale', '--test-command'],
          answer: ['--details'],
          review: ['--test-command'],
        }[args[2]] ?? [])
      : args[1] === 'intent'
        ? ['--label']
        : ['--feedback', '--reason'];
  for (let index = 3; index < args.length; index++) {
    const value = args[index];
    if (textFlags.includes(args[index - 1])) continue;
    if (value.startsWith('--')) {
      // One spelling for capability flags; an alternate --name=value must
      // not escape either text binding or filesystem validation.
      if (value.includes('=')) fail();
      continue;
    }
    if (value === '..' || /[*?{}]/.test(value)) fail();
    if (!value.includes('/') && !value.includes('\\') && !value.includes(':')) continue;
    const path = isAbsolute(value) ? relative(project, value) : value;
    if (
      !canonicalNativePath(path) ||
      nativeFileExclusion(path, NATIVE_DEPENDENCY_POLICY) !== null ||
      path.split('/').includes('.aidlc-engine') ||
      /[*?{}]/.test(path)
    )
      fail();
  }
};

const validateCreation = (args, state, member) => {
  const approvedScope = member?.selectedCommand ? flag(member.selectedCommand, '--scope') : null;
  if (
    state.directive?.kind !== 'print' ||
    member?.stage !== null ||
    member.application !== 'pending' ||
    !approvedScope ||
    flag(args, '--scope') !== approvedScope ||
    !/^[a-f0-9]{8}$/.test(flag(args, '--request') ?? '') ||
    !/^[a-z0-9][a-z0-9 -]{0,79}$/.test(flag(args, '--label') ?? '') ||
    args.length !== 9 ||
    args
      .slice(3)
      .filter((_, index) => index % 2 === 0)
      .some((name) => !['--scope', '--request', '--label'].includes(name))
  )
    fail();
};
const ALLOWED = {
  orchestrate: ['next', 'continue', 'report', 'park', 'team-board'],
  state: ['get'],
  audit: ['history'],
  sensor: ['list', 'describe', 'fire'],
  log: ['decision', 'answer', 'answers', 'link', 'review'],
  'review-brief': ['review', 'context', 'summary'],
  graph: [
    'artifacts',
    'producers',
    'consumers',
    'topo',
    'cycles',
    'scope',
    'validate-scope',
    'validate-grid',
    'ars',
  ],
  validate: ['outputs'],
};
const validateNext = (args, state, workspaceResume) => {
  if (workspaceResume && args.length === 4 && args[3] === '--resume') return;
  // A no-argument next is ordinary scheduling. A human-owned intake,
  // plan change or restart is selected through its protected presentation.
  const proposal =
    args.length === 7 &&
    args[3] === '--propose' &&
    /^[a-z][a-z0-9-]{0,63}$/.test(args[4]) &&
    args[5] === '--request' &&
    /^[a-f0-9]{8}$/.test(args[6]) &&
    !state.directive?.stage;
  if (args.length !== 3 && !proposal) fail();
};
const validateOrchestration = (args, state, project, workspaceResume) => {
  const verb = args[2];
  if (verb === 'next') validateNext(args, state, workspaceResume);
  if (verb === 'continue') {
    if (
      state.directive?.kind !== 'load-steering' ||
      canonicalJson(
        normalizeNativeEngineCommand(nativeEngineCommandWords(state.directive.next), project),
      ) !== canonicalJson(args)
    )
      fail();
  }
  if (verb === 'report') {
    const result = flag(args, '--result');
    if (flag(args, '--stage') !== state.directive?.stage) fail();
    if (['approved', 'completed', 'done'].includes(result)) {
      if (
        !['run-stage', 'dispatch-subagent'].includes(state.directive?.kind) ||
        state.directive.gate !== false
      )
        fail();
    } else if (result !== 'awaiting-approval') fail();
    if (flag(args, '--user-input') !== undefined) fail();
  }
};
const validateAnswer = (args, state, member) => {
  const decision = member;
  if (!decision || decision.application === 'applied' || !decision.presentationSha256) fail();
  if (flag(args, '--stage') !== decision.stage || decision.stage !== state.directive?.stage) fail();
  // A reply is logged once, whole, including a multiple-question selection.
  // The engine pairs that reply with its open question rows. The coding
  // process cannot replace its words, invent a delegated choice, or supply
  // a file/message from another exchange.
  if (
    flag(args, '--details') !== decision.text ||
    ['--details-file', '--on-instruction', '--on-instruction-file', '--batch-file'].some(
      (name) => flag(args, name) !== undefined,
    ) ||
    (flag(args, '--message') !== undefined && flag(args, '--message') !== decision.messageId)
  )
    fail();
  if (flag(args, '--message') === undefined) args.push('--message', decision.messageId);
};
const validateLog = (args, state, member) => {
  const verb = args[2];
  if (['decision', 'answer'].includes(verb) && flag(args, '--stage') !== state.directive?.stage)
    fail();
  if (verb === 'answer') validateAnswer(args, state, member);
  if (verb === 'decision' && flag(args, '--message') !== undefined) {
    const decision = member;
    if (
      !decision ||
      decision.application === 'applied' ||
      flag(args, '--message') !== decision.messageId
    )
      fail();
  }
};

// Workflow rules remain in the pinned engine. These are host capability
// limits: a coding process cannot become a member, mint an audit event, set
// lifecycle fields, supply a reviewer verdict, or replace the engine.
export const nativeEngineCommand = ({
  args,
  state,
  project,
  workspaceResume = false,
  memberCommand = null,
  member = null,
}) => {
  args = normalizeNativeEngineCommand(args, project);
  if (memberCommand) {
    const selected = normalizeNativeEngineCommand(memberCommand, project);
    if (canonicalJson(args) === canonicalJson(selected)) return { args, member: true };
  }
  scopedArguments(args, project);
  if (
    args[0] !== 'engine' ||
    args.some(
      (arg) =>
        ['--single', '--force', '--skip-guard', '--no-guard', '--verdict'].some(
          (name) => arg === name || arg.startsWith(`${name}=`),
        ) ||
        arg.startsWith('AIDLC_') ||
        arg.startsWith('NATIVE_'),
    )
  )
    fail();
  const [, route, verb] = args;
  if (route === 'intent' && verb === 'create') {
    validateCreation(args, state, member);
    return { args, member: false, creation: true };
  }
  if (!ALLOWED[route]?.includes(verb)) fail();
  if (route === 'orchestrate') validateOrchestration(args, state, project, workspaceResume);
  if (route === 'log') validateLog(args, state, member);
  return { args, member: false, review: route === 'log' && verb === 'review' };
};
