// test/e2e/teardown.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupAdvisory } from './teardown.mjs';

test('cleanupAdvisory: clean full deletion -> null (no warning)', () => {
  const r = cleanupAdvisory(
    { sprintDeleted: true, projectDeleted: true },
    { projectId: 'p1', sprintId: 's1' },
  );
  assert.equal(r, null);
});

test('cleanupAdvisory: cleanup error surfaces a warning', () => {
  const r = cleanupAdvisory(
    { sprintDeleted: false, projectDeleted: false, error: 'boom' },
    { projectId: 'p1', sprintId: 's1' },
  );
  assert.ok(r);
  assert.match(r, /error: boom/);
  assert.match(r, /p1 not deleted/);
  assert.match(r, /s1 not deleted/);
});

test('cleanupAdvisory: project left behind without explicit error still warns', () => {
  const r = cleanupAdvisory(
    { sprintDeleted: true, projectDeleted: false },
    { projectId: 'p1', sprintId: 's1' },
  );
  assert.ok(r);
  assert.match(r, /p1 not deleted/);
});

test('cleanupAdvisory: a rejected call shaped { error } warns', () => {
  const r = cleanupAdvisory({ error: 'network down' }, { projectId: 'p1' });
  assert.ok(r);
  assert.match(r, /network down/);
});

test('cleanupAdvisory: missing/empty input -> null', () => {
  assert.equal(cleanupAdvisory(null), null);
  assert.equal(cleanupAdvisory(undefined), null);
  assert.equal(cleanupAdvisory({}, {}), null);
});
