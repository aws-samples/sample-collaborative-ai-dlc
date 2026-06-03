// test/e2e/cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './cli.mjs';

test('parseArgs maps value flags with space-separated values', () => {
  const out = parseArgs(['--scenario', 'multi-changed', '--phases', 'inception,construction']);
  assert.equal(out.E2E_SCENARIO, 'multi-changed');
  assert.equal(out.E2E_PHASES, 'inception,construction');
});

test('parseArgs maps value flags with = syntax', () => {
  const out = parseArgs(['--scenario=review-cycle', '--out=/tmp/e2e']);
  assert.equal(out.E2E_SCENARIO, 'review-cycle');
  assert.equal(out.E2E_OUT_DIR, '/tmp/e2e');
});

test('parseArgs handles boolean flags and negation', () => {
  assert.equal(parseArgs(['--skip-cleanup']).E2E_SKIP_CLEANUP, 'true');
  assert.equal(parseArgs(['--teardown']).E2E_TEARDOWN, 'true');
  assert.equal(parseArgs(['--no-expect-prs']).E2E_EXPECT_PRS, 'false');
  assert.equal(parseArgs(['--expect-prs']).E2E_EXPECT_PRS, 'true');
});

test('parseArgs ignores unknown flags and non-flag tokens', () => {
  const out = parseArgs(['positional', '--unknown', 'x', '--scenario', 'single-repo']);
  assert.deepEqual(out, { E2E_SCENARIO: 'single-repo' });
});

test('parseArgs maps expected-changed-repos', () => {
  const out = parseArgs(['--expected-changed-repos', 'org/a,org/b']);
  assert.equal(out.E2E_EXPECTED_CHANGED_REPOS, 'org/a,org/b');
});

test('parseArgs returns empty object for no args', () => {
  assert.deepEqual(parseArgs([]), {});
});
