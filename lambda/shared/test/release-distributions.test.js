import { describe, expect, it } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { extractDistributionArchive } from '../distribution-archive.js';
import { releaseKeyPrefix } from '../aidlc-release.js';
import {
  publishReleaseDistributions,
  releaseDistributionKeys,
  splitReleaseDistributions,
} from '../release-distributions.js';

const SHA = '3333333333333333333333333333333333333333';
const KEY_ARGS = {
  sha: SHA,
  importerRevision: 3,
  custom: true,
  sourceRepository: 'acme/aidlc-fork',
};

// A minimal in-memory S3 that honours IfNoneMatch.
const memoryS3 = () => {
  const objects = new Map();
  const puts = [];
  return {
    objects,
    puts,
    async send(command) {
      const { Key, Body, IfNoneMatch } = command.input;
      if (command instanceof PutObjectCommand) {
        if (IfNoneMatch === '*' && objects.has(Key)) {
          throw Object.assign(new Error('precondition'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          });
        }
        puts.push(Key);
        objects.set(Key, Buffer.isBuffer(Body) ? Body : Buffer.from(Body));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        if (!objects.has(Key)) {
          throw Object.assign(new Error('missing'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        }
        const body = objects.get(Key);
        return { Body: { transformToString: async () => body.toString('utf8') } };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
};

const repoFiles = () =>
  new Map([
    ['dist/kiro/.kiro/tools/data/harness.json', Buffer.from('{"name":"kiro"}')],
    ['dist/kiro/AGENTS.md', Buffer.from('# Agents\n')],
    ['dist/claude/.claude/tools/data/harness.json', Buffer.from('{"name":"claude"}')],
    ['dist/not-a-harness/readme.md', Buffer.from('ignored')],
    ['core/agents/x.md', Buffer.from('not a distribution')],
  ]);

describe('release distributions', () => {
  it('groups dist/<harness>/ files by known harness, relative to the harness root', () => {
    const split = splitReleaseDistributions(repoFiles());
    expect([...split.keys()].toSorted()).toEqual(['claude', 'kiro']);
    expect([...split.get('kiro').keys()].toSorted()).toEqual([
      '.kiro/tools/data/harness.json',
      'AGENTS.md',
    ]);
  });

  it("keys a release's distributions under its own release prefix", () => {
    const keys = releaseDistributionKeys(KEY_ARGS, 'kiro-ide');
    expect(keys.archive).toBe(`${releaseKeyPrefix(KEY_ARGS)}/dist/kiro-ide.tar.gz`);
    expect(keys.manifest).toBe(`${releaseKeyPrefix(KEY_ARGS)}/dist/kiro-ide.manifest.json`);
    expect(keys.archive).toContain('/custom/acme/aidlc-fork/');
    expect(() => releaseDistributionKeys(KEY_ARGS, 'vim')).toThrow('unsupported harness vim');
  });

  it('publishes an archive and a checksummed manifest per harness, manifest last', async () => {
    const s3 = memoryS3();
    const result = await publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      files: repoFiles(),
    });
    expect(result).toEqual([
      { harness: 'claude', status: 'published', files: 1 },
      { harness: 'kiro', status: 'published', files: 2 },
    ]);
    const keys = releaseDistributionKeys(KEY_ARGS, 'kiro');
    expect(s3.puts.indexOf(keys.archive)).toBeLessThan(s3.puts.indexOf(keys.manifest));
    const manifest = JSON.parse(s3.objects.get(keys.manifest).toString('utf8'));
    expect(manifest).toMatchObject({ schemaVersion: 1, ref: SHA, harness: 'kiro' });
    const files = await extractDistributionArchive(s3.objects.get(keys.archive));
    expect(files.get('AGENTS.md').toString()).toBe('# Agents\n');
    expect(manifest.files.map((f) => f.path)).toEqual([
      '.kiro/tools/data/harness.json',
      'AGENTS.md',
    ]);
  });

  it('is idempotent for the same files', async () => {
    const s3 = memoryS3();
    await publishReleaseDistributions({ s3, bucket: 'b', keyArgs: KEY_ARGS, files: repoFiles() });
    const writes = s3.puts.length;
    const again = await publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      files: repoFiles(),
    });
    expect(again.map((r) => r.status)).toEqual(['already-published', 'already-published']);
    expect(s3.puts.length).toBe(writes);
  });

  it('refuses different files for a release that already has them', async () => {
    const s3 = memoryS3();
    await publishReleaseDistributions({ s3, bucket: 'b', keyArgs: KEY_ARGS, files: repoFiles() });
    const changed = repoFiles();
    changed.set('dist/kiro/AGENTS.md', Buffer.from('# Changed\n'));
    await expect(
      publishReleaseDistributions({ s3, bucket: 'b', keyArgs: KEY_ARGS, files: changed }),
    ).rejects.toThrow('already records different kiro files');
  });

  it('publishes nothing when the fork ships no distributions', async () => {
    const s3 = memoryS3();
    const result = await publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      files: new Map([['core/agents/x.md', Buffer.from('x')]]),
    });
    expect(result).toEqual([]);
    expect(s3.puts).toEqual([]);
  });
});
