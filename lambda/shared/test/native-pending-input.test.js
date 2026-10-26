import { describe, expect, it } from 'vitest';
import {
  buildNativePendingInput,
  nativeAnswerText,
  nativePendingInput,
  nativeSelection,
} from '../native-pending-input.js';
import { proposedPlanSpec } from './fixtures/native-plan-ask.js';

const planChoiceText = [
  '**Plan Choice** — No ready-made plan clearly fits. How should I proceed?',
  '1. **Compose** — Tailor a plan to this task (recommended)',
  '2. **Express** — 9 of 33 stages',
  '3. **Other** — Name another scope',
].join('\n');
const planSpec = {
  version: 1,
  questions: [
    {
      prompt: 'No ready-made plan clearly fits. How should I proceed?',
      header: 'Plan Choice',
      multiSelect: false,
      options: [
        { label: 'Compose (Recommended)', description: 'Tailor a plan to this task' },
        { label: 'Express', description: '9 of 33 stages' },
      ],
    },
  ],
};
const approvalSpec = {
  version: 1,
  questions: [
    {
      prompt: 'Requirements complete. How would you like to proceed?',
      header: 'Approval',
      options: [
        { label: 'Approve', description: 'Continue to user stories' },
        { label: 'Request Changes', description: 'Provide revision feedback' },
        { label: 'Accept as-is', description: 'Proceed without further revision' },
      ],
    },
  ],
};
const approvalTurn = {
  gate: { stage: 'requirements-analysis' },
  spec: approvalSpec,
  messagesText: 'Approve Request Changes Accept as-is',
};

describe('native pending input display contract', () => {
  it('preserves every explicit proposed-plan choice, including a choice needing more input', () => {
    const input = buildNativePendingInput({
      spec: proposedPlanSpec,
      gate: { stage: 'requirements-analysis' },
    });
    expect(input?.questions[0].options.map((option) => option.label)).toEqual(
      proposedPlanSpec.ask.choices.map((choice) => choice.label),
    );
    expect(input.kind).toBe('choice'); // Selecting a plan is not a stage approval.
    expect(nativeAnswerText(input, { answers: [{ selectedOptions: [1] }] })).toBe(
      'Use a different plan',
    );
    expect(JSON.stringify(input)).not.toContain('fixture-request');
  });
  it('uses the declared label for a follow-up choice without matching English prose', () => {
    const spec = structuredClone(proposedPlanSpec);
    spec.ask.choices[1].label = 'Compare the available plans';
    const input = buildNativePendingInput({ spec });
    expect(nativeAnswerText(input, { answers: [{ selectedOptions: [1] }] })).toBe(
      'Compare the available plans',
    );
  });
  it.each([
    (ask) => (ask.choices[1].command = 'unoffered command'),
    (ask) => (ask.choices[1].command = null),
    (ask) => (ask.choices[0].command = ask.compose_command),
    (ask) => (ask.choices.at(-1).command = ask.confirm_command),
    (ask) => (ask.choices[1].label = ask.choices[0].label),
    (ask) => (ask.choices[1].label = 'x'.repeat(161)),
    (ask) =>
      ask.choices.splice(1, 0, ...Array.from({ length: 14 }, (_, i) => ({ label: `q${i}` }))),
    (ask) => (ask.ask_type = 'unadvertised-fork'),
  ])('rejects unsupported or unbounded plan choice data without inventing a form', (change) => {
    const spec = structuredClone(proposedPlanSpec);
    change(spec.ask);
    expect(buildNativePendingInput({ spec })).toBeNull();
  });
  it.each(['', 'Different prose', '**Plan**', 'Summary\nOnly one label'])(
    'renders exact explicit definitions independently of prose: %s',
    (messagesText) => {
      const input = buildNativePendingInput({ spec: { ...planSpec, version: 2 }, messagesText });
      expect(input.questions[0].options.map((o) => o.label)).toEqual(['Compose', 'Express']);
      expect(input.questions[0].prompt).toBe(planSpec.questions[0].prompt);
    },
  );
  it('groups mixed current-step questions; requires every answer', () => {
    const questions = [
      ...Array.from({ length: 5 }, (_, i) => ({
        prompt: `Question ${i}?`,
        multiSelect: i === 1,
        options: [{ label: 'Small' }, { label: 'Large' }],
      })),
      { prompt: 'Constraints?', options: [] },
    ];
    const input = buildNativePendingInput({
      spec: { version: 2, questions },
      messagesText: 'See the form.',
    });
    expect(input.questions).toHaveLength(6);
    expect(() =>
      nativeSelection(input, { answers: questions.map(() => ({ selectedOptions: [] })) }),
    ).toThrow();
    expect(() => nativePendingInput({ ...input, schemaVersion: 1 })).toThrow();
  });
  it('keeps summary questions separate from engine approval even at a held marker', () => {
    const gate = { stage: 'requirements-analysis' };
    const summary = {
      version: 2,
      questions: [
        {
          prompt: 'Confirm the summary?',
          options: [{ label: 'Looks correct' }, { label: 'Request changes' }],
        },
      ],
    };
    expect(buildNativePendingInput({ gate, spec: summary }).kind).toBe('choice');
    expect(
      buildNativePendingInput({ ...approvalTurn, messagesText: 'Review the proposal.' }).kind,
    ).toBe('approval');
    expect(buildNativePendingInput({ spec: approvalSpec }).kind).toBe('choice');
    expect(buildNativePendingInput({ gate })).toBeNull();
    const fork = structuredClone(approvalSpec);
    fork.questions[0].options = [{ label: 'Ship it' }, { label: 'Revise' }];
    expect(buildNativePendingInput({ gate, spec: fork }).kind).toBe('choice'); // never translated into approval
  });
  it.each([
    null,
    {},
    { version: 9, questions: [] },
    { version: 2, questions: [] },
    { version: 2, questions: [{ prompt: 'Question?', options: [{ label: 'Only one' }] }] },
    {
      version: 2,
      questions: [
        {
          prompt: 'Question?',
          options: Array.from({ length: 17 }, (_, i) => ({ label: `Option ${i}` })),
        },
      ],
    },
    {
      version: 2,
      questions: [{ prompt: 'Question?', options: [{ label: 'Same' }, { label: 'Same' }] }],
    },
  ])('rejects unusable display shape without inventing questions: %j', (spec) => {
    expect(buildNativePendingInput({ spec })).toBeNull();
  });
  it('retains v1 and refuses malformed stored approvals', () => {
    expect(buildNativePendingInput({ spec: planSpec }).schemaVersion).toBe(1);
    const input = buildNativePendingInput(approvalTurn);
    input.questions[0].options = [
      { label: 'Approve', description: null },
      { label: 'Skip', description: null },
    ];
    expect(() => nativePendingInput(input)).toThrow();
  });
  it('uses typed engine asks, not a universal production scope list or shell execution', () => {
    const ask = {
      kind: 'ask',
      ask_type: 'compose-offer',
      response_route: 'next',
      question: 'Choose a plan?',
      compose_command: 'aidlc engine orchestrate next compose --request fixture-request',
      scope_commands: [
        {
          scope: 'custom-a',
          command: 'aidlc next --scope custom-a --request fixture-request',
          stages: '3 stages',
        },
        { scope: 'custom-b', command: 'aidlc next --scope custom-b --request fixture-request' },
      ],
    };
    const input = buildNativePendingInput({ spec: { version: 3, ask } });
    expect(input.questions[0].options.map((o) => o.label)).toEqual([
      'compose',
      'custom-a',
      'custom-b',
    ]);
    expect(nativeAnswerText(input, { answers: [{ selectedOptions: [2] }] })).toBe('custom-b');
    expect(JSON.stringify(input)).not.toContain('--request');
    expect(
      buildNativePendingInput({
        spec: { version: 3, ask: { ...ask, response_route: 'arbitrary-fork' } },
      }),
    ).toBeNull();
    const confirm = {
      ...ask,
      ask_type: 'scope-confirm',
      proposed_scope: 'custom-a',
      confirm_command: ask.scope_commands[0].command,
      choices: [
        { label: 'Use the offered plan', command: ask.scope_commands[0].command },
        { label: 'Tailor the plan', command: ask.compose_command },
      ],
    };
    expect(
      buildNativePendingInput({ spec: { version: 3, ask: confirm } }).questions[0].options.map(
        (o) => o.label,
      ),
    ).toEqual(['Use the offered plan', 'Tailor the plan']);
  });
});

describe('native answer rendering', () => {
  const choice = buildNativePendingInput({ spec: planSpec, messagesText: planChoiceText });
  const gate = buildNativePendingInput(approvalTurn);
  it('sends the bare exact label for one question, never a number', () => {
    expect(nativeAnswerText(choice, { answers: [{ selectedOptions: [0] }] })).toBe('Compose');
    expect(nativeAnswerText(gate, { answers: [{ selectedOptions: [0] }] })).toBe('Approve');
  });
  it('keeps request-changes feedback separate from the decision label', () => {
    expect(
      nativeAnswerText(gate, {
        answers: [{ selectedOptions: [1], freeText: 'Add offline support.' }],
      }),
    ).toBe('Request Changes\n\nAdd offline support.');
  });
  it('sends free text alone for Other, and one line per question for batches', () => {
    expect(
      nativeAnswerText(choice, {
        answers: [{ selectedOptions: [], freeText: 'Use the bugfix scope' }],
      }),
    ).toBe('Use the bugfix scope');
    const batch = nativePendingInput({
      schemaVersion: 1,
      kind: 'choice',
      source: 'rendered-question',
      stage: null,
      questions: [
        {
          id: 'q1',
          prompt: 'Which platforms?',
          header: 'Platforms',
          multiSelect: true,
          options: [
            { label: 'Web', description: null },
            { label: 'Mobile', description: null },
            { label: 'Desktop', description: null },
          ],
        },
        {
          id: 'q2',
          prompt: 'Difficulty curve?\nPick one.',
          header: null,
          multiSelect: false,
          options: [
            { label: 'Gentle', description: null },
            { label: 'Steep', description: null },
          ],
        },
      ],
    });
    expect(
      nativeAnswerText(batch, {
        answers: [{ selectedOptions: [2, 0] }, { selectedOptions: [1], freeText: 'but forgiving' }],
      }),
    ).toBe('1. Platforms: Web, Desktop\n2. Difficulty curve?: Steep — but forgiving');
  });
  it('rejects selections that do not fit the presented question', () => {
    for (const bad of [
      { answers: [] },
      { answers: [{ selectedOptions: [5] }] },
      { answers: [{ selectedOptions: [0, 1] }] },
      { answers: [{ selectedOptions: [0, 0] }] },
      { answers: [{ selectedOptions: [] }] },
      { answers: [{ selectedOptions: [0], extra: true }] },
      { answers: [{ selectedOptions: [0], freeText: 'bad\u0007control' }] },
      { answers: [{ selectedOptions: [0] }], approved: true },
    ]) {
      expect(() => nativeSelection(choice, bad)).toThrow();
    }
  });
});

it('does not coerce malformed header/description objects into an apparently valid form', () => {
  for (const field of ['header', 'description']) {
    const spec = structuredClone(approvalSpec);
    if (field === 'header') spec.questions[0].header = { private: 'ignored' };
    else spec.questions[0].options[0].description = { private: 'ignored' };
    expect(buildNativePendingInput({ ...approvalTurn, spec })).toBeNull();
  }
});
