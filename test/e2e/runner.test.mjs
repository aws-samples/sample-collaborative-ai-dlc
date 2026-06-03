// test/e2e/runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTasks, inspectExistingReview } from './runner.mjs';

// H3: tasks response shape handling + failed/done distinction.
test('classifyTasks handles { tasks: [...] } envelope', () => {
  const c = classifyTasks({ tasks: [{ status: 'done' }, { status: 'done' }] });
  assert.deepEqual(c, { settled: true, anyDone: true, anyFailed: false, count: 2 });
});

test('classifyTasks handles a bare array', () => {
  const c = classifyTasks([{ status: 'done' }]);
  assert.equal(c.settled, true);
  assert.equal(c.anyDone, true);
  assert.equal(c.count, 1);
});

test('classifyTasks treats unknown/empty shapes as no tasks (not settled)', () => {
  assert.deepEqual(classifyTasks(null), {
    settled: false,
    anyDone: false,
    anyFailed: false,
    count: 0,
  });
  assert.deepEqual(classifyTasks({}), {
    settled: false,
    anyDone: false,
    anyFailed: false,
    count: 0,
  });
  assert.deepEqual(classifyTasks({ tasks: [] }), {
    settled: false,
    anyDone: false,
    anyFailed: false,
    count: 0,
  });
});

test('classifyTasks: all-failed is settled but NOT done', () => {
  const c = classifyTasks({ tasks: [{ status: 'failed' }, { status: 'failed' }] });
  assert.equal(c.settled, true);
  assert.equal(c.anyDone, false);
  assert.equal(c.anyFailed, true);
});

test('classifyTasks: mixed done+failed is settled, done and failed both true', () => {
  const c = classifyTasks({ tasks: [{ status: 'done' }, { status: 'failed' }] });
  assert.equal(c.settled, true);
  assert.equal(c.anyDone, true);
  assert.equal(c.anyFailed, true);
});

test('classifyTasks: any in-flight task is not settled', () => {
  const c = classifyTasks({ tasks: [{ status: 'done' }, { status: 'running' }] });
  assert.equal(c.settled, false);
});

// H2: existing review pre-flight decision.
test('inspectExistingReview: absent/null review -> proceed', () => {
  assert.deepEqual(inspectExistingReview(null), { failFast: false, alreadyComplete: false });
  assert.deepEqual(inspectExistingReview(undefined), { failFast: false, alreadyComplete: false });
});

test('inspectExistingReview: both reviews, fresh -> alreadyComplete', () => {
  const r = inspectExistingReview({ blindReview: 'b', fullReview: 'f', status: 'PASSED' });
  assert.equal(r.alreadyComplete, true);
  assert.equal(r.failFast, false);
  assert.equal(r.state.hasBlind, true);
  assert.equal(r.state.hasFull, true);
});

test('inspectExistingReview: non-stale partial (one review) -> failFast review-stale-partial', () => {
  const r = inspectExistingReview({ blindReview: 'b', fullReview: null });
  assert.equal(r.failFast, true);
  assert.equal(r.reason, 'review-stale-partial');
});

test('inspectExistingReview: stale review -> failFast review-stale-partial', () => {
  const r = inspectExistingReview({ blindReview: 'b', fullReview: 'f', stale: true });
  assert.equal(r.failFast, true);
  assert.equal(r.reason, 'review-stale-partial');
});

test('inspectExistingReview: fresh empty node (no reviews) -> proceed', () => {
  const r = inspectExistingReview({ blindReview: null, fullReview: null });
  assert.equal(r.failFast, false);
  assert.equal(r.alreadyComplete, false);
});
