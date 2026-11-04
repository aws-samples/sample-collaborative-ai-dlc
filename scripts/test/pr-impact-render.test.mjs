import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeFlags,
  ISOBAR_REVISION,
  render,
  runGit,
  summaryOf,
  treeRun,
} from '../pr-impact/render.mjs';

const change = (path, added = 1, deleted = 0) => ({ path, added, deleted });

test('summary counts changed files and lines without judging coverage', () => {
  const summary = summaryOf([
    change('lambda/shared/authz.js', 8, 2),
    change('lambda/intents/index.js', 4, 3),
    change('frontend/src/services/intents.test.ts', 11),
    change('terraform/main.tf', 2, 1),
    change('package-lock.json', 100, 50),
  ]);
  assert.equal(summary.files, 5);
  assert.equal(summary.added, 125);
  assert.equal(summary.deleted, 56);
  assert.equal(summary.testFiles, 1);
  assert.equal('reviewCues' in summary, false);
});

test('test-only and documentation-only changes stay factual', () => {
  const tests = summaryOf([change('lambda/agentcore/test/fixtures/child.mjs')]);
  assert.equal(tests.testFiles, 1);
  const docs = summaryOf([change('docs/development/testing.md')]);
  assert.equal(docs.testFiles, 0);
});

test('name-status preserves additions, deletions, spaces, and newline-bearing paths', () => {
  const flags = changeFlags('A\0new file.js\0D\0old\nfile.js\0M\0existing.js\0');
  assert.deepEqual(flags.get('new file.js'), { isNew: true, isDeleted: false });
  assert.deepEqual(flags.get('old\nfile.js'), { isNew: false, isDeleted: true });
  assert.deepEqual(flags.get('existing.js'), { isNew: false, isDeleted: false });
});

test('renderer rejects revision injection before touching a repository or loading tooling', async () => {
  await assert.rejects(
    render({ baseSha: '--output=/tmp/x', headSha: 'a'.repeat(40) }),
    /full base and head/,
  );
  await assert.rejects(runGit(['bash', '-c', 'exit 0']), /only permits Git reads/);
  assert.match(ISOBAR_REVISION, /^[a-f0-9]{40}$/);
});

test('immutable tree adapter inserts and removes grep revision prefixes for facts only', async () => {
  const sha = 'a'.repeat(40);
  const commands = [];
  const run = treeRun(sha, async (argv) => {
    commands.push(argv);
    return { exitCode: 0, stdout: `${sha}:file.js\u00003\n` };
  });
  assert.deepEqual(await run(['git', '-C', '/repo', 'grep', '-z', '-c', '-e', '', '--', '*.js']), {
    exitCode: 0,
    stdout: 'file.js\u00003\n',
  });
  assert.deepEqual(commands[0].slice(3), ['grep', '-z', '-c', '-e', '', sha, '--', '*.js']);
  await run(['git', '-C', '/repo', 'grep', '-e', sha, '--', '*.js']);
  assert.deepEqual(commands[1].slice(3), ['grep', '-e', sha, sha, '--', '*.js']);
  await run(['git', '-C', '/repo', 'grep', '-e', '', sha, '--', '*.js']);
  assert.deepEqual(commands[2].slice(3), ['grep', '-e', '', sha, '--', '*.js']);
});

test('bare tree adapter retains empty tracked files without relying on an index', async () => {
  const sha = 'a'.repeat(40);
  const blob = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
  const run = treeRun(sha, async (argv) => {
    assert.deepEqual(argv, ['git', '-C', '/repo', 'ls-tree', '-r', '-z', sha]);
    return {
      exitCode: 0,
      stdout: [`100644 blob ${blob}\tempty.js`, `100644 blob ${blob}\tother.js`, ''].join('\0'),
    };
  });
  const result = await run(['git', '-C', '/repo', 'ls-files', '-z', '-s']);
  assert.equal(
    result.stdout,
    [`100644 ${blob} 0\tempty.js`, `100644 ${blob} 0\tother.js`, ''].join('\0'),
  );
});
