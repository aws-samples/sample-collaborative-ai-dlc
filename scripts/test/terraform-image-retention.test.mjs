import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const inspector = fileURLToPath(new URL('../inspect-terraform-plan.mjs', import.meta.url));

function inspect({ actions, before, after, address, type = 'docker_registry_image' }) {
  const directory = mkdtempSync(join(tmpdir(), 'aidlc-image-retention-'));
  try {
    const plan = join(directory, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        resource_changes: [
          {
            address:
              address ?? 'module.agentcore.module.agentcore_image_build.docker_registry_image.this',
            type,
            change: { actions, before, after },
          },
        ],
      }),
    );
    return spawnSync(process.execPath, [inspector, plan], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('rejects replacement when only the new image has remote retention', () => {
  for (const actions of [
    ['delete', 'create'],
    ['create', 'delete'],
  ]) {
    const result = inspect({
      actions,
      before: { keep_remotely: false },
      after: { keep_remotely: true },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docker_registry_image/);
  }
});

test('rejects deleting a pinned image with missing or false prior retention', () => {
  for (const before of [{}, { keep_remotely: false }]) {
    const result = inspect({
      actions: ['delete'],
      before,
      after: null,
      address: 'module.agentcore.module.agentcore_docker_build.docker_registry_image.this',
    });
    assert.equal(result.status, 1);
  }
});

test('allows replacement when the prior image is retained remotely', () => {
  const result = inspect({
    actions: ['delete', 'create'],
    before: { keep_remotely: true },
    after: { keep_remotely: true },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('allows forgetting the legacy build record without destroying the image', () => {
  const result = inspect({
    actions: ['forget'],
    before: { keep_remotely: false },
    after: null,
    address: 'module.agentcore.module.agentcore_docker_build.docker_registry_image.this',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('allows the first retained build and an in-place retention update', () => {
  for (const actions of [['create'], ['update']]) {
    const result = inspect({
      actions,
      before: actions[0] === 'create' ? null : { keep_remotely: false },
      after: { keep_remotely: true },
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('rejects destroying the runtime image repository that retained pins reference', () => {
  for (const actions of [['delete'], ['delete', 'create']]) {
    const result = inspect({
      actions,
      before: { name: 'collaborative-ai-dlc-agentcore-dev', force_delete: true },
      after: actions.length > 1 ? { name: 'collaborative-ai-dlc-agentcore-dev' } : null,
      address: 'module.agentcore.aws_ecr_repository.agentcore',
      type: 'aws_ecr_repository',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /aws_ecr_repository/);
  }
});

test('allows an in-place update of the runtime image repository', () => {
  const result = inspect({
    actions: ['update'],
    before: { name: 'collaborative-ai-dlc-agentcore-dev' },
    after: { name: 'collaborative-ai-dlc-agentcore-dev' },
    address: 'module.agentcore.aws_ecr_repository.agentcore',
    type: 'aws_ecr_repository',
  });
  assert.equal(result.status, 0, result.stderr);
});
