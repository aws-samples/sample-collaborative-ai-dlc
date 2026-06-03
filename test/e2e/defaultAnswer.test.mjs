// test/e2e/defaultAnswer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPending, buildDefaultAnswer } from './defaultAnswer.mjs';

test('isPending true when no structuredAnswer', () => {
  assert.equal(isPending({ id: 'q1' }), true);
  assert.equal(isPending({ id: 'q1', structuredAnswer: { answers: [] } }), false);
});

test('buildDefaultAnswer picks first option per sub-question', () => {
  const q = {
    id: 'q1',
    questions: [
      { text: 'A?', type: 'single', options: [{ label: 'x' }, { label: 'y' }] },
      { text: 'B?', type: 'multi', options: [{ label: 'p' }, { label: 'q' }] },
    ],
  };
  assert.deepEqual(buildDefaultAnswer(q), {
    answers: [{ selectedOptions: [0] }, { selectedOptions: [0] }],
  });
});

test('buildDefaultAnswer handles no-option questions with freeText', () => {
  const q = { id: 'q2', questions: [{ text: 'Free?', type: 'single', options: [] }] };
  assert.deepEqual(buildDefaultAnswer(q), {
    answers: [{ selectedOptions: [], freeText: 'Proceed with the recommended default.' }],
  });
});

test('buildDefaultAnswer tolerates missing questions array', () => {
  assert.deepEqual(buildDefaultAnswer({ id: 'q3' }), { answers: [] });
});

test('isPending true for null and undefined', () => {
  assert.equal(isPending(null), true);
  assert.equal(isPending(undefined), true);
});

test('buildDefaultAnswer treats null sub-question as no-options branch', () => {
  assert.deepEqual(buildDefaultAnswer({ questions: [null] }), {
    answers: [{ selectedOptions: [], freeText: 'Proceed with the recommended default.' }],
  });
});

test('buildDefaultAnswer tolerates non-array questions', () => {
  assert.deepEqual(buildDefaultAnswer({ questions: 'notArray' }), { answers: [] });
});
