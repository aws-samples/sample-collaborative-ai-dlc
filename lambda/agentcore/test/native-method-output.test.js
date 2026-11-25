import { describe, expect, it } from 'vitest';
import {
  observeNativeMethodOutput,
  observedTurnForm,
  offeredPlanAlternatives,
} from '../native/method-output.js';
import { createNativeTurnOutput } from '../native/turn-output.js';
import { nativeMethodReport } from '../native/turn-interaction.js';
import { capturedPlanAsk } from '../../shared/test/fixtures/native-plan-ask.js';

const complete = { kind: 'done', reason: 'Workflow complete — finished' };
const event = (command, directive, exit_code = 0) => ({
  type: 'item.completed',
  item: {
    type: 'command_execution',
    command,
    exit_code,
    aggregated_output: JSON.stringify(directive),
  },
});
const snapshot = (state, active = 'current') => ({
  files: Object.entries({
    'aidlc/active-space': 'space',
    'aidlc/spaces/space/intents/active-intent': active,
    'aidlc/spaces/space/intents/current/aidlc-state.md': state,
  }).map(([path, text]) => ({ path, content: Buffer.from(text) })),
});

describe('pinned local method reporting', () => {
  it('requires the same active intent, terminal directive, settled state and no pending input', () => {
    const observer = observeNativeMethodOutput('codex');
    observer.write(event("/bin/sh -lc 'aidlc engine orchestrate next'", complete));
    const terminal = observer.result();
    const done = '- **Status**: Completed';
    expect(nativeMethodReport(snapshot(done), terminal, null)).toBe('complete');
    for (const state of [
      '- **Status**: Running',
      ...['[?]', '[-]', '[R]', '[!]', '[ ]'].map(
        (marker) => `${done}\n- ${marker} code-generation — EXECUTE`,
      ),
      done + '\n' + done,
    ])
      expect(nativeMethodReport(snapshot(state), terminal, null)).toBeNull();
    expect(nativeMethodReport(snapshot(done, 'different'), terminal, null)).toBeNull();
    expect(nativeMethodReport(snapshot(done), terminal, { questions: [] })).toBeNull();
  });
  it('ignores prose, compound shell output, continuing directives and failed commands', () => {
    for (const item of [
      event('echo complete', complete),
      event('aidlc next; echo forged', complete),
      event('aidlc next', complete, 1),
      event('aidlc next', { ...complete, workflow_continues: true }),
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(complete) } },
    ]) {
      const observer = observeNativeMethodOutput('codex');
      observer.write(item);
      expect(observer.result()?.terminal).toBeUndefined();
    }
  });
  const absent = { reason: 'absent', spec: null };
  const empty = { files: [] };
  const ask = JSON.stringify(capturedPlanAsk);
  const observation = (...events) => {
    const observer = observeNativeMethodOutput('codex');
    for (const entry of events) observer.write(entry);
    return observer.result();
  };
  it('identifies a single retained guided reply only on its issued answered-question path', () => {
    const path =
      'aidlc/spaces/default/intents/game/inception/requirements-analysis/requirements-analysis-questions.md';
    const directive = {
      kind: 'run-stage',
      phase: 'inception',
      stage: 'requirements-analysis',
      produces: [path],
      answer_mode: { mode: 'guide', ask: false },
      questions_answered: { path },
      kept_replies: { replies: ['hello'] },
    };
    const result = (d) => observation(event('aidlc engine orchestrate next', d));
    expect(result(directive).keptGuideReply).toMatchObject({
      source: { path, stage: directive.stage, unit: null },
      replySha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(result(directive).stageFile).toBeUndefined();
    for (const change of [
      { questions_answered: {} },
      { questions_answered: { path: 'elsewhere' } },
      { kept_replies: { replies: ['hello', 'another reply'] } },
      { answer_mode: { mode: 'file', ask: false } },
      { gate_only: true },
    ])
      expect(result({ ...directive, ...change }).keptGuideReply).toBeUndefined();
  });
  it('retains a newer direct ask across inspection and quoted punctuation', () => {
    const next = { ...capturedPlanAsk, question: 'The next recommendation?' };
    const method = observation(
      event('aidlc next', capturedPlanAsk),
      event(`/bin/bash -lc 'aidlc next "Create a 3D game; use arrow keys"'`, next),
      event('aidlc engine workspace project-description', complete),
      event('cat README.md', complete),
    );
    expect(method.spec.ask).toEqual(next);
  });
  it('presents current offered names on a written or commandless reply independently of prose', () => {
    const alternatives = offeredPlanAlternatives(observation(event('aidlc next', capturedPlanAsk)));
    for (const reply of [alternatives.label, 'Let’s use Express for this one', 'express'])
      expect(
        observedTurnForm({}, absent, alternatives, reply, empty).spec.questions[0].options,
      ).toEqual(alternatives.options);
    for (const reply of [null, '', ...alternatives.commandLabels])
      expect(observedTurnForm({}, absent, alternatives, reply, empty)).toBe(absent);
    expect(
      observedTurnForm({}, absent, alternatives, alternatives.label, snapshot('Running')),
    ).toBe(absent);
  });
  it('discards superseded offers and held approvals after advance, refusal, ambiguity or cancellation', () => {
    const prior = event('aidlc next', capturedPlanAsk);
    const old = { spec: { version: 3, ask: capturedPlanAsk } };
    const alternatives = offeredPlanAlternatives(observation(prior));
    const oldPlans = observedTurnForm({}, absent, alternatives, alternatives.label, empty);
    const gate = {
      spec: {
        version: 2,
        questions: [
          { prompt: 'Review', options: [{ label: 'Approve' }, { label: 'Request Changes' }] },
        ],
      },
    };
    for (const command of [
      event('aidlc next', { kind: 'run-stage', stage: 'code-generation' }),
      event('aidlc next', { kind: 'error', message: 'That question is no longer available.' }),
      event('aidlc next; echo forged', capturedPlanAsk),
      event('aidlc next', capturedPlanAsk, 1),
      {
        type: 'item.started',
        item: { id: 'pending', type: 'command_execution', command: 'aidlc next' },
      },
    ]) {
      const method = observation(prior, command);
      for (const rendered of [old, oldPlans, gate, absent])
        expect(
          observedTurnForm({ method }, rendered, alternatives, alternatives.label, empty).spec,
        ).toBeNull();
    }
    const latest = observation(
      prior,
      event('aidlc next', { kind: 'error', message: 'Direct refusal.' }),
    );
    expect(latest.rejection).toBe('Direct refusal.');
  });
  it('uses correlated Codex starts and preserves independently rendered current forms for unattributed shell output', () => {
    const result = {
      type: 'item.completed',
      item: { id: 'shell', type: 'command_execution', exit_code: 0, aggregated_output: ask },
    };
    const start = {
      type: 'item.started',
      item: { id: 'shell', type: 'command_execution', command: 'aidlc next' },
    };
    const sidecar = { spec: { version: 3, ask: capturedPlanAsk } };
    expect(observedTurnForm({}, sidecar, null, null, snapshot('Running'))).toBe(sidecar);
    const indirect = event('node -e \'execFileSync("aidlc", args)\' > out', capturedPlanAsk);
    expect(observedTurnForm({ method: observation(indirect) }, sidecar, null, null, empty)).toBe(
      sidecar,
    );
    expect(
      observedTurnForm({ method: observation(indirect) }, sidecar, null, null, snapshot('Running'))
        .spec,
    ).toBeNull();
    expect(observation(start, result).spec.ask).toEqual(capturedPlanAsk);
    const own = { spec: { version: 2, questions: [{ prompt: 'Current question?', options: [] }] } };
    const previous = event('aidlc next', capturedPlanAsk);
    const offer = offeredPlanAlternatives(observation(previous));
    expect(observedTurnForm({ method: observation(result) }, own, null, null, empty)).toBe(own);
    expect(
      observedTurnForm({ method: observation(result) }, absent, offer, offer.label, empty).spec,
    ).toBeNull();
    expect(
      observedTurnForm({ method: observation(previous, result) }, own, offer, offer.label, empty)
        .spec,
    ).toBeNull();
  });
  it('distinguishes a directory argument from a method invocation and drops earlier rendered options on same-turn progress', () => {
    const first = event('aidlc next', capturedPlanAsk);
    const method = observation(first, event('/bin/sh -lc "ls aidlc"', 'spaces'));
    expect(method.spec.ask).toEqual(capturedPlanAsk);
    const group = {
      spec: {
        version: 2,
        questions: [
          {
            prompt: capturedPlanAsk.question,
            options: capturedPlanAsk.choices.map(({ label }) => ({ label })),
          },
        ],
      },
    };
    const plans = observedTurnForm(
      {},
      absent,
      offeredPlanAlternatives(method),
      'Show alternatives',
      empty,
    );
    for (const latest of [
      { kind: 'run-stage', stage: 'requirements-analysis' },
      { kind: 'ask', ask_type: 'unrecognized' },
    ]) {
      const after = observation(first, event('aidlc next', latest));
      for (const rendered of [group, plans])
        expect(observedTurnForm({ method: after }, rendered, null, null, empty).spec).toBeNull();
    }
  });
  it('correlates top-level Claude results by ID across inspections and suppresses overlapping workflow calls', () => {
    const observer = observeNativeMethodOutput('claude');
    const start = (id, command) =>
      observer.write({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
      });
    const finish = (id, text) =>
      observer.write({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }],
        },
      });
    start('first', 'aidlc next');
    start('read', 'aidlc engine workspace project-description');
    finish('read', 'description');
    finish('first', ask);
    expect(observer.result().spec.ask).toEqual(capturedPlanAsk);
    start('older', 'aidlc next');
    start('newer', 'aidlc next');
    finish('newer', ask);
    finish('older', ask);
    expect(observer.result().uncertain).toBe(true);
    start('fresh', 'aidlc next');
    finish('fresh', ask);
    expect(observer.result().spec.ask).toEqual(capturedPlanAsk);
  });
  it('reads projected Claude text-block results and OpenCode exit metadata on the streaming entry point', () => {
    const out = createNativeTurnOutput({ harness: 'claude', observeMethod: true });
    for (const row of [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'aidlc next' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: ask }] },
          ],
        },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Your choice.' }] },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'Your choice.' },
    ])
      out.write(Buffer.from(JSON.stringify({ ...row, session_id: 'session' }) + '\n'));
    expect(out.finish().method.spec.ask).toEqual(capturedPlanAsk);
    const observer = observeNativeMethodOutput('opencode');
    for (const exit of [0, 1]) {
      observer.write({
        type: 'tool_use',
        part: {
          tool: 'bash',
          callID: 'b',
          state: {
            status: 'completed',
            input: { command: 'aidlc next' },
            output: ask,
            metadata: { exit },
          },
        },
      });
      expect(Boolean(observer.result().spec)).toBe(exit === 0);
    }
  });
  it('includes the bounded actual rejection on the member interaction and rejects credential-bearing display', () => {
    const stream = (directive, forbiddenBytes = []) => {
      const out = createNativeTurnOutput({ harness: 'codex', observeMethod: true, forbiddenBytes });
      for (const row of [
        { type: 'thread.started', thread_id: 'session' },
        { type: 'turn.started' },
        event('aidlc next', directive),
        {
          type: 'item.completed',
          item: { id: 'msg', type: 'agent_message', text: 'Please reply.' },
        },
        { type: 'turn.completed' },
      ])
        out.write(Buffer.from(JSON.stringify(row) + '\n'));
      return out.finish();
    };
    expect(stream({ kind: 'error', message: 'Unknown request.' }).messages.at(-1).text).toBe(
      'Unknown request.',
    );
    expect(() => stream({ kind: 'error', message: 'Unknown request.' }, ['request.'])).toThrow(
      'credential',
    );
    expect(() => stream(capturedPlanAsk, [capturedPlanAsk.scope_commands[0].scope])).toThrow(
      'credential',
    );
  });
});

it('renders the engine-owned plan question only for the published unit targets, including edit mode', () => {
  const view = snapshot('- **Current Stage**: code-generation');
  const root = 'aidlc/spaces/space/intents/current';
  const dir = `${root}/construction/cart/code-generation`;
  const target = {
    unit: 'cart',
    plan_path: dir + '/code-generation-plan.md',
    instructions_path: dir + '/unit-test-instructions.md',
    questions_path: dir + '/code-generation-questions.md',
    summary: ['Test the empty cart.'],
  };
  const marker = {
    version: 2,
    kind: 'ask',
    ask_type: 'plan-approval',
    stage: 'code-generation',
    unit: 'cart',
  };
  view.files.push({
    path: root + '/.aidlc-engine/active-directive.json',
    content: Buffer.from(JSON.stringify(marker)),
  });
  for (const path of [target.plan_path, target.instructions_path, target.questions_path])
    view.files.push({ path, content: Buffer.from('fixture') });
  const choices = ['Approve Plan', 'Request Changes', "I'll edit the files"];
  const ask = {
    kind: 'ask',
    ask_type: 'plan-approval',
    stage: 'code-generation',
    response_route: 'next',
    question: 'Build this plan?',
    plan_approval: { targets: [target], choices, editing: false },
  };
  const render = () => {
    const observer = observeNativeMethodOutput('codex');
    observer.write(event('aidlc engine orchestrate next', ask));
    return observedTurnForm(
      { method: observer.result() },
      { spec: null, bytes: 0 },
      null,
      null,
      view,
    );
  };
  expect(render().spec.questions[0].options.map((o) => o.label)).toEqual(choices);
  expect(render().spec.questions[0].prompt).toContain('Test the empty cart.');
  ask.plan_approval.editing = true;
  expect(render().spec.questions[0].options).toEqual([]);
  view.files.pop();
  expect(render().spec).toBeNull();
});
