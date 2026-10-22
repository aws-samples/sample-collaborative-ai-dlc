import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { requiredPins, scopeHash } from '../native-runtime-images.mjs';

const REPO = '123456789012.dkr.ecr.us-east-1.amazonaws.com/aidlc-agentcore-dev';
const pin = (hex) => ({
  uri: `${REPO}@sha256:${hex.repeat(64)}`,
  digest: `sha256:${hex.repeat(64)}`,
});
const row = (id, status, image, extra = {}) => ({
  sk: 'EXECUTION',
  scope: { projectId: 'project-one', executionId: id },
  status,
  configuration: { image, prompt: 'must never be printed' },
  runtimeSessionId: 'must-never-be-printed',
  ...extra,
});

for (const architecture of ['arm64', 'amd64']) {
  test(`native-only signature verifier installation respects ${architecture} image architecture`, () => {
    const dockerfile = readFileSync(
      new URL('../../lambda/agentcore/Dockerfile', import.meta.url),
      'utf8',
    );
    const install = dockerfile
      .split(/^ARG GH_SHA256=.*\n/m)[1]
      ?.match(/^RUN ([\s\S]*?)(?:\n\n|$)/)?.[1]
      .replace(/\\\n/g, '');
    assert.ok(install, 'expected the native verifier installation recipe');
    // Execute the actual shell branch with inert command ports. No downloads,
    // host installation, CLI invocation or source extraction can occur.
    const output = execFileSync(
      '/bin/sh',
      [
        '-ec',
        `
curl() { printf 'download\\n'; }
sha256sum() { cat >/dev/null; printf 'checksum\\n'; }
tar() { printf 'extract\\n'; }
install() { printf 'install %s\\n' "$*"; }
rm() { :; }
${install}`,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          TARGETARCH: architecture,
          GH_VERSION: '2.101.0',
          GH_SHA256: 'fixture',
        },
      },
    );
    if (architecture === 'arm64') {
      assert.match(
        output,
        /download\nchecksum\nextract\ninstall -m 0755 \/tmp\/gh_2\.101\.0_linux_arm64\/bin\/gh \/usr\/local\/bin\/gh/,
      );
    } else {
      assert.equal(output, '', 'amd64 must not receive an ARM64 native-only executable');
    }
  });
}

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

test('the deployment inventory keeps a workspace recovery image without a private checkpoint', () => {
  const execution = row('resume', 'RECOVERING', pin('a'));
  execution.configuration.recoveryMode = 'efs-workspace-v1';
  assert.equal(requiredPins([execution])[0].digest, pin('a').digest);
  assert.deepEqual(requiredPins([{ ...execution, status: 'FAILED' }]), []);
});
