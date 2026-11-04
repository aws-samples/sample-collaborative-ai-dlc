// Synthetic task content using the verified AI-DLC v2.11.1 producers:
// source 895a35d86d20336d9b7bc4aedc9440e4a12c83ab, runtime archive SHA256
// 9f213c8254e646123b3f4bcefe347a61c95c72fee9fda4bf9afab42ccb20f44a.
// tools/aidlc-orchestrate.ts: scopeConfirmAskDirective/composeOfferAskDirective.
// aidlc-common/protocols/stage-protocol.md: Structured questions, stage approval,
// Question flow and Consolidated Summary Confirmation; each harness's
// skills/aidlc/question-rendering.md maps the same question fields.
// No transcript, generated application quality or live model behavior is claimed.
import { proposedPlanSpec } from './native-plan-ask.js';

export const aidlc211Identity = {
  version: '2.11.1',
  source: {
    provider: 'github',
    repository: 'awslabs/aidlc-workflows',
    release: 'v2.11.1',
    commit: '895a35d86d20336d9b7bc4aedc9440e4a12c83ab',
  },
  assets: {
    runtime: { sha256: '9f213c8254e646123b3f4bcefe347a61c95c72fee9fda4bf9afab42ccb20f44a' },
  },
};
const options = (...labels) => labels.map((label) => ({ label }));
const rendered = (questions) => ({ version: 2, questions });
const question = (prompt, labels) => ({ prompt, multiSelect: false, options: options(...labels) });
const plans = [
  'bugfix',
  'classic',
  'enterprise',
  'express',
  'feature',
  'infra',
  'mvp',
  'poc',
  'refactor',
  'security-patch',
  'workshop',
];
const scopeCommands = plans.map((scope) => ({
  scope,
  command: `aidlc engine orchestrate next --scope ${scope} --request fixture-request`,
  stages: '3 stages',
}));
export const aidlc211InteractionCases = [
  {
    name: 'current-step-group',
    spec: rendered([
      question('Which delivery target should we use?', ['Web (Recommended)', 'Desktop']),
      { ...question('Which capabilities are required?', ['Offline', 'Export']), multiSelect: true },
      question('What constraints must the implementation respect?', []),
    ]),
    selections: [[0], [0, 1], []],
  },
  {
    name: 'interaction-mode',
    spec: rendered([
      question('How would you like to answer?', ['Guide me', "I'll edit the file", 'Chat']),
    ]),
    selections: [[1]],
  },
  {
    name: 'scope-confirm',
    spec: proposedPlanSpec,
    selections: [[1]],
  },
  {
    name: 'compose-offer',
    spec: {
      version: 3,
      ask: {
        kind: 'ask',
        ask_type: 'compose-offer',
        response_route: 'next',
        question: 'Which plan should I use for this task?',
        compose_command: 'aidlc engine orchestrate next compose --request fixture-request',
        scope_commands: scopeCommands,
      },
    },
    selections: [[11]],
  },
  {
    name: 'summary-confirmation',
    spec: rendered([question('Is this summary complete?', ['Looks correct', 'Request changes'])]),
    selections: [[0]],
  },
  {
    name: 'stage-approval',
    spec: rendered([
      question('Requirements complete. How would you like to proceed?', [
        'Approve',
        'Request Changes',
      ]),
    ]),
    selections: [[0]],
    approval: true,
  },
  {
    name: 'approval-revision-choice',
    spec: rendered([
      question('Review the revised requirements.', ['Approve', 'Request Changes', 'Accept as-is']),
    ]),
    selections: [[2]],
    approval: true,
  },
  {
    name: 'approval-add-stage',
    spec: rendered([
      question('Review the requirements and the offered next step.', [
        'Approve',
        'Request Changes',
        'Add User Stories',
      ]),
    ]),
    selections: [[2]],
    approval: true,
  },
  {
    name: 'written-reply',
    spec: rendered([question('Describe the required constraint.', [])]),
    selections: [[]],
  },
  {
    name: 'all-32-questions-and-16-options',
    spec: rendered(
      Array.from({ length: 32 }, (_, i) =>
        question(
          `Current-step question ${i + 1}?`,
          Array.from({ length: 16 }, (_, j) => `Q${i + 1} choice ${j + 1}`),
        ),
      ),
    ),
    selections: Array.from({ length: 32 }, () => [15]),
  },
  {
    name: 'unsupported-engine-ask',
    spec: {
      version: 3,
      ask: {
        kind: 'ask',
        ask_type: 'plan-approval',
        response_route: 'command',
        question: 'Review the code plan.',
      },
    },
    degraded: 'unsupported_ask',
  },
  {
    name: 'conflicting-typed-fields',
    spec: { version: 3, ask: { ...proposedPlanSpec.ask, options: [{ label: 'Unbound choice' }] } },
    degraded: 'unsupported_ask',
  },
  {
    name: 'malformed-form',
    spec: rendered([question('Which exact option?', ['Duplicate', 'Duplicate'])]),
    degraded: 'invalid_schema',
  },
  {
    name: 'retired-four-question-format',
    spec: { version: 1, questions: [question('Which option?', ['First', 'Second'])] },
    degraded: 'invalid_schema',
  },
  {
    name: 'too-many-options',
    spec: rendered([
      question(
        'Keep every required choice.',
        Array.from({ length: 17 }, (_, i) => `Option ${i + 1}`),
      ),
    ]),
    degraded: 'invalid_schema',
  },
  {
    name: 'too-many-questions',
    spec: rendered(
      Array.from({ length: 33 }, (_, i) => question(`Required question ${i + 1}?`, [])),
    ),
    degraded: 'invalid_schema',
  },
  {
    name: 'pending-data-unavailable',
    spec: null,
    readReason: 'read_failed',
    degraded: 'read_failed',
  },
  { name: 'pending-data-absent', spec: null, readReason: 'absent', degraded: 'absent' },
  {
    name: 'pending-json-malformed',
    spec: null,
    readReason: 'invalid_json',
    degraded: 'invalid_json',
  },
];

// Installed protocols: Claude 2.1.296 (stream-json), Codex 0.162.1 (exec JSONL),
// OpenCode 1.19.0 (run --format json). Terminal records are independent of tool
// output; assistant bytes and the exact session must survive chunked decoding.
export const nativeHarnessRecords = (harness, texts, session = 'fixture-session') => {
  if (harness === 'claude')
    return [
      { type: 'system', subtype: 'init', session_id: session },
      {
        type: 'assistant',
        session_id: session,
        parent_tool_use_id: null,
        message: { role: 'assistant', content: texts.map((text) => ({ type: 'text', text })) },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: session,
        result: texts.at(-1),
        stop_reason: 'end_turn',
        terminal_reason: 'completed',
      },
    ];
  if (harness === 'codex')
    return [
      { type: 'thread.started', thread_id: session },
      { type: 'turn.started' },
      ...texts.map((text, i) => ({
        type: 'item.completed',
        item: { id: `message-${i}`, type: 'agent_message', text },
      })),
      { type: 'turn.completed' },
    ];
  if (harness === 'opencode')
    return [
      { type: 'step_start', sessionID: session, part: { type: 'step-start', sessionID: session } },
      ...texts.map((text, i) => ({
        type: 'text',
        sessionID: session,
        part: { id: `message-${i}`, type: 'text', text, sessionID: session },
      })),
      {
        type: 'step_finish',
        sessionID: session,
        part: { type: 'step-finish', reason: 'stop', sessionID: session },
      },
    ];
  throw new Error('This matrix covers only the enabled development harnesses');
};
