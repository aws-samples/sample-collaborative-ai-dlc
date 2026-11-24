import { describe, expect, it } from 'vitest';
import {
  observeNativeMethodOutput,
  observedTurnForm,
  offeredPlanAlternatives,
} from '../native/method-output.js';
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
      done + '\n- [?] code-generation',
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
  it('only presents carried plan names on the exact commandless continuation that shows them', () => {
    const observer = observeNativeMethodOutput('codex');
    observer.write(event('aidlc next', capturedPlanAsk));
    const alternatives = offeredPlanAlternatives(observer.result());
    const absent = { reason: 'absent', spec: null };
    const display = { messages: [{ text: alternatives.options.map((o) => o.label).join(', ') }] };
    expect(
      observedTurnForm(display, absent, alternatives, alternatives.label, { files: [] }).spec
        .questions[0].options,
    ).toEqual(alternatives.options);
    expect(observedTurnForm(display, absent, alternatives, 'express', { files: [] })).toBe(absent);
    expect(
      observedTurnForm(
        { ...display, method: { observed: true } },
        absent,
        alternatives,
        alternatives.label,
        { files: [] },
      ),
    ).toBe(absent);
    expect(
      observedTurnForm(display, absent, alternatives, alternatives.label, snapshot('Running')),
    ).toBe(absent);
  });
});
