import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSource } from '../complexity-analysis.mjs';
import { attachCoverage, collectCoverage } from '../complexity-coverage.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('collects real Vitest/V8 outcomes and binds them to source and revision', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'complexity-v8-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'lambda/demo'), { recursive: true });
  await symlink(resolve(root, 'node_modules'), join(cwd, 'node_modules'));
  const source = `export function outer(x) {
  function inner(y) { if (y === 2) return 20; return 10; }
  if (x) return inner(x);
  return 0;
}
export function neverCalled(x) { if (x) return 1; return 0; }
export function choose(x) { return x ? () => { if (x > 1) return 2; return 1; } : () => 0; }
`;
  await writeFile(join(cwd, 'lambda/demo/index.js'), source);
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(cwd, 'vitest.config.js'),
    `export default { test: {
    include: ['sample.test.js'],
    coverage: { provider: 'v8', reporter: ['json'], include: ['lambda/**/*.js'] }
  } };`,
  );
  await writeFile(
    join(cwd, 'sample.test.js'),
    `import { test, expect } from 'vitest';
import { outer, choose } from './lambda/demo/index.js';
test('one path', () => { expect(outer(1)).toBe(10); expect(choose(1)()).toBe(1); });
`,
  );
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', 'lambda', 'package.json', 'vitest.config.js', 'sample.test.js');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  );
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage'],
    {
      cwd,
      stdio: 'pipe',
      timeout: 60000,
    },
  );
  const snapshot = await collectCoverage({
    cwd,
    input: join(cwd, 'coverage/coverage-final.json'),
    successful: true,
  });
  const functions = attachCoverage(
    await analyzeSource(root, 'lambda/demo/index.js', source),
    source,
    snapshot.files['lambda/demo/index.js'],
    snapshot,
    git('rev-parse', 'HEAD'),
  );
  assert.equal(snapshot.status, 'complete');
  assert.equal(functions.length, 6);
  assert.equal(functions[0].coverage.percent, 50);
  assert.equal(functions[1].coverage.percent, 50);
  assert.equal(functions[2].coverage.percent, 0);
  assert.equal(functions[3].name, 'choose');
  assert.equal(functions[3].coverage.total, 2);
  assert.equal(functions[3].coverage.percent, 50);
  assert.equal(functions[4].coverage.total, 2);
  assert.equal(functions[4].coverage.percent, 50);
  // Real repository V8 output includes negative inferred else counts. Istanbul
  // treats these exactly like zero, rather than rejecting the entire report.
  const coveragePath = join(cwd, 'coverage/coverage-final.json');
  const raw = JSON.parse(await readFile(coveragePath, 'utf8'));
  for (const file of Object.values(raw)) {
    for (const counts of Object.values(file.b)) {
      for (let index = 0; index < counts.length; index++) {
        if (counts[index] === 0) counts[index] = -1;
      }
    }
  }
  await writeFile(coveragePath, JSON.stringify(raw));
  const inferred = await collectCoverage({ cwd, input: coveragePath, successful: true });
  assert.deepEqual(inferred.files, snapshot.files);
  await appendFile(
    join(cwd, 'sample.test.js'),
    `
test('failing assertion still executes a branch', () => { expect(outer(0)).toBe(999); });
`,
  );
  const failingRun = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--coverage',
      '--coverage.reportOnFailure',
    ],
    { cwd, encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(failingRun.status, 1, failingRun.stderr);
  const partial = await collectCoverage({
    cwd,
    input: join(cwd, 'coverage/coverage-final.json'),
    successful: false,
  });
  assert.equal(partial.status, 'partial');
  const partialFunctions = attachCoverage(
    await analyzeSource(root, 'lambda/demo/index.js', source),
    source,
    partial.files['lambda/demo/index.js'],
    partial,
    partial.revision,
  );
  assert.equal(partialFunctions[0].coverage.percent, 100);
  assert.equal(partialFunctions[0].coverage.partial, true);
  const failed = await collectCoverage({ cwd, input: 'not-needed', successful: false });
  assert.equal(failed.status, 'unavailable');
  assert.deepEqual(failed.files, {});
});
