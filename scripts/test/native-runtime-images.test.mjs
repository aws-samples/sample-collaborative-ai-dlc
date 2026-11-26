import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredPins, scopeHash } from '../native-runtime-images.mjs';

const REPO = '123456789012.dkr.ecr.us-east-1.amazonaws.com/aidlc-agentcore-dev';
const pin = (hex) => ({ uri: `${REPO}@sha256:${hex.repeat(64)}`, digest: `sha256:${hex.repeat(64)}` });
const row = (id, status, image, extra = {}) => ({
  sk: 'EXECUTION',
  scope: { projectId: 'project-one', executionId: id },
  status,
  configuration: { image, prompt: 'must never be printed' },
  runtimeSessionId: 'must-never-be-printed',
  ...extra,
});

test('lists every pin still required by resumable runs and retained checkpoints', () => {
  const pins = requiredPins([
    row('a', 'AWAITING_USER', pin('a')),
    row('b', 'WAITING_FOR_INPUT', pin('a')),
    row('c', 'RECOVERY_REQUIRED', pin('b'), { recoveryCheckpoint: { id: 'x' } }),
    row('d', 'RECOVERY_REQUIRED', pin('c')),
    row('e', 'FAILED', pin('d')),
    row('f', 'RUNNING', pin('e')),
  ]);
  assert.deepEqual(
    pins.map((entry) => [entry.digest.slice(7, 8), entry.runs.map((run) => run.status)]),
    [
      ['a', ['AWAITING_USER', 'WAITING_FOR_INPUT']],
      ['b', ['RECOVERY_REQUIRED']],
      ['e', ['RUNNING']],
    ],
  );
  const printed = JSON.stringify(pins);
  assert.ok(!printed.includes('must never be printed'));
  assert.ok(!printed.includes('must-never-be-printed'));
  assert.equal(pins[0].runs[0].scope, scopeHash({ projectId: 'project-one', executionId: 'a' }));
});

test('has no fixed limit on the number of retained pins', () => {
  const rows = Array.from({ length: 40 }, (_, index) => {
    const hex = index.toString(16).padStart(64, '0');
    return row(String(index), 'AWAITING_USER', {
      uri: `${REPO}@sha256:${hex}`,
      digest: `sha256:${hex}`,
    });
  });
  assert.equal(requiredPins(rows).length, 40);
});
