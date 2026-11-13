import { describe, expect, it } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { extractDistributionArchive } from '../distribution-archive.js';
import { releaseKeyPrefix } from '../aidlc-release.js';
import { MAX_DISTRIBUTION_BYTES, MAX_DISTRIBUTION_FILES } from '../distribution-archive.js';
import {
  describeReleaseDistributions,
  planReleaseDistributions,
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

const usable = () => planReleaseDistributions(repoFiles()).usable;
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
      distributions: usable(),
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
    await publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      distributions: usable(),
    });
    const writes = s3.puts.length;
    const again = await publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      distributions: usable(),
    });
    expect(again.map((r) => r.status)).toEqual(['already-published', 'already-published']);
    expect(s3.puts.length).toBe(writes);
  });

  it('refuses different files for a release that already has them', async () => {
    const s3 = memoryS3();
    await publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      distributions: usable(),
    });
    const changed = usable();
    changed.get('kiro').set('AGENTS.md', Buffer.from('# Changed\n'));
    await expect(
      publishReleaseDistributions({ s3, bucket: 'b', keyArgs: KEY_ARGS, distributions: changed }),
    ).rejects.toThrow('already records different kiro files');
  });

  it('publishes nothing when the fork ships no distributions', async () => {
    const s3 = memoryS3();
    const result = await publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      distributions: planReleaseDistributions(new Map([['core/agents/x.md', Buffer.from('x')]]))
        .usable,
    });
    expect(result).toEqual([]);
    expect(s3.puts).toEqual([]);
  });

  it('plans an oversized or unsafe distribution as unavailable and keeps the rest', () => {
    const files = repoFiles();
    files.set('dist/codex/big.bin', Buffer.alloc(MAX_DISTRIBUTION_BYTES + 1));
    for (let index = 0; index <= MAX_DISTRIBUTION_FILES; index += 1) {
      files.set(`dist/opencode/f${index}.md`, Buffer.from('x'));
    }
    files.set('dist/kiro-ide/../escape.md', Buffer.from('x'));
    const plan = planReleaseDistributions(files);
    expect([...plan.usable.keys()].toSorted()).toEqual(['claude', 'kiro']);
    expect(plan.unavailable).toEqual([
      {
        harness: 'codex',
        status: 'unavailable',
        files: 1,
        reason: `distribution-archive: exceeds ${MAX_DISTRIBUTION_BYTES} bytes`,
      },
      {
        harness: 'kiro-ide',
        status: 'unavailable',
        files: 1,
        reason: 'distribution-archive: unsafe path ../escape.md',
      },
      {
        harness: 'opencode',
        status: 'unavailable',
        files: MAX_DISTRIBUTION_FILES + 1,
        reason: `distribution-archive: exceeds ${MAX_DISTRIBUTION_FILES} files`,
      },
    ]);
    expect(
      describeReleaseDistributions(plan).map(({ harness, status }) => [harness, status]),
    ).toEqual([
      ['claude', 'available'],
      ['codex', 'unavailable'],
      ['kiro', 'available'],
      ['kiro-ide', 'unavailable'],
      ['opencode', 'unavailable'],
    ]);
  });

  it('writes the same archive bytes for an overlapping import of the same release', async () => {
    // Two imports that both miss the marker each build and write the archive;
    // the second one's bytes must be the ones the first one's manifest records.
    const s3 = memoryS3();
    const realSend = s3.send.bind(s3);
    const marker = releaseDistributionKeys(KEY_ARGS, 'kiro').manifest;
    let hold;
    const held = new Promise((resolve) => {
      hold = resolve;
    });
    let firstRead = true;
    s3.send = async (command) => {
      if (command instanceof GetObjectCommand && command.input.Key === marker && firstRead) {
        firstRead = false;
        // Read the (still absent) marker, then wait for the other import.
        const missing = await realSend(command).catch((error) => error);
        await held;
        throw missing;
      }
      return realSend(command);
    };
    const kiroOnly = () => new Map([['kiro', usable().get('kiro')]]);
    const reordered = () => new Map([['kiro', new Map([...usable().get('kiro')].toReversed())]]);
    const slow = publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      distributions: kiroOnly(),
    });
    await publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      distributions: reordered(),
    });
    hold();
    await expect(slow).resolves.toEqual([{ harness: 'kiro', status: 'published', files: 2 }]);
    const keys = releaseDistributionKeys(KEY_ARGS, 'kiro');
    const manifest = JSON.parse(s3.objects.get(keys.manifest).toString('utf8'));
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(s3.objects.get(keys.archive)).digest('hex')).toBe(
      manifest.archiveSha256,
    );
  });

  // An import that loses the race for the marker accepts the winner only when it
  // describes the same files.
  const racedImport = async (winnerFiles) => {
    const s3 = memoryS3();
    const realSend = s3.send.bind(s3);
    const keys = releaseDistributionKeys(KEY_ARGS, 'kiro');
    s3.send = async (command) => {
      if (command instanceof PutObjectCommand && command.input.Key === keys.manifest) {
        s3.send = realSend;
        await publishReleaseDistributions({
          s3,
          bucket: 'b',
          keyArgs: KEY_ARGS,
          distributions: new Map([['kiro', winnerFiles]]),
        });
      }
      return realSend(command);
    };
    return publishReleaseDistributions({
      s3,
      bucket: 'b',
      keyArgs: KEY_ARGS,
      distributions: new Map([['kiro', usable().get('kiro')]]),
    });
  };

  it('accepts a concurrent import that published the same files', async () => {
    await expect(racedImport(usable().get('kiro'))).resolves.toEqual([
      { harness: 'kiro', status: 'published', files: 2 },
    ]);
  });

  it('refuses a concurrent import that published different files', async () => {
    const other = new Map([['AGENTS.md', Buffer.from('# Other\n')]]);
    await expect(racedImport(other)).rejects.toThrow(
      'was written concurrently with different kiro files',
    );
  });

  it('surfaces a storage error other than a lost race', async () => {
    const s3 = memoryS3();
    const realSend = s3.send.bind(s3);
    s3.send = async (command) => {
      if (command instanceof PutObjectCommand && command.input.Key.endsWith('.manifest.json')) {
        throw Object.assign(new Error('SlowDown'), { $metadata: { httpStatusCode: 503 } });
      }
      return realSend(command);
    };
    await expect(
      publishReleaseDistributions({ s3, bucket: 'b', keyArgs: KEY_ARGS, distributions: usable() }),
    ).rejects.toThrow('SlowDown');
  });

  it('surfaces a manifest read error rather than republishing', async () => {
    const s3 = memoryS3();
    s3.send = async () => {
      throw Object.assign(new Error('InternalError'), { $metadata: { httpStatusCode: 500 } });
    };
    await expect(
      publishReleaseDistributions({ s3, bucket: 'b', keyArgs: KEY_ARGS, distributions: usable() }),
    ).rejects.toThrow('InternalError');
  });

  it('groups string bodies as buffers', () => {
    const split = splitReleaseDistributions(new Map([['dist/kiro/AGENTS.md', '# Agents\n']]));
    expect(split.get('kiro').get('AGENTS.md')).toEqual(Buffer.from('# Agents\n'));
  });
});
