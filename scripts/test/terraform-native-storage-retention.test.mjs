import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const inspector = fileURLToPath(new URL('../inspect-terraform-plan.mjs', import.meta.url));

function inspect(actions) {
  const directory = mkdtempSync(join(tmpdir(), 'aidlc-efs-retention-'));
  try {
    const plan = join(directory, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        resource_changes: [
          {
            address: 'module.native_runs[0].aws_efs_file_system.runs',
            type: 'aws_efs_file_system',
            change: { actions },
          },
        ],
      }),
    );
    return spawnSync(process.execPath, [inspector, plan], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('rejects removing or replacing native working files even when the pilot is disabled', () => {
  for (const actions of [['delete'], ['delete', 'create'], ['create', 'delete']]) {
    const result = inspect(actions);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /aws_efs_file_system\.runs/);
  }
});

test('allows creating, updating or retaining the native filesystem', () => {
  for (const actions of [['create'], ['update'], ['no-op']]) {
    const result = inspect(actions);
    assert.equal(result.status, 0, result.stderr);
  }
});
