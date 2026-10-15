import { describe, expect, it } from 'vitest';
import {
  buildNativePendingInput,
  nativeAnswerText,
  nativePendingInput,
  nativeSelection,
} from '../native-pending-input.js';

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

describe('native pending input capture', () => {
  it('renders an explicit single choice under its visible heading without requiring duplicated prompt prose', () => {
    const spec = {
      version: 2,
      questions: [
        {
          prompt: 'Choose the plan for this task.',
          header: 'Plan',
          options: [{ label: 'compose' }, { label: 'bugfix' }, { label: 'classic' }],
        },
      ],
    };
    const messagesText =
      '**Plan**\n\n- **compose**: tailor the plan\n- **bugfix**: 5 stages\n- **classic**: 14 stages';
    expect(
      buildNativePendingInput({ spec, messagesText })?.questions[0].options.map((o) => o.label),
    ).toEqual(['compose', 'bugfix', 'classic']);
    expect(buildNativePendingInput({ spec, messagesText: 'compose bugfix classic' })).toBeNull();
    expect(buildNativePendingInput({ spec, messagesText: '**Plan** compose bugfix' })).toBeNull();
    expect(buildNativePendingInput({ spec, messagesText, gate: { stage: 'plan' } })).toBeNull();
    expect(
      buildNativePendingInput({
        spec: { ...approvalSpec, version: 2 },
        gate: { stage: 'requirements-analysis' },
        messagesText: '**Approval**\nApprove / Request Changes / Accept as-is',
      }),
    ).toBeNull(); // Valid gate labels/heading cannot replace its full prompt.
    expect(
      buildNativePendingInput({
        spec: {
          version: 2,
          questions: [{ prompt: 'What constraints apply?', header: 'Constraints', options: [] }],
        },
        messagesText: '**Constraints**',
      }),
    ).toBeNull();
  });
  it('captures a complete current-step form with more than four mixed questions', () => {
    const questions = [
      ...Array.from({ length: 5 }, (_, index) => ({
        prompt: `Current question ${index + 1}?`,
        header: `Q${index + 1}`,
        multiSelect: index === 1,
        options: [{ label: 'Small' }, { label: 'Large' }],
      })),
      { prompt: 'What constraints apply?', header: 'Constraints', options: [] },
    ];
    const form = buildNativePendingInput({
      spec: { version: 2, questions },
      messagesText: `${questions.map((q) => q.prompt).join('\n')}\nSmall Large`,
    });
    expect(form?.questions).toHaveLength(6);
    expect(form.schemaVersion).toBe(2);
    const selection = {
      answers: [
        { selectedOptions: [0] },
        { selectedOptions: [1, 0] },
        { selectedOptions: [1] },
        { selectedOptions: [0] },
        { selectedOptions: [1] },
        { selectedOptions: [], freeText: 'Must work offline.' },
      ],
    };
    expect(nativeAnswerText(form, selection)).toBe(
      '1. Q1: Small\n2. Q2: Small, Large\n3. Q3: Large\n4. Q4: Small\n5. Q5: Large\n6. Constraints: Must work offline.',
    );
    for (const answers of [
      selection.answers.slice(0, 5),
      [...selection.answers.slice(0, 5), { selectedOptions: [] }],
    ])
      expect(() => nativeSelection(form, { answers })).toThrow();
    expect(() => nativePendingInput({ ...form, schemaVersion: 1 })).toThrow();
    expect(
      buildNativePendingInput({
        spec: { version: 2, questions },
        messagesText: 'Small Large', // No unpublished prompts, including free-text prompts.
      }),
    ).toBeNull();
    expect(
      buildNativePendingInput({
        gate: { stage: 'requirements-analysis' },
        spec: { version: 2, questions },
        messagesText: `${questions.map((q) => q.prompt).join('\n')}\nSmall Large`,
      }),
    ).toBeNull(); // A stage approval cannot absorb an ordinary question batch.
  });

  it('captures the rendered question spec when every label was shown', () => {
    const input = buildNativePendingInput({ spec: planSpec, messagesText: planChoiceText });
    expect(input).toEqual({
      schemaVersion: 1,
      kind: 'choice',
      source: 'rendered-question',
      stage: null,
      questions: [
        {
          id: 'q1',
          prompt: 'No ready-made plan clearly fits. How should I proceed?',
          header: 'Plan Choice',
          multiSelect: false,
          options: [
            { label: 'Compose', description: 'Tailor a plan to this task' },
            { label: 'Express', description: '9 of 33 stages' },
          ],
        },
      ],
    });
  });

  it("captures AI-DLC 2.11.0's twelve-option plan offer and bounds the option count", () => {
    const plans = [
      'compose',
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
    const text = ['**Plan**', 'Which should I use?', ...plans.map((plan) => `- **${plan}**`)].join(
      '\n',
    );
    const spec = (labels) => ({
      version: 1,
      questions: [
        {
          prompt: 'Which should I use?',
          header: 'Plan',
          options: labels.map((label) => ({ label })),
        },
      ],
    });
    expect(
      buildNativePendingInput({ spec: spec(plans), messagesText: text }).questions[0].options.map(
        (option) => option.label,
      ),
    ).toEqual(plans);
    const many = Array.from({ length: 17 }, (_, index) => `plan-${index}`);
    expect(buildNativePendingInput({ spec: spec(many), messagesText: many.join('\n') })).toBeNull();
  });

  it('never shows options the member was not shown, and tolerates no or bad specs', () => {
    const invented = structuredClone(planSpec);
    invented.questions[0].options.push({ label: 'Approve everything' });
    expect(buildNativePendingInput({ spec: invented, messagesText: planChoiceText })).toBeNull();
    expect(buildNativePendingInput({ spec: null, messagesText: planChoiceText })).toBeNull();
    for (const bad of [
      {},
      { version: 2, questions: [] },
      { ...planSpec, futureProtocol: true },
      { version: 1, questions: [{ prompt: 'x', options: [{ label: 'Only' }] }] },
      { version: 1, questions: [{ prompt: 'x', extra: 1, options: [] }] },
      'text',
      [],
    ]) {
      expect(buildNativePendingInput({ spec: bad, messagesText: planChoiceText })).toBeNull();
    }
  });

  it('requires the complete presented gate protocol instead of synthesizing or dropping choices', () => {
    const gate = { stage: 'requirements-analysis' };
    expect(buildNativePendingInput({ gate, messagesText: 'Ready for review.' })).toBeNull();
    const rendered = buildNativePendingInput(approvalTurn);
    expect(rendered.questions[0].prompt).toBe(
      'Requirements complete. How would you like to proceed?',
    );
    expect(rendered.questions[0].options.map((o) => o.label)).toEqual([
      'Approve',
      'Request Changes',
      'Accept as-is',
    ]);
    expect(rendered.questions[0].options[0].description).toBe('Continue to user stories');
    const incompatible = structuredClone(approvalSpec);
    incompatible.questions[0].options.push({ label: 'Skip review entirely' });
    expect(
      buildNativePendingInput({
        ...approvalTurn,
        spec: incompatible,
        messagesText: `${approvalTurn.messagesText} Skip review entirely`,
      }),
    ).toBeNull();
    expect(
      buildNativePendingInput({ ...approvalTurn, messagesText: 'Approve Accept as-is' }),
    ).toBeNull();
    // A fork's renamed choices are not translated into the platform's labels.
    incompatible.questions[0].options = [{ label: 'Ship it' }, { label: 'Revise' }];
    expect(
      buildNativePendingInput({
        ...approvalTurn,
        spec: incompatible,
        messagesText: 'Ship it or Revise',
      }),
    ).toBeNull();
  });

  it('rejects approval inputs that drop a protocol label or invent one', () => {
    const base = buildNativePendingInput(approvalTurn);
    const missing = structuredClone(base);
    missing.questions[0].options = missing.questions[0].options.filter(
      (o) => o.label !== 'Request Changes',
    );
    missing.questions[0].options.push({ label: 'Approve later', description: null });
    expect(() => nativePendingInput(missing)).toThrow();
    const multi = structuredClone(base);
    multi.questions[0].multiSelect = true;
    expect(() => nativePendingInput(multi)).toThrow();
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
