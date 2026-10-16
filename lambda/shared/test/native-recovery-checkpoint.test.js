import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { NoSuchKey, S3ServiceException } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeRecoveryCheckpoints,
  nativeRecoveryPath,
  nativeRecoveryReceipt,
  nativeRecoveryScope,
  NATIVE_RECOVERY_LIMITS,
} from '../native-recovery-checkpoint.js';
import { canonicalJson } from '../workflow-checkpoint.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = {
  projectId: 'project-1',
  executionId: '11111111-1111-4111-8111-111111111111',
  bindingId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  epoch: 1,
  runtimeSessionId: '44444444-4444-4444-8444-444444444444',
};
const otherId = '55555555-5555-4555-8555-555555555555';
const nativeSessionId = '66666666-6666-4666-8666-666666666666';
const filesystem = (harness = 'codex') => ({
  schemaVersion: 1,
  harness,
  harnessVersion: {
    codex: '0.145.0',
    claude: '2.1.257',
    opencode: '1.17.20',
    kiro: '2.19.2',
  }[harness],
  nativeSessionId,
  format: {
    codex: 'codex-rollout-jsonl-v1',
    claude: 'claude-project-jsonl-v1',
    opencode: 'opencode-export-json-v1',
    kiro: 'kiro-v2-session-pair-v1',
  }[harness],
  project: '/mnt/native/project',
  home: `/home/node/.native-homes/${identity.bindingId}/${identity.attemptId}`,
  directories: [
    { scope: 'project', path: '', mode: 0o700, mtimeNs: '1790743033245123456' },
    { scope: 'home', path: '', mode: 0o700, mtimeNs: '1790743033245123457' },
    { scope: 'project', path: 'empty-directory', mode: 0o750, mtimeNs: '1790743033245123458' },
  ],
  hardlinks: [],
  ...(harness === 'claude' ? { claudeProjectKey: '-mnt-native-project' } : {}),
});
const metadata = {
  sequence: 2,
  writerGeneration: 1,
  nativeSessionId,
  harness: 'codex',
  configurationSha256: 'a'.repeat(64),
  packageId: `sha256:${'b'.repeat(64)}`,
  imageDigest: `sha256:${'c'.repeat(64)}`,
  publicationId: 'd'.repeat(64),
  interactionId: 'e'.repeat(64),
  continuation: { promptEvidence: null, priorAssistantSha256: 'f'.repeat(64) },
  filesystem: filesystem(),
};
const file = (scope, path, content, extra = {}) => {
  const bytes = Buffer.from(content);
  return {
    scope,
    path,
    bytes: bytes.length,
    sha256: sha(bytes),
    mode: 0o600,
    mtimeNs: '1790743033245123456',
    content: bytes,
    ...extra,
  };
};
const input = () => ({
  identity: { ...identity },
  ...structuredClone(metadata),
  files: [
    file('project', 'src/bird.js', '#!/usr/bin/env node\n', { mode: 0o755 }),
    file(
      'home',
      `.codex/sessions/2026/09/30/rollout-${nativeSessionId}.jsonl`,
      `${JSON.stringify({ type: 'session_meta', payload: { id: nativeSessionId } })}\n`,
    ),
    file('project', 'aidlc/.aidlc-sessions/.current-session', nativeSessionId),
    file('project', 'images/bird.bin', Buffer.from([0, 255, 128, 13, 10])),
    file('project', 'empty', '', { mtimeNs: '-1', mode: 0 }),
  ],
});
const binInput = () => {
  const data = input();
  data.harness = 'opencode';
  data.filesystem = filesystem('opencode');
  data.filesystem.schemaVersion = 2;
  data.filesystem.harnessVersion = '1.19.0';
  data.filesystem.binLinks = [
    {
      scope: 'project',
      path: '.opencode/node_modules/.bin/tool',
      target: '../pkg/bin.js',
      mode: 0o777,
      mtimeNs: '1790743033245123456',
    },
  ];
  data.filesystem.directories.push(
    ...[
      '.opencode',
      '.opencode/node_modules',
      '.opencode/node_modules/.bin',
      '.opencode/node_modules/pkg',
    ].map((path) => ({ scope: 'project', path, mode: 0o755, mtimeNs: '1790743033245123456' })),
  );
  data.files.push(
    file('project', '.opencode/node_modules/pkg/bin.js', 'pinned executable', { mode: 0o755 }),
  );
  return data;
};
const INVALID = { code: 'NATIVE_RECOVERY_INVALID' };
const UNAVAILABLE = { code: 'NATIVE_RECOVERY_UNAVAILABLE' };
const MISSING = { code: 'NATIVE_RECOVERY_MISSING' };

const setup = () => {
  const versions = new Map();
  const latest = new Map();
  const calls = [];
  let serial = 0;
  const memory = {
    versions,
    latest,
    calls,
    before: null,
    afterPut: null,
    onGet: null,
    seed(key, bytes, version = `v${++serial}`) {
      versions.set(`${key}:${version}`, Buffer.from(bytes));
      latest.set(key, version);
      return version;
    },
    bytes(receipt) {
      return versions.get(`${receipt.manifest.key}:${receipt.manifest.versionId}`);
    },
  };
  const s3 = {
    send: vi.fn(async (command) => {
      calls.push(command);
      if (memory.before) await memory.before(command);
      const p = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        if (p.IfNoneMatch === '*' && latest.has(p.Key))
          throw Object.assign(new Error('existing object'), { name: 'PreconditionFailed' });
        const VersionId = memory.seed(p.Key, p.Body);
        const result = { VersionId };
        if (memory.afterPut) return memory.afterPut(command, result);
        return result;
      }
      if (command.constructor.name !== 'GetObjectCommand')
        throw new Error('Unexpected cloud operation');
      const version = p.VersionId ?? latest.get(p.Key);
      const bytes = versions.get(`${p.Key}:${version}`);
      if (!bytes) throw Object.assign(new Error('missing version'), { name: 'NoSuchKey' });
      const result = {
        VersionId: version,
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      };
      return memory.onGet ? memory.onGet(command, result) : result;
    }),
  };
  const store = createNativeRecoveryCheckpoints({
    s3,
    bucket: 'private-native-recovery',
    accountId: '123456789012',
  });
  const forge = (receipt, mutate, encode = canonicalJson) => {
    const value = JSON.parse(memory.bytes(receipt));
    mutate(value);
    const body = Buffer.from(encode(value));
    const id = sha(body);
    const key = `${nativeRecoveryScope(identity).prefix}manifests/${id}.json`;
    const versionId = memory.seed(key, body);
    return {
      id,
      sequence: value.sequence,
      manifest: { key, versionId, sha256: id, bytes: body.length },
    };
  };
  return { ...memory, memory, store, s3, forge };
};
const manifestGets = (calls) =>
  calls.filter(
    (call) =>
      call.constructor.name === 'GetObjectCommand' && call.input.Key.includes('/manifests/'),
  );
const fileGets = (calls) =>
  calls.filter(
    (call) => call.constructor.name === 'GetObjectCommand' && call.input.Key.includes('/files/'),
  );

describe('private native recovery checkpoint', () => {
  it('uploads four files concurrently, preserves inventory order and commits the manifest last', async () => {
    const { store, memory, calls } = setup();
    const releases = [];
    memory.before = async (command) => {
      if (command.constructor.name === 'PutObjectCommand' && command.input.Key.includes('/files/'))
        await new Promise((resolve) => releases.push(resolve));
    };
    const pending = store.publish(input());
    // Flush scheduled promises; no timing or fast-host requirement.
    await Promise.resolve();
    expect(releases).toHaveLength(4);
    expect(calls.some((call) => call.input.Key.includes('/manifests/'))).toBe(false);
    // Complete out of order. Receipts must stay bound to their own file.
    releases
      .splice(0)
      .toReversed()
      .forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(calls.some((call) => call.input.Key.includes('/manifests/'))).toBe(false);
    releases.shift()();
    const receipt = await pending;
    const restored = await store.readFiles(identity, receipt);
    expect(restored.files.map((entry) => `${entry.scope}/${entry.path}`)).toEqual(
      input()
        .files.map((entry) => `${entry.scope}/${entry.path}`)
        .toSorted(),
    );
    for (const entry of restored.files) expect(sha(entry.content)).toBe(entry.sha256);
    expect(
      calls.filter((call) => call.constructor.name === 'PutObjectCommand').at(-1).input.Key,
    ).toBe(receipt.manifest.key);
  });

  it('drains started uploads on failure, starts no more files and never publishes a partial manifest', async () => {
    const { store, memory, calls } = setup();
    const releases = [];
    memory.before = async (command) => {
      if (command.constructor.name === 'PutObjectCommand' && command.input.Key.includes('/files/'))
        await new Promise((resolve, reject) => releases.push({ resolve, reject }));
    };
    let settled = false;
    const pending = store.publish(input()).finally(() => {
      settled = true;
    });
    const rejection = expect(pending).rejects.toMatchObject(UNAVAILABLE);
    await Promise.resolve();
    expect(releases).toHaveLength(4);
    releases[0].reject(new Error('offline upload failure'));
    await vi.waitFor(() => expect(fileGets(calls)).toHaveLength(1));
    expect(settled).toBe(false);
    releases.slice(1).forEach(({ resolve }) => resolve());
    await rejection;
    expect(releases).toHaveLength(4);
    expect(calls.some((call) => call.input.Key.includes('/manifests/'))).toBe(false);
  });

  it('preserves full identity, pins, private session files, binary bytes, modes and exact mtimes', async () => {
    const { store, calls } = setup();
    const source = input();
    const receipt = await store.publish(source);
    expect(Object.keys(receipt).toSorted()).toEqual(['id', 'manifest', 'sequence']);
    const manifest = await store.read(identity, receipt, { verifyFiles: true });
    expect(manifest).toMatchObject({ schemaVersion: 1, scope: identity, ...metadata });
    expect(fileGets(calls)).toHaveLength(source.files.length);
    for (const entry of manifest.files) {
      const original = source.files.find(
        (value) => value.scope === entry.scope && value.path === entry.path,
      );
      expect(entry).toMatchObject({
        bytes: original.bytes,
        sha256: original.sha256,
        mode: original.mode,
        mtimeNs: original.mtimeNs,
      });
      expect(await store.file(identity, receipt, entry)).toEqual(original.content);
    }
    const prefix = nativeRecoveryScope(identity).prefix;
    expect(prefix).toMatch(/^native-recovery\/v1\/[a-f0-9]{64}\/[^/]+\/1\/$/);
    expect(calls.every((call) => call.input.Key.startsWith(prefix))).toBe(true);
    expect(calls.every((call) => call.input.ExpectedBucketOwner === '123456789012')).toBe(true);
    for (const command of calls.filter((call) => call.constructor.name === 'PutObjectCommand')) {
      expect(command.input.IfNoneMatch).toBe('*');
      expect(command.input.ChecksumSHA256).toBe(
        createHash('sha256').update(command.input.Body).digest('base64'),
      );
    }
    expect(
      calls.filter((call) => call.constructor.name === 'PutObjectCommand').at(-1).input.Key,
    ).toBe(receipt.manifest.key);
  });

  it('returns the same immutable receipt on replay, regardless of inventory order', async () => {
    const { store, versions } = setup();
    const first = await store.publish(input());
    const count = versions.size;
    const replay = input();
    replay.files.reverse();
    expect(await store.publish(replay)).toEqual(first);
    expect(versions.size).toBe(count);
  });

  it('bulk restores exact bytes from one manifest and one versioned download per file', async () => {
    const { store, calls } = setup();
    const original = input();
    const receipt = await store.publish(original);
    calls.length = 0;
    const { manifest, files } = await store.readFiles(identity, receipt);
    expect(manifest).toMatchObject({ scope: identity, ...metadata });
    expect(manifestGets(calls)).toHaveLength(1);
    expect(fileGets(calls)).toHaveLength(original.files.length);
    expect(calls.every((call) => typeof call.input.VersionId === 'string')).toBe(true);
    for (const [index, entry] of files.entries()) {
      const { content, ...descriptor } = entry;
      expect(descriptor).toEqual(manifest.files[index]);
      expect(content).toEqual(
        original.files.find((f) => f.scope === entry.scope && f.path === entry.path).content,
      );
    }
    expect(manifest.files.every((entry) => !Object.hasOwn(entry, 'content'))).toBe(true);
    files[0].object.versionId = 'caller-mutated';
    expect(manifest.files[0].object.versionId).not.toBe('caller-mutated');
  });

  it('pins the producer generation without changing original publication scope or older checkpoints', async () => {
    const { store } = setup();
    const old = await store.publish(input());
    const newer = await store.publish({ ...input(), writerGeneration: 2 });
    expect(newer.id).not.toBe(old.id);
    const restoredOld = await store.readFiles(identity, old);
    expect(restoredOld.manifest.writerGeneration).toBe(1);
    expect(restoredOld.manifest.scope).toEqual(identity);
    expect((await store.read(identity, newer)).writerGeneration).toBe(2);
  });

  it.each([undefined, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', [1], null])(
    'requires a positive safe integer producer generation %j',
    async (writerGeneration) => {
      const { store, calls } = setup();
      const data = { ...input(), writerGeneration };
      if (writerGeneration === undefined) delete data.writerGeneration;
      await expect(store.publish(data)).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    },
  );

  it('validates bulk restore identity before any file downloads', async () => {
    const { store, calls } = setup();
    const receipt = await store.publish(input());
    calls.length = 0;
    await expect(
      store.readFiles({ ...identity, bindingId: otherId }, receipt),
    ).rejects.toMatchObject(INVALID);
    expect(fileGets(calls)).toHaveLength(0);
  });

  it('snapshots bulk restore identity and receipt before storage callbacks can mutate them', async () => {
    const { store, memory } = setup();
    const original = await store.publish(input());
    const requestedIdentity = { ...identity };
    const receipt = structuredClone(original);
    memory.before = () => {
      requestedIdentity.runtimeSessionId = otherId;
      receipt.manifest.versionId = 'changed-by-caller';
      receipt.sequence++;
    };
    const loaded = await store.readFiles(requestedIdentity, receipt);
    expect(loaded.manifest.scope).toEqual(identity);
    expect(loaded.manifest.sequence).toBe(original.sequence);
    expect(loaded.files).toHaveLength(input().files.length);
  });

  it('rejects bulk restore when the complete inventory exceeds the 256 MiB body limit', async () => {
    const { store, calls, forge } = setup();
    const receipt = await store.publish(input());
    const forged = forge(receipt, (m) => {
      for (const entry of m.files) entry.bytes = NATIVE_RECOVERY_LIMITS.fileBytes;
    });
    calls.length = 0;
    await expect(store.readFiles(identity, forged)).rejects.toMatchObject(INVALID);
    expect(fileGets(calls)).toHaveLength(0);
  });

  it('preserves empty directories, exact directory timestamps and internal hardlinks', async () => {
    const { store } = setup();
    const data = input();
    data.files.push(file('project', 'links/a', 'shared'), file('project', 'links/b', 'shared'));
    data.filesystem.directories.push({
      scope: 'project',
      path: 'links',
      mode: 0o750,
      mtimeNs: '1790743033245123459',
    });
    data.filesystem.hardlinks.push({ scope: 'project', paths: ['links/b', 'links/a'] });
    const receipt = await store.publish(data);
    const loaded = await store.readFiles(identity, receipt);
    expect(loaded.manifest.filesystem).toEqual(data.filesystem);
    expect(loaded.manifest.filesystem.directories).toContainEqual({
      scope: 'project',
      path: 'empty-directory',
      mode: 0o750,
      mtimeNs: '1790743033245123458',
    });
    expect(
      loaded.files.filter((entry) => entry.path.startsWith('links/')).map((entry) => entry.content),
    ).toEqual([Buffer.from('shared'), Buffer.from('shared')]);
  });

  it('binds version-2 OpenCode bin links and independent target bytes in one immutable manifest', async () => {
    const { store, forge, calls } = setup();
    const data = binInput();
    const receipt = await store.publish(data);
    const loaded = await store.readFiles(identity, receipt);
    expect(loaded.manifest.schemaVersion).toBe(1);
    expect(loaded.manifest.filesystem).toEqual(data.filesystem);
    expect(loaded.files.find((entry) => entry.path.endsWith('/pkg/bin.js')).content).toEqual(
      Buffer.from('pinned executable'),
    );
    const retargeted = binInput();
    retargeted.filesystem.binLinks[0].target = '../pkg/./bin.js';
    expect((await store.publish(retargeted)).id).not.toBe(receipt.id);
    const corrupt = forge(receipt, (manifest) => {
      manifest.files.find((entry) => entry.path.endsWith('/pkg/bin.js')).sha256 = '0'.repeat(64);
    });
    calls.length = 0;
    await expect(store.readFiles(identity, corrupt)).rejects.toMatchObject(INVALID);
    expect(fileGets(calls)).toHaveLength(0);
  });

  it.each([
    [
      'absolute',
      (d) => {
        d.filesystem.binLinks[0].target = '/tmp/outside';
      },
    ],
    [
      'escape',
      (d) => {
        d.filesystem.binLinks[0].target = '../../../outside';
      },
    ],
    [
      'dangling',
      (d) => {
        d.files = d.files.filter((f) => !f.path.endsWith('/pkg/bin.js'));
      },
    ],
    [
      'directory',
      (d) => {
        d.filesystem.binLinks[0].target = '../pkg';
      },
    ],
    [
      'missing-intermediate-directory',
      (d) => {
        d.filesystem.binLinks[0].target = '../pkg/missing/../bin.js';
      },
    ],
    [
      'file-intermediate-directory',
      (d) => {
        d.filesystem.binLinks[0].target = '../pkg/bin.js/../bin.js';
      },
    ],
    [
      'chain',
      (d) => {
        d.filesystem.binLinks.push({
          ...d.filesystem.binLinks[0],
          path: '.opencode/node_modules/.bin/other',
        });
        d.filesystem.binLinks[0].target = './other';
      },
    ],
    [
      'missing-parent',
      (d) => {
        d.filesystem.directories = d.filesystem.directories.filter(
          (entry) => !entry.path.endsWith('/pkg'),
        );
      },
    ],
    [
      'alias-parent',
      (d) => {
        d.filesystem.directories.push({
          ...d.filesystem.directories[0],
          path: '.opencode/node_modules/.bin/tool/subdirectory',
        });
      },
    ],
    [
      'duplicate',
      (d) => {
        d.filesystem.binLinks.push({ ...d.filesystem.binLinks[0] });
      },
    ],
    [
      'file-collision',
      (d) => {
        d.files.push(file('project', '.opencode/node_modules/.bin/tool', 'alias'));
      },
    ],
    [
      'outside-bin',
      (d) => {
        d.filesystem.binLinks[0].path = '.opencode/node_modules/tool';
      },
    ],
    [
      'nested-bin',
      (d) => {
        d.filesystem.binLinks[0].path = '.opencode/node_modules/.bin/sub/tool';
      },
    ],
    [
      'scope',
      (d) => {
        d.filesystem.binLinks[0].scope = 'home';
      },
    ],
    [
      'other-harness',
      (d) => {
        d.harness = 'codex';
        d.filesystem.harness = 'codex';
        d.filesystem.format = 'codex-rollout-jsonl-v1';
      },
    ],
    [
      'old-version',
      (d) => {
        d.filesystem.schemaVersion = 1;
      },
    ],
    [
      'unknown-version',
      (d) => {
        d.filesystem.schemaVersion = 3;
      },
    ],
    [
      'empty',
      (d) => {
        d.filesystem.binLinks = [];
      },
    ],
    [
      'mode',
      (d) => {
        d.filesystem.binLinks[0].mode = 0o755;
      },
    ],
    [
      'extra-field',
      (d) => {
        d.filesystem.binLinks[0].follow = true;
      },
    ],
    [
      'target-byte-bound',
      (d) => {
        d.filesystem.binLinks[0].target = `../${'a'.repeat(2048)}`;
      },
    ],
    [
      'credential',
      (d) => {
        d.filesystem.binLinks[0].target = '../pkg/.npmrc';
        d.files.push(file('project', '.opencode/node_modules/pkg/.npmrc', 'private'));
      },
    ],
    [
      'private-control',
      (d) => {
        d.filesystem.binLinks[0].target = '../pkg/.native-control/token';
        d.files.push(
          file('project', '.opencode/node_modules/pkg/.native-control/token', 'private'),
        );
      },
    ],
  ])('rejects invalid OpenCode bin metadata on publish and read: %s', async (_name, mutate) => {
    const { store, calls, forge } = setup();
    const valid = binInput();
    const receipt = await store.publish(valid);
    const invalid = binInput();
    mutate(invalid);
    calls.length = 0;
    await expect(store.publish(invalid)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
    const forged = forge(receipt, mutate);
    await expect(store.readFiles(identity, forged)).rejects.toMatchObject(INVALID);
    expect(fileGets(calls)).toHaveLength(0);
  });

  it('rejects modified bin target content without a matching immutable hash before upload', async () => {
    const { store, calls } = setup();
    const data = binInput();
    data.files.find((entry) => entry.path.endsWith('/pkg/bin.js')).content[0] ^= 1;
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it.each(['missing', 'corrupt'])(
    'rejects %s immutable bin target objects during admission and restore reads',
    async (kind) => {
      const { store, memory } = setup();
      const receipt = await store.publish(binInput());
      const manifest = JSON.parse(memory.bytes(receipt));
      const target = manifest.files.find((entry) => entry.path.endsWith('/pkg/bin.js'));
      const key = `${target.object.key}:${target.object.versionId}`;
      if (kind === 'missing') memory.versions.delete(key);
      else memory.versions.get(key)[0] ^= 1;
      await expect(store.read(identity, receipt, { verifyFiles: true })).rejects.toMatchObject(
        kind === 'missing' ? MISSING : INVALID,
      );
      await expect(store.readFiles(identity, receipt)).rejects.toMatchObject(
        kind === 'missing' ? MISSING : INVALID,
      );
    },
  );

  it('preserves Claude adapter metadata while binding its format/session to the outer pins', async () => {
    const { store } = setup();
    const data = input();
    data.harness = 'claude';
    data.filesystem = filesystem('claude');
    expect(
      (await store.readFiles(identity, await store.publish(data))).manifest.filesystem,
    ).toEqual(data.filesystem);
  });

  it.each([
    (d) => {
      delete d.filesystem;
    },
    (d) => {
      d.filesystem.writerAuthorized = true;
    },
    (d) => {
      d.filesystem.credentials = 'secret';
    },
    (d) => {
      d.filesystem.schemaVersion = 2;
    },
    (d) => {
      d.filesystem.harness = 'kiro';
    },
    (d) => {
      d.filesystem.harnessVersion = ['0.145.0'];
    },
    (d) => {
      d.filesystem.harnessVersion = '0.145.0;run-command';
    },
    (d) => {
      d.filesystem.nativeSessionId = otherId;
    },
    (d) => {
      d.filesystem.format = 'kiro-v2-session-pair-v1';
    },
    (d) => {
      d.filesystem.project = '/';
    },
    (d) => {
      d.filesystem.project = 'relative/path';
    },
    (d) => {
      d.filesystem.project = '/tmp/../escape';
    },
    (d) => {
      d.filesystem.project = '/tmp//alias';
    },
    (d) => {
      d.filesystem.home = d.filesystem.project;
    },
    (d) => {
      d.filesystem.home = `${d.filesystem.project}/home`;
    },
    (d) => {
      d.filesystem.claudeProjectKey = 'other-harness-key';
    },
    (d) => {
      d.filesystem.directories[0].path = '../outside';
    },
    (d) => {
      d.filesystem.directories[0].scope = 'external';
    },
    (d) => {
      d.filesystem.directories[0].mode = 0o40700;
    },
    (d) => {
      d.filesystem.directories[0].mtimeNs = [d.filesystem.directories[0].mtimeNs];
    },
    (d) => {
      d.filesystem.directories[0].uid = 0;
    },
    (d) => {
      d.filesystem.directories[2].path = 'src/bird.js';
    },
    (d) => {
      d.filesystem.directories[2].path = 'src/bird.js/subdir';
    },
    (d) => {
      d.filesystem.directories.push({ ...d.filesystem.directories[0] });
    },
  ])(
    'rejects malformed or authority-bearing filesystem metadata before uploads',
    async (mutate) => {
      const { store, calls } = setup();
      const data = input();
      mutate(data);
      await expect(store.publish(data)).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    (d) => {
      d.filesystem.hardlinks[0].scope = 'home';
    },
    (d) => {
      d.filesystem.hardlinks[0].paths = ['links/a'];
    },
    (d) => {
      d.filesystem.hardlinks[0].paths = ['links/a', 'links/a'];
    },
    (d) => {
      d.filesystem.hardlinks[0].paths = ['links/a', '../outside'];
    },
    (d) => {
      d.filesystem.hardlinks[0].paths = ['links/a', 'empty-directory'];
    },
    (d) => {
      d.filesystem.hardlinks[0].paths = ['links/a', 'missing'];
    },
    (d) => {
      d.filesystem.hardlinks[0].target = '/outside';
    },
    (d) => {
      d.filesystem.hardlinks.push({ ...d.filesystem.hardlinks[0] });
    },
    (d) => {
      d.files.at(-1).mode = 0o644;
    },
    (d) => {
      d.files.at(-1).mtimeNs = '1';
    },
    (d) => {
      d.files[d.files.length - 1] = file('project', 'links/b', 'other');
    },
  ])('rejects unsafe or inconsistent hardlink groups before uploads', async (mutate) => {
    const { store, calls } = setup();
    const data = input();
    data.files.push(file('project', 'links/a', 'shared'), file('project', 'links/b', 'shared'));
    data.filesystem.hardlinks = [{ scope: 'project', paths: ['links/a', 'links/b'] }];
    mutate(data);
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it('bounds the combined file/directory inventory before upload and before bulk download', async () => {
    const { store, calls, forge } = setup();
    const data = input();
    const receipt = await store.publish(data);
    const tooMany = Array(NATIVE_RECOVERY_LIMITS.entries).fill(data.filesystem.directories[0]);
    data.filesystem.directories = tooMany;
    calls.length = 0;
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
    const forged = forge(receipt, (m) => {
      m.filesystem.directories = tooMany;
    });
    await expect(store.readFiles(identity, forged)).rejects.toMatchObject(INVALID);
    expect(fileGets(calls)).toHaveLength(0);
  });

  it.each([
    (m) => {
      delete m.writerGeneration;
    },
    (m) => {
      m.writerGeneration = '1';
    },
    (m) => {
      m.filesystem.directories[2].path = '../outside';
    },
    (m) => {
      m.filesystem.project = m.filesystem.home;
    },
    (m) => {
      m.filesystem.nativeSessionId = otherId;
    },
    (m) => {
      m.filesystem.hardlinks = [{ scope: 'project', paths: ['empty', '../outside'] }];
    },
    (m) => {
      m.filesystem.restoreAuthorized = true;
    },
  ])(
    'rejects rehashed generation/filesystem forgeries before downloading file bodies',
    async (mutate) => {
      const { store, forge, calls } = setup();
      const receipt = await store.publish(input());
      const changed = forge(receipt, mutate);
      calls.length = 0;
      await expect(store.readFiles(identity, changed)).rejects.toMatchObject(INVALID);
      expect(fileGets(calls)).toHaveLength(0);
    },
  );

  it('round-trips the real runtime capture/restore schema through immutable storage', async () => {
    const fs = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { captureNativeSessionRecovery, restoreNativeSessionRecovery } =
      await import('../../agentcore/native/session-recovery-files.js');
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'native-recovery-store-roundtrip-')),
    );
    const project = join(root, 'project');
    const home = join(root, 'home');
    try {
      await fs.mkdir(project, { mode: 0o700 });
      await fs.mkdir(home, { mode: 0o700 });
      await fs.mkdir(join(project, 'links'), { mode: 0o750 });
      await fs.mkdir(join(project, 'empty-dir'), { mode: 0o750 });
      await fs.writeFile(join(project, 'links/a'), 'hard-linked bytes', { mode: 0o640 });
      await fs.link(join(project, 'links/a'), join(project, 'links/b'));
      const sessions = join(home, '.codex/sessions/2026/09/30');
      await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        join(sessions, `rollout-2026-09-30T00-00-00-${nativeSessionId}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload: { id: nativeSessionId, cwd: project } })}\n`,
        { mode: 0o600 },
      );
      await fs.writeFile(join(home, '.codex/auth.json'), 'do-not-back-up-this-credential', {
        mode: 0o600,
      });
      const runtime = {
        project,
        home,
        harness: 'codex',
        nativeSessionId,
        limits: {
          maxFiles: NATIVE_RECOVERY_LIMITS.files,
          maxEntries: NATIVE_RECOVERY_LIMITS.entries,
          maxFileBytes: NATIVE_RECOVERY_LIMITS.fileBytes,
          maxTotalBytes: NATIVE_RECOVERY_LIMITS.totalBytes,
          maxDepth: NATIVE_RECOVERY_LIMITS.depth,
        },
      };
      const captured = await captureNativeSessionRecovery(runtime);
      const { store } = setup();
      const receipt = await store.publish({
        ...input(),
        files: captured.files,
        filesystem: captured.metadata,
      });
      const loaded = await store.readFiles(identity, receipt);
      expect(loaded.manifest.filesystem).toEqual(captured.metadata);
      await fs.rename(project, join(root, 'old-project'));
      await fs.rename(home, join(root, 'old-home'));
      await fs.mkdir(project, { mode: 0o700 });
      await fs.mkdir(home, { mode: 0o700 });
      expect(
        await restoreNativeSessionRecovery({
          ...runtime,
          metadata: loaded.manifest.filesystem,
          files: loaded.files,
        }),
      ).toMatchObject({ restored: true, nativeSessionId });
      expect(await fs.readdir(join(project, 'empty-dir'))).toEqual([]);
      const a = await fs.stat(join(project, 'links/a'), { bigint: true });
      const b = await fs.stat(join(project, 'links/b'), { bigint: true });
      expect(a.ino).toBe(b.ino);
      for (const entry of captured.metadata.directories) {
        const restored = await fs.stat(
          join(entry.scope === 'project' ? project : home, entry.path),
          { bigint: true },
        );
        expect(String(restored.mtimeNs)).toBe(entry.mtimeNs);
        expect(Number(restored.mode & 0o777n)).toBe(entry.mode);
      }
      await expect(fs.stat(join(home, '.codex/auth.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('concurrent identical uploads converge through create-only readback', async () => {
    const { store, versions } = setup();
    const [a, b] = await Promise.all([store.publish(input()), store.publish(input())]);
    expect(a).toEqual(b);
    expect(versions.size).toBe(input().files.length + 1);
  });

  it('retains earlier exact versions across changed content, later turns and overwritten latest keys', async () => {
    const { store, memory, calls } = setup();
    const first = await store.publish(input());
    const old = await store.read(identity, first);
    const changed = input();
    changed.sequence++;
    changed.files[0] = file('project', 'src/bird.js', 'updated\n', { mode: 0o644 });
    const second = await store.publish(changed);
    expect(second.id).not.toBe(first.id);
    const entry = old.files.find((value) => value.path === 'src/bird.js');
    memory.seed(entry.object.key, Buffer.from('untrusted latest bytes'));
    calls.length = 0;
    expect(await store.file(identity, first, entry)).toEqual(input().files[0].content);
    expect((await store.read(identity, first)).sequence).toBe(2);
    expect((await store.read(identity, second)).sequence).toBe(3);
    expect(calls.every((call) => typeof call.input.VersionId === 'string')).toBe(true);
  });

  it('reconciles acknowledged-but-lost file and manifest uploads only by exact readback', async () => {
    const { store, memory, calls } = setup();
    memory.afterPut = () => {
      throw new Error('credential-bearing SDK response must not escape');
    };
    const receipt = await store.publish(input());
    expect((await store.read(identity, receipt)).files).toHaveLength(input().files.length);
    expect(
      calls.filter((call) => call.constructor.name === 'GetObjectCommand' && !call.input.VersionId),
    ).toHaveLength(input().files.length + 1);
  });

  it('does not commit a manifest when an earlier file could not be uploaded', async () => {
    const { store, memory, calls } = setup();
    memory.before = (command) => {
      if (command.constructor.name === 'PutObjectCommand')
        throw new Error('secret provider context');
    };
    await expect(store.publish(input())).rejects.toMatchObject(UNAVAILABLE);
    expect(calls.some((call) => call.input.Key.includes('/manifests/'))).toBe(false);
  });

  it('rejects a poisoned content-addressed object instead of overwriting it during replay', async () => {
    const { store, memory, versions } = setup();
    const receipt = await store.publish(input());
    const manifest = await store.read(identity, receipt);
    const entry = manifest.files[0];
    memory.seed(entry.object.key, Buffer.alloc(entry.bytes, 120));
    const count = versions.size;
    await expect(store.publish(input())).rejects.toMatchObject(INVALID);
    expect(versions.size).toBe(count);
  });

  it.each(['projectId', 'executionId', 'bindingId', 'attemptId', 'epoch', 'runtimeSessionId'])(
    'binds reads to the original %s, including after cancellation',
    async (field) => {
      const { store, calls } = setup();
      const receipt = await store.publish(input());
      calls.length = 0;
      const changed = { ...identity, [field]: field === 'epoch' ? 2 : otherId };
      await expect(store.read(changed, receipt)).rejects.toMatchObject(INVALID);
      expect(fileGets(calls)).toHaveLength(0);
      expect(manifestGets(calls)).toHaveLength(
        ['bindingId', 'runtimeSessionId'].includes(field) ? 1 : 0,
      );
      expect((await store.read(identity, receipt)).scope).toEqual(identity);
    },
  );

  it('snapshots caller-owned buffers, pins, identity and continuation before any upload', async () => {
    const { store, memory } = setup();
    let unblock;
    const gate = new Promise((resolve) => {
      unblock = resolve;
    });
    let first = true;
    memory.before = async () => {
      if (first) {
        first = false;
        await gate;
      }
    };
    const source = input();
    const publishing = store.publish(source);
    source.files[0].content.fill(0);
    source.files[0].path = 'changed';
    source.identity.bindingId = otherId;
    source.configurationSha256 = '0'.repeat(64);
    source.continuation.priorAssistantSha256 = '0'.repeat(64);
    source.filesystem.directories[0].mtimeNs = '0';
    source.filesystem.directories.length = 0;
    source.files.length = 0;
    unblock();
    const receipt = await publishing;
    const manifest = await store.read(identity, receipt);
    expect(manifest).toMatchObject({ scope: identity, ...metadata });
    const entry = manifest.files.find((value) => value.path === 'src/bird.js');
    expect(await store.file(identity, receipt, entry)).toEqual(input().files[0].content);
  });

  it('snapshots read receipt/identity and selected file before awaiting storage', async () => {
    const { store, memory } = setup();
    const receipt = await store.publish(input());
    const manifest = await store.read(identity, receipt);
    const entry = structuredClone(manifest.files[0]);
    const requestedIdentity = { ...identity };
    const requestedReceipt = structuredClone(receipt);
    memory.before = () => {
      requestedIdentity.epoch++;
      requestedReceipt.sequence++;
      entry.mode = 0o777;
    };
    expect(await store.file(requestedIdentity, requestedReceipt, entry)).toEqual(
      input().files.find(
        (value) => value.scope === manifest.files[0].scope && value.path === manifest.files[0].path,
      ).content,
    );
  });

  it.each(['configurationSha256', 'packageId', 'imageDigest', 'publicationId', 'interactionId'])(
    'pins %s into checkpoint identity',
    async (field) => {
      const { store } = setup();
      const first = await store.publish(input());
      const changed = input();
      changed[field] = ['packageId', 'imageDigest'].includes(field)
        ? `sha256:${'1'.repeat(64)}`
        : '1'.repeat(64);
      const second = await store.publish(changed);
      expect(second.id).not.toBe(first.id);
      expect((await store.read(identity, second))[field]).toBe(changed[field]);
    },
  );

  it.each(['literal', 'aidlc-skill-expansion'])(
    'preserves bounded Kiro %s continuation evidence',
    async (source) => {
      const { store } = setup();
      const data = input();
      data.harness = 'kiro';
      data.filesystem = filesystem('kiro');
      data.continuation.promptEvidence = {
        userPromptSha256: '2'.repeat(64),
        userPromptSource: source,
      };
      expect((await store.read(identity, await store.publish(data))).continuation).toEqual(
        data.continuation,
      );
    },
  );

  it.each(['claude', 'codex', 'opencode'])('rejects Kiro evidence for %s', async (harness) => {
    const { store, calls } = setup();
    const data = input();
    data.harness = harness;
    data.filesystem = filesystem(harness);
    data.continuation.promptEvidence = {
      userPromptSha256: '2'.repeat(64),
      userPromptSource: 'literal',
    };
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['writerAuthorized', true],
    ['credentials', { token: 'private' }],
    ['debugEnabled', false],
    ['restoreConfig', true],
    ['materializationId', `sha256:${'a'.repeat(64)}`],
  ])(
    'rejects unknown metadata %s without persisting authority, credentials or debug policy',
    async (key, value) => {
      const { store, calls } = setup();
      await expect(store.publish({ ...input(), [key]: value })).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects raw prompt/credential continuation fields', async () => {
    const { store, calls } = setup();
    const data = input();
    data.continuation.prompt = 'credential-bearing prompt';
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it('excludes supplied credential bytes before writes, without redaction or recording the scan list', async () => {
    const { store, calls } = setup();
    const data = input();
    data.forbiddenBytes = ['sensitive-credential'];
    data.files[0] = file('project', 'data', 'prefix sensitive-credential suffix');
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
    const good = { ...input(), forbiddenBytes: ['sensitive-credential'] };
    const receipt = await store.publish(good);
    const manifest = await store.read(identity, receipt);
    expect(JSON.stringify(manifest)).not.toContain('sensitive-credential');
    expect(manifest).not.toHaveProperty('forbiddenBytes');
  });

  it('also excludes supplied credentials from path/metadata values', async () => {
    const { store, calls } = setup();
    const data = input();
    data.nativeSessionId = 'sensitive-credential';
    data.forbiddenBytes = [Buffer.from('sensitive-credential')];
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it.each([
    '',
    '../outside',
    '/absolute',
    'a/../b',
    'a//b',
    'a/./b',
    'a/',
    'a\\b',
    'C:/outside',
    'a/\0b',
    'a/\u007fb',
    '\ud800',
    'a'.repeat(256),
    `${'a/'.repeat(64)}leaf`,
    `${'a'.repeat(200)}/`.repeat(12) + 'leaf',
  ])('rejects unsafe or unbounded path %j', async (path) => {
    const { store, calls } = setup();
    const data = input();
    data.files[0].path = path;
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it.each(['../home', 'root', '/home/node', 'publication', null, ['home']])(
    'rejects an unrecognized private file scope %j',
    async (scope) => {
      const { store, calls } = setup();
      const data = input();
      data.files[0].scope = scope;
      await expect(store.publish(data)).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    },
  );

  it('permits distinct project/home names but rejects duplicate paths and file/parent collisions', async () => {
    const { store } = setup();
    const data = input();
    data.files = [file('home', 'same', ''), file('project', 'same', '')];
    expect((await store.read(identity, await store.publish(data))).files).toHaveLength(2);
    for (const files of [
      [file('home', 'same', ''), file('home', 'same', '')],
      [file('project', 'a/b', ''), file('project', 'a/b/c', '')],
    ]) {
      const { store: invalidStore, calls } = setup();
      await expect(invalidStore.publish({ ...input(), files })).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    }
  });

  it.each([0o100600, 0o4755, 0o1777, -1, 0.5, '384', null, [384]])(
    'rejects non-permission or malformed mode %j',
    async (mode) => {
      const { store, calls } = setup();
      const data = input();
      data.files[0].mode = mode;
      await expect(store.publish(data)).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    '-0',
    '01',
    '+1',
    '1e9',
    '1.5',
    '',
    '9223372036854775808',
    '-9223372036854775809',
    123,
    ['123'],
    null,
  ])('rejects noncanonical or out-of-range nanosecond timestamp %j', async (mtimeNs) => {
    const { store, calls } = setup();
    const data = input();
    data.files[0].mtimeNs = mtimeNs;
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it.each(['-9223372036854775808', '0', '9223372036854775807'])(
    'round-trips exact signed-64-bit timestamp %s without Number conversion',
    async (mtimeNs) => {
      const { store } = setup();
      const data = input();
      data.files[0].mtimeNs = mtimeNs;
      const manifest = await store.read(identity, await store.publish(data));
      expect(manifest.files.find((value) => value.path === data.files[0].path).mtimeNs).toBe(
        mtimeNs,
      );
    },
  );

  it.each(['bytes', 'sha256'])(
    'rejects a false capture-supplied %s before writes',
    async (field) => {
      const { store, calls } = setup();
      const data = input();
      data.files[0][field] = field === 'bytes' ? 1234 : '0'.repeat(64);
      await expect(store.publish(data)).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    },
  );

  it.each(['uid', 'symlink', 'target', 'restorePermission'])(
    'rejects file metadata %s',
    async (key) => {
      const { store, calls } = setup();
      const data = input();
      data.files[0][key] = 'untrusted';
      await expect(store.publish(data)).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    'sequence',
    'nativeSessionId',
    'configurationSha256',
    'packageId',
    'imageDigest',
    'publicationId',
    'interactionId',
  ])('rejects array coercion for %s', async (key) => {
    const { store, calls } = setup();
    const data = input();
    data[key] = [data[key]];
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null])(
    'rejects invalid sequence %j before writes',
    async (sequence) => {
      const { store, calls } = setup();
      await expect(store.publish({ ...input(), sequence })).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    },
  );

  it.each(Object.keys(identity))(
    'rejects coercible identity field %s before writes',
    async (key) => {
      const { store, calls } = setup();
      const data = input();
      data.identity[key] = [data.identity[key]];
      await expect(store.publish(data)).rejects.toMatchObject(INVALID);
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects inherited fields, accessors, symbols and sparse inventories without invoking getters', async () => {
    const { store, calls } = setup();
    const inherited = Object.create(input());
    const getter = vi.fn(() => metadata.sequence);
    const accessor = input();
    Object.defineProperty(accessor, 'sequence', { enumerable: true, get: getter });
    const symbol = input();
    symbol[Symbol('hidden')] = 'secret';
    const sparse = input();
    delete sparse.files[1];
    for (const data of [inherited, accessor, symbol, sparse])
      await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(getter).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('enforces file count and per-file byte bounds before copying content', async () => {
    const { store, calls } = setup();
    const tooMany = input();
    tooMany.files = Array(NATIVE_RECOVERY_LIMITS.files + 1).fill(tooMany.files[0]);
    await expect(store.publish(tooMany)).rejects.toMatchObject(INVALID);
    const tooLarge = input();
    tooLarge.files[0].bytes = NATIVE_RECOVERY_LIMITS.fileBytes + 1;
    await expect(store.publish(tooLarge)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it('enforces the aggregate byte bound before making per-file copies or uploads', async () => {
    const { store, calls } = setup();
    const shared = Buffer.alloc(NATIVE_RECOVERY_LIMITS.fileBytes);
    const data = input();
    data.files = Array.from({ length: 5 }, (_, index) => ({
      scope: 'home',
      path: `state-${index}`,
      bytes: shared.length,
      sha256: '0'.repeat(64),
      mode: 0o600,
      mtimeNs: '0',
      content: shared,
    }));
    await expect(store.publish(data)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it.each([
    (r) => {
      r.writerAuthorized = true;
    },
    (r) => {
      r.sequence++;
    },
    (r) => {
      r.id = '0'.repeat(64);
    },
    (r) => {
      r.manifest.key = r.manifest.key.replace('native-recovery/', 'native-executions/');
    },
    (r) => {
      r.manifest.versionId = 'null';
    },
    (r) => {
      r.manifest.versionId = ['v1'];
    },
    (r) => {
      r.manifest.bytes = NATIVE_RECOVERY_LIMITS.manifestBytes + 1;
    },
    (r) => {
      r.manifest.bytes = '123';
    },
  ])('rejects a forged receipt without accepting a different checkpoint', async (mutate) => {
    const { store } = setup();
    const receipt = await store.publish(input());
    mutate(receipt);
    await expect(store.read(identity, receipt)).rejects.toMatchObject(INVALID);
  });

  it.each([
    (m) => {
      m.writerAuthorized = true;
    },
    (m) => {
      m.scope.bindingId = otherId;
    },
    (m) => {
      m.scope.runtimeSessionId = otherId;
    },
    (m) => {
      m.scope.epoch++;
    },
    (m) => {
      m.scope.actorId = 'admin';
    },
    (m) => {
      m.configurationSha256 = [m.configurationSha256];
    },
    (m) => {
      m.continuation.priorAssistantSha256 = 123;
    },
    (m) => {
      m.continuation.promptEvidence = {
        userPromptSha256: 'a'.repeat(64),
        userPromptSource: 'literal',
      };
    },
    (m) => {
      m.files[0].object.key = 'native-execution-control/v1/foreign/state.json';
    },
    (m) => {
      m.files[0].object.versionId = 'null';
    },
    (m) => {
      m.files[0].mode = 0o4755;
    },
    (m) => {
      m.files[0].scope = 'elsewhere';
    },
    (m) => {
      m.files[0].path = '../outside';
    },
    (m) => {
      m.files.push(structuredClone(m.files[0]));
    },
    (m) => {
      Object.defineProperty(m, '__proto__', { enumerable: true, value: { approved: true } });
    },
  ])('rejects rehashed malicious manifest metadata before any file read', async (mutate) => {
    const { store, forge, calls } = setup();
    const receipt = await store.publish(input());
    const poisoned = forge(receipt, mutate);
    calls.length = 0;
    await expect(store.read(identity, poisoned)).rejects.toMatchObject(INVALID);
    expect(fileGets(calls)).toHaveLength(0);
    expect({}.approved).toBeUndefined();
  });

  it('rejects duplicate JSON keys even when the final parsed value and content hash agree', async () => {
    const { store, forge } = setup();
    const receipt = await store.publish(input());
    const duplicate = forge(
      receipt,
      () => {},
      (m) => `{"schemaVersion":0,${canonicalJson(m).slice(1)}`,
    );
    await expect(store.read(identity, duplicate)).rejects.toMatchObject(INVALID);
  });

  it('rejects corrupted file bytes during both full verification and individual restore reads', async () => {
    const { store, versions } = setup();
    const receipt = await store.publish(input());
    const manifest = await store.read(identity, receipt);
    const entry = manifest.files.find((value) => value.bytes > 0);
    versions.set(`${entry.object.key}:${entry.object.versionId}`, Buffer.alloc(entry.bytes, 88));
    await expect(store.read(identity, receipt)).rejects.toMatchObject(INVALID);
    await expect(store.readFiles(identity, receipt)).rejects.toMatchObject(INVALID);
    await expect(store.file(identity, receipt, entry)).rejects.toMatchObject(INVALID);
  });

  it('requires the complete selected entry to equal the versioned manifest entry', async () => {
    const { store, calls } = setup();
    const receipt = await store.publish(input());
    const manifest = await store.read(identity, receipt);
    const entry = manifest.files[0];
    for (const patch of [
      { mode: entry.mode ^ 0o100 },
      { mtimeNs: '123' },
      { object: { ...entry.object, versionId: 'other-version' } },
    ]) {
      calls.length = 0;
      await expect(store.file(identity, receipt, { ...entry, ...patch })).rejects.toMatchObject(
        INVALID,
      );
      expect(fileGets(calls)).toHaveLength(0);
    }
  });

  it.each(['version', 'length', 'oversize', 'truncated', 'string-chunk', 'stream-error'])(
    'rejects or safely reports a malformed %s storage response and closes its body',
    async (kind) => {
      const { store, memory } = setup();
      const receipt = await store.publish(input());
      let close;
      memory.onGet = (_command, result) => {
        if (kind === 'version') result.VersionId = 'wrong-version';
        if (kind === 'length') result.ContentLength = String(result.ContentLength);
        if (kind === 'oversize')
          result.Body = Readable.from([Buffer.alloc(result.ContentLength + 1)]);
        if (kind === 'truncated')
          result.Body = Readable.from([Buffer.alloc(result.ContentLength - 1)]);
        if (kind === 'string-chunk') result.Body = Readable.from(['not raw bytes']);
        if (kind === 'stream-error') {
          result.Body = Readable.from(
            (async function* () {
              yield Buffer.from('{');
              throw new Error('private token in SDK error');
            })(),
          );
        }
        close = vi.spyOn(result.Body, 'destroy');
        return result;
      };
      await expect(store.read(identity, receipt)).rejects.toMatchObject(
        kind === 'stream-error' ? UNAVAILABLE : INVALID,
      );
      expect(close).toHaveBeenCalled();
    },
  );

  it('does not expose storage errors or credential-bearing causes', async () => {
    const { store, memory } = setup();
    const receipt = await store.publish(input());
    memory.before = () => {
      throw new Error('private credential');
    };
    try {
      await store.read(identity, receipt);
      expect.fail('expected rejection');
    } catch (error) {
      expect(error).toMatchObject(UNAVAILABLE);
      expect(error.message).not.toContain('private credential');
      expect(error).not.toHaveProperty('cause');
    }
  });

  it.each(
    ['NoSuchKey', 'NoSuchVersion', 'NotFound'].flatMap((name) =>
      ['manifest', 'file'].map((kind) => [name, kind]),
    ),
  )(
    'reports SDK %s for an exact %s version as missing on every read interface',
    async (name, kind) => {
      const { store, memory, calls } = setup();
      const receipt = await store.publish(input());
      const manifest = await store.read(identity, receipt);
      const entry = manifest.files[0];
      const pointer = kind === 'manifest' ? receipt.manifest : entry.object;
      memory.before = (command) => {
        if (command.input.Key !== pointer.key) return;
        expect(command.input.VersionId).toBe(pointer.versionId);
        const options = {
          name,
          $fault: 'client',
          $metadata: { httpStatusCode: 404 },
          message: 'private credential-bearing storage context',
        };
        throw name === 'NoSuchKey' ? new NoSuchKey(options) : new S3ServiceException(options);
      };
      for (const read of [
        () => store.read(identity, receipt),
        () => store.readFiles(identity, receipt),
        () => store.file(identity, receipt, entry),
      ]) {
        calls.length = 0;
        const error = await read().then(
          () => expect.fail('expected missing exact version'),
          (failure) => failure,
        );
        expect(error).toMatchObject(MISSING);
        expect(error.message).toBe('Native recovery checkpoint object version is missing');
        expect(error).not.toHaveProperty('cause');
        expect(error).not.toHaveProperty('$metadata');
        expect(calls.every((command) => typeof command.input.VersionId === 'string')).toBe(true);
      }
    },
  );

  it.each([
    ['AccessDenied', 403],
    ['SlowDown', 503],
    ['InternalError', 500],
    ['NotFound', 503],
    ['NoSuchBucket', 404],
    ['TimeoutError', undefined],
  ])('keeps SDK %s separate from a missing checkpoint', async (name, httpStatusCode) => {
    const { store, memory } = setup();
    const receipt = await store.publish(input());
    memory.before = () => {
      throw new S3ServiceException({
        name,
        $fault: 'server',
        $metadata: { httpStatusCode },
        message: 'private storage request context',
      });
    };
    const error = await store.read(identity, receipt).catch((failure) => failure);
    expect(error).toMatchObject(UNAVAILABLE);
    expect(error.message).toBe('Native recovery storage is unavailable');
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('$metadata');
  });

  it('never permits metadata-only verification through the controller read interface', async () => {
    const { store, calls } = setup();
    const receipt = await store.publish(input());
    calls.length = 0;
    for (const options of [{ verifyFiles: false }, {}, { verifyFiles: true, skipPins: true }])
      await expect(store.read(identity, receipt, options)).rejects.toMatchObject(INVALID);
    expect(calls).toHaveLength(0);
  });

  it.each(['read', 'readFiles'])(
    'bounds %s concurrent streams and closes all started reads before returning',
    async (method) => {
      const { store, memory } = setup();
      const data = input();
      data.files = Array.from({ length: 12 }, (_, i) => file('project', `f${i}`, 'bytes'));
      const receipt = await store.publish(data);
      let active = 0,
        maximum = 0,
        finished = 0;
      memory.onGet = (command, result) => {
        if (!command.input.Key.includes('/files/')) return result;
        result.Body.destroy();
        result.Body = Readable.from(
          (async function* () {
            active++;
            maximum = Math.max(maximum, active);
            try {
              await new Promise((resolve) => setImmediate(resolve));
              yield Buffer.from('bytes');
            } finally {
              active--;
              finished++;
            }
          })(),
        );
        return result;
      };
      await store[method](identity, receipt);
      expect(maximum).toBeGreaterThan(1);
      expect(maximum).toBeLessThanOrEqual(4);
      expect(active).toBe(0);
      expect(finished).toBe(data.files.length);
    },
  );

  it.each(['read', 'readFiles'])(
    '%s waits for already-started streams after failure without scheduling more reads',
    async (method) => {
      const { store, memory } = setup();
      const data = input();
      data.files = Array.from({ length: 12 }, (_, i) => file('project', `f${i}`, 'bytes'));
      const receipt = await store.publish(data);
      let active = 0;
      let started = 0;
      let finished = 0;
      memory.onGet = (command, result) => {
        if (!command.input.Key.includes('/files/')) return result;
        const position = started++;
        result.Body.destroy();
        result.Body = Readable.from(
          (async function* () {
            active++;
            try {
              if (position > 0) await new Promise((resolve) => setImmediate(resolve));
              yield Buffer.from(position === 0 ? 'wrong' : 'bytes');
            } finally {
              active--;
              finished++;
            }
          })(),
        );
        return result;
      };
      await expect(store[method](identity, receipt)).rejects.toMatchObject(INVALID);
      expect(started).toBe(4);
      expect(active).toBe(0);
      expect(finished).toBe(started);
    },
  );

  it('validates constructor fields and exported receipt/path helpers without coercion', () => {
    for (const options of [
      { s3: { send() {} }, bucket: ['private-native-recovery'], accountId: '123456789012' },
      { s3: { send() {} }, bucket: 'private-native-recovery', accountId: 123456789012 },
      { s3: {}, bucket: 'private-native-recovery', accountId: '123456789012' },
      {
        s3: { send() {} },
        bucket: 'private-native-recovery',
        accountId: '123456789012',
        debug: false,
      },
    ])
      expect(() => createNativeRecoveryCheckpoints(options)).toThrow();
    expect(nativeRecoveryPath('project', 'src/日本語.txt')).toBe('src/日本語.txt');
    expect(() => nativeRecoveryReceipt({}, identity)).toThrow();
    expect(() => nativeRecoveryScope({ ...identity, approved: true })).toThrow();
  });
});
