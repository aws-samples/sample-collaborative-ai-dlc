// test/e2e/cleanup-e2e.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDelete, ageMinutesFrom, FORCE_FLOOR_MIN } from './cleanup-e2e.mjs';

test('ageMinutesFrom parses e2e-<epochMs> names', () => {
  const now = 10 * 60000; // 10 minutes since epoch
  assert.equal(ageMinutesFrom('e2e-0', now), 10);
  assert.equal(ageMinutesFrom('e2e-300000', now), 5); // 5 min old
});

test('ageMinutesFrom returns null for non-matching / invalid names', () => {
  assert.equal(ageMinutesFrom('not-an-e2e-project', 0), null);
  assert.equal(ageMinutesFrom('', 0), null);
  assert.equal(ageMinutesFrom(null, 0), null);
});

test('shouldDelete: old enough (no force) -> deletable', () => {
  const r = shouldDelete({ age: 120, minAgeMin: 90, force: false });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'age-ok');
});

test('shouldDelete: too recent (no force) -> skipped', () => {
  const r = shouldDelete({ age: 10, minAgeMin: 90, force: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too-recent/);
});

test('shouldDelete: unknown age is never deletable', () => {
  const r = shouldDelete({ age: null, minAgeMin: 90, force: true, isForceTarget: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-age');
});

test('shouldDelete: force only applies to the explicit force target', () => {
  // recent + force but NOT the target => still guarded by minAgeMin
  const notTarget = shouldDelete({ age: 10, minAgeMin: 90, force: true, isForceTarget: false });
  assert.equal(notTarget.ok, false);
  assert.match(notTarget.reason, /too-recent/);

  // recent + force + is the target, and above the floor => deletable
  const target = shouldDelete({
    age: FORCE_FLOOR_MIN + 1,
    minAgeMin: 90,
    force: true,
    isForceTarget: true,
  });
  assert.equal(target.ok, true);
  assert.equal(target.reason, 'forced');
});

test('shouldDelete: --force NEVER deletes below the floor (prevents wiping an active run)', () => {
  const r = shouldDelete({
    age: FORCE_FLOOR_MIN - 1,
    minAgeMin: 90,
    force: true,
    isForceTarget: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /below-force-floor/);
});

test('shouldDelete: force at exactly the floor is deletable (boundary)', () => {
  const r = shouldDelete({ age: FORCE_FLOOR_MIN, minAgeMin: 90, force: true, isForceTarget: true });
  assert.equal(r.ok, true);
});

test('FORCE_FLOOR_MIN is a small positive guard (~5min)', () => {
  assert.ok(FORCE_FLOOR_MIN > 0 && FORCE_FLOOR_MIN <= 10);
});
