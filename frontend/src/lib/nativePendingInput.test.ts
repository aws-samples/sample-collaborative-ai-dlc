import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  nativeAnswerText,
  nativePendingInput,
  nativeSelectionPayload,
  nativeFormError,
} from './nativePendingInput';
// @ts-expect-error Verify both trust boundaries against the same mutations.
import { nativePendingInput as backendPendingInput } from '../../../lambda/shared/native-pending-input.js';

// Same vectors as lambda/shared/test/native-pending-input.test.js: the
// controller rejects a reply whose text differs from its own rendering.
const gate = nativePendingInput({
  schemaVersion: 2,
  kind: 'approval',
  source: 'engine-gate',
  stage: 'requirements-analysis',
  questions: [
    {
      id: 'q1',
      prompt: 'Proceed?',
      header: 'Approval',
      multiSelect: false,
      options: [
        { label: 'Approve', description: null },
        { label: 'Request Changes', description: null },
      ],
    },
  ],
});
const batch = nativePendingInput({
  schemaVersion: 2,
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

describe('native answer rendering parity', () => {
  it.each([
    (value: Record<string, unknown>) => {
      value.schemaVersion = 1;
    },
    (value: Record<string, unknown>) => {
      value.stage = ['requirements-analysis'];
    },
    (value: Record<string, unknown>) => {
      value.stage = null;
    },
    (value: Record<string, unknown>) => {
      value.questions = [{ ...gate.questions[0], prompt: 'x'.repeat(2001) }];
    },
    (value: Record<string, unknown>) => {
      value.questions = [{ ...gate.questions[0], prompt: 'Question\u0000?' }];
    },
    (value: Record<string, unknown>) => {
      value.questions = [{ ...gate.questions[0], multiSelect: true }];
    },
    (value: Record<string, unknown>) => {
      value.questions = [
        {
          ...gate.questions[0],
          options: [gate.questions[0].options[0], gate.questions[0].options[0]],
        },
      ];
    },
    (value: Record<string, unknown>) => {
      value.questions = [
        {
          ...gate.questions[0],
          options: [
            { label: 'Ship it', description: null },
            { label: 'Revise', description: null },
          ],
        },
      ];
    },
  ])('rejects malformed public pending data at both boundaries %#', (mutate) => {
    const value = structuredClone(gate) as unknown as Record<string, unknown>;
    mutate(value);
    expect(() => backendPendingInput(value)).toThrow();
    expect(() => nativePendingInput(value)).toThrow();
  });

  it('supports the current bounded mixed form and exact gate contract', () => {
    const questions = Array.from({ length: 6 }, (_, index) => ({
      ...batch.questions[0],
      id: `q${index + 1}`,
      header: `Q${index + 1}`,
      ...(index === 5 ? { multiSelect: false, options: [] } : {}),
    }));
    const form = nativePendingInput({ ...batch, schemaVersion: 2, questions });
    const answers = questions.map((_, i) =>
      i === 5
        ? { selectedOptions: [], freeText: 'Must work offline.' }
        : { selectedOptions: [0, 2] },
    );
    expect(nativeFormError(form, { answers })).toBeNull();
    expect(nativeAnswerText(form, { answers })).toContain('6. Q6: Must work offline.');
    expect(nativeFormError(form, { answers: answers.slice(1) })).toBeTruthy();
    expect(
      nativeFormError(form, { answers: answers.map(() => ({ selectedOptions: [] })) }),
    ).toBeTruthy();
    expect(
      nativeFormError(form, {
        answers: answers.map(() => ({ selectedOptions: [], freeText: 'x'.repeat(4001) })),
      }),
    ).toContain('4,000');
    expect(
      nativeFormError(form, {
        answers: answers.map(() => ({ selectedOptions: [], freeText: 'x'.repeat(3000) })),
      }),
    ).toContain('16 KiB');
    expect(() => nativePendingInput({ ...form, schemaVersion: 1 })).toThrow();
    expect(() =>
      nativePendingInput({
        ...form,
        questions: Array.from({ length: 33 }, (_, i) => ({ ...questions[0], id: `q${i + 1}` })),
      }),
    ).toThrow();
    expect(nativeAnswerText(gate, { answers: [{ selectedOptions: [0] }] })).toBe('Approve');
  });

  it('matches the controller rendering', () => {
    expect(nativeAnswerText(gate, { answers: [{ selectedOptions: [0] }] })).toBe('Approve');
    expect(
      nativeAnswerText(gate, {
        answers: [{ selectedOptions: [1], freeText: 'Add offline support.' }],
      }),
    ).toBe('Request Changes\n\nAdd offline support.');
    expect(
      nativeAnswerText(batch, {
        answers: [{ selectedOptions: [2, 0] }, { selectedOptions: [1], freeText: 'but forgiving' }],
      }),
    ).toBe('1. Platforms: Web, Desktop\n2. Difficulty curve?: Steep — but forgiving');
  });
  it('omits blank free text from the submitted selection', () => {
    expect(
      nativeSelectionPayload({ answers: [{ selectedOptions: [0], freeText: '   ' }] }),
    ).toEqual({ answers: [{ selectedOptions: [0] }] });
  });
  it('canonicalizes like the server (sorted keys, nulls kept)', () => {
    expect(canonicalJson({ b: null, a: [{ y: 1, x: 'q' }] })).toBe(
      '{"a":[{"x":"q","y":1}],"b":null}',
    );
  });
  it('rejects malformed presented questions', () => {
    expect(() => nativePendingInput({ ...gate, kind: 'vote' })).toThrow();
    expect(() => nativePendingInput({ ...gate, questions: [] })).toThrow();
  });
  it('accepts up to sixteen options, like the server', () => {
    const choice = (count: number) => ({
      ...batch,
      questions: [
        {
          ...batch.questions[1],
          id: 'q1',
          options: Array.from({ length: count }, (_, index) => ({
            label: `plan-${index}`,
            description: null,
          })),
        },
      ],
    });
    expect(nativePendingInput(choice(12)).questions[0].options).toHaveLength(12);
    expect(nativePendingInput(choice(16)).questions[0].options).toHaveLength(16);
    expect(() => nativePendingInput(choice(17))).toThrow();
  });
});
