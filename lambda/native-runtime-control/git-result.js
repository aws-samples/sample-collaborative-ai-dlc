import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  nativeGitDeltaSha256,
  nativeGitResultBranch,
  nativeGitObjectFormat,
} from '../shared/native-git-change-set.js';
import { publicationGitDelta } from '../shared/native-git-change-set.js';
import { RESULT_MAX_BYTES, resultFailure } from './result-store.js';
import { gitIdentity } from '../shared/git-identity.js';

const invalid = () => {
  throw resultFailure('GIT_BASE_UNAVAILABLE');
};

export const nativeGitResultTarget = (row, located) => {
  const { manifest, baseline } = located;
  if (!baseline?.changes) throw resultFailure('GIT_DELTA_UNAVAILABLE');
  if (!baseline.manifest.git?.baseObjects) throw resultFailure('GIT_BASE_UNAVAILABLE');
  const delta = publicationGitDelta(manifest.sourceBaseline, baseline.manifest, baseline.changes);
  const branch = nativeGitResultBranch(row.scope.executionId, delta.repository.branch);
  return { repository: delta.repository, branch, deltaSha256: nativeGitDeltaSha256(delta) };
};

// Build in an empty private object database. The original commit authenticates the
// complete index, including excluded paths whose blob contents the worker never reads.
export const buildNativeGitResult = async ({
  execution,
  located,
  publications,
  directory,
  destination,
  signal,
}) => {
  const { manifest, baseline, found } = located;
  const { branch, repository, deltaSha256 } = nativeGitResultTarget(execution, located);
  const base = repository.commit;
  const oidLength = base.length;
  const algorithm = nativeGitObjectFormat(base);

  const original = await publications.gitBase(baseline.identity, baseline.manifest, signal);
  const cwd = join(directory, 'objects.git');
  await mkdir(cwd, { mode: 0o700 });
  const date = `@${Math.floor(Date.parse(manifest.createdAt) / 1000)} +0000`;
  const git = (args, input) => {
    signal.throwIfAborted();
    return execFileSync(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'protocol.allow=never',
        '-c',
        'pack.threads=1',
        ...args,
      ],
      {
        cwd,
        input,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    ).trimEnd();
  };
  git(['init', '--quiet', '--bare', `--object-format=${algorithm}`]);
  if (
    git(
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      Buffer.from(original.commit, 'base64'),
    ) !== base
  )
    invalid();
  await writeFile(join(cwd, 'shallow'), `${base}\n`, { flag: 'wx', mode: 0o600 });
  git(['update-index', '-z', '--index-info'], original.index);
  if (git(['write-tree', '--missing-ok']) !== git(['rev-parse', `${base}^{tree}`])) invalid();

  const removals = [];
  const updates = [];
  const originals = new Map(
    original.index
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const split = entry.indexOf('\t');
        return [entry.slice(split + 1), entry.slice(0, split)];
      }),
  );
  const readBefore = publications.fileReader(baseline.identity, baseline.manifest);
  const readAfter = publications.fileReader(found.identity, manifest);
  for (const { path, fileId, before, after } of baseline.changes) {
    if (before) {
      const { bytes } = await readBefore(fileId, { signal });
      const oid = createHash(algorithm)
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      if (originals.get(path) !== `${before.mode} blob ${oid}`) invalid();
    } else if (originals.has(path)) invalid();
    if (after) {
      const { bytes } = await readAfter(fileId, { signal });
      const oid = git(['hash-object', '-w', '--stdin'], bytes);
      updates.push(`${after.mode} ${oid}\t${path}\0`);
    } else removals.push(`0 ${'0'.repeat(oidLength)}\t${path}\0`);
  }
  git(['update-index', '-z', '--index-info'], [...removals, ...updates].join(''));
  const tree = git(['write-tree', '--missing-ok']);
  const commit = git([
    ...gitIdentity(),
    'commit-tree',
    tree,
    '-p',
    base,
    '-m',
    `Native result ${found.receipt.id}\n\nGit delta ${deltaSha256}`,
  ]);
  const changed = git([
    'diff-tree',
    '--no-renames',
    '--no-commit-id',
    '-r',
    '--name-only',
    '-z',
    base,
    commit,
  ])
    .split('\0')
    .filter(Boolean)
    .toSorted();
  if (JSON.stringify(changed) !== JSON.stringify(baseline.changes.map((change) => change.path)))
    invalid();
  const ref = `refs/heads/${branch}`;
  git(['update-ref', ref, commit]);
  git(['bundle', 'create', destination, ref, `^${base}`]);
  const { size: bytes } = await stat(destination);
  if (bytes > RESULT_MAX_BYTES) throw resultFailure('LIMIT');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(destination, { signal })) hash.update(chunk);
  return { bytes, sha256: hash.digest('hex'), git: { branch, base, deltaSha256, commit, tree } };
};
