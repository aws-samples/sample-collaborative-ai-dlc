import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import tar from 'tar-stream';
import {
  inspectNativeRuntimeArchive,
  verifyNativeReleaseDirectory,
} from '../native-runtime-package.js';

const exec = promisify(execFile);
const roots = [];
const version = '2.9.0';
const source = {
  provider: 'github',
  repository: 'example/private-workflows',
  release: `v${version}`,
  commit: 'a'.repeat(40),
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const harnessDirs = { claude: '.claude', codex: '.codex', kiro: '.kiro', opencode: '.aidlc' };

const projectionEntries = () =>
  Object.entries(harnessDirs).flatMap(([harness, harnessDir]) => {
    const root = `runtime/${harness}`;
    const data = `${root}/${harnessDir}/tools/data`;
    const json = (name, body) => ({ name, body: JSON.stringify(body) });
    return [
      json(`${data}/aidlc-stamp.json`, {
        schemaVersion: 1,
        frameworkVersion: version,
        distribution: harness,
        harnessDir,
      }),
      json(`${data}/aidlc-projection.json`, {
        schemaVersion: 1,
        distribution: harness,
        harnessDir,
        productName: 'AI-DLC',
        configNextStep: 'Review installed configuration',
        managedDirectories: [harnessDir],
        rootIntegrations: [{ path: 'AGENTS.md', policy: 'whole-file' }],
      }),
      { name: `${root}/${harnessDir}/tools/native.js`, body: '// never executed\n' },
      { name: `${root}/AGENTS.md`, body: '# Native instructions\n' },
    ];
  });

const archiveFor = async (entries, transform = (bytes) => bytes) => {
  const pack = tar.pack();
  const chunks = [];
  const consume = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const { body = '', ...header } of entries) {
    await new Promise((resolve, reject) =>
      pack.entry(header, body, (error) => (error ? reject(error) : resolve())),
    );
  }
  pack.finalize();
  await consume;
  return gzipSync(transform(Buffer.concat(chunks)));
};

const withClaudeDescriptor = (configure) => {
  const entries = projectionEntries();
  const entry = entries.find(
    ({ name }) => name === 'runtime/claude/.claude/tools/data/aidlc-projection.json',
  );
  const descriptor = JSON.parse(entry.body);
  configure(descriptor, entries);
  entry.body = JSON.stringify(descriptor);
  return entries;
};

const legacyHashes = [
  `sha256:${digest('previously shipped content')}`,
  `sha256:${digest('older shipped content')}`,
];

const makeRelease = async ({ entries = projectionEntries(), runtime: providedRuntime } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'native-package-test-'));
  roots.push(directory);
  const binary = Buffer.from('synthetic executable bytes; never executed');
  const runtime = providedRuntime ?? (await archiveFor(entries));
  const assets = [
    {
      name: 'aidlc-linux-arm64',
      kind: 'binary',
      target: 'linux-arm64',
      sha256: digest(binary),
      bytes: binary.length,
    },
    {
      name: `aidlc-runtime-${version}.tar.gz`,
      kind: 'runtime',
      sha256: digest(runtime),
      bytes: runtime.length,
    },
  ];
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      version,
      date: '2026-09-15',
      sourceRef: `refs/tags/${source.release}`,
      sourceDigest: source.commit,
      distributions: Object.keys(harnessDirs).map((name) => ({ name, productName: 'AI-DLC' })),
      assets,
    }),
  );
  const checksums =
    [
      `${digest(manifest)}  version.json`,
      ...assets.map((asset) => `${asset.sha256}  ${asset.name}`),
    ].join('\n') + '\n';
  await Promise.all([
    writeFile(join(directory, 'version.json'), manifest),
    writeFile(join(directory, 'checksums.txt'), checksums),
    writeFile(join(directory, assets[0].name), binary),
    writeFile(join(directory, assets[1].name), runtime),
  ]);
  return directory;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native runtime archive intake', () => {
  it('checks all four projections and retains plugin content in the byte inventory', async () => {
    const entries = [
      ...projectionEntries(),
      { name: 'plugins/example/codex/.codex/instructions.md', body: 'plugin content' },
    ];
    const result = await inspectNativeRuntimeArchive(await archiveFor(entries), { version });
    expect(result.fileCount).toBe(17);
    expect(result.projections).toHaveLength(4);
    expect(result.projections.find((p) => p.harness === 'opencode').harnessDir).toBe('.aidlc');
  });

  it.each([
    '../escape',
    '/absolute',
    'runtime/claude/../escape',
    'runtime\\claude\\escape',
    'C:/escape',
  ])('rejects unsafe archive path %s', async (name) => {
    await expect(
      inspectNativeRuntimeArchive(await archiveFor([{ name, body: 'bad' }]), { version }),
    ).rejects.toThrow(/unsafe path/);
  });

  it.each(['symlink', 'link', 'fifo'])('rejects %s archive entries', async (type) => {
    await expect(
      inspectNativeRuntimeArchive(
        await archiveFor([{ name: 'runtime/claude/link', type, linkname: '/tmp/elsewhere' }]),
        { version },
      ),
    ).rejects.toThrow(/link or special file/);
  });

  it('rejects duplicate entries and file/directory shadowing in either order', async () => {
    for (const names of [
      ['runtime/claude/a', 'runtime/claude/a'],
      ['runtime/claude/a', 'runtime/claude/a/b'],
      ['runtime/claude/a/b', 'runtime/claude/a'],
    ]) {
      await expect(
        inspectNativeRuntimeArchive(
          await archiveFor(names.map((name) => ({ name, body: 'bad' }))),
          { version },
        ),
      ).rejects.toThrow(/duplicate|shadows/);
    }
  });

  it.each([
    [{ entries: 1 }, /too many entries/],
    [{ expandedBytes: 1 }, /expanded size/],
    [{ decodedBytes: 100 }, /decoded size/],
    [{ metadataBytes: 1 }, /metadata is too large/],
    [{ entryBytes: 1 }, /entry exceeds/],
    [{ compressedBytes: 1 }, /compressed size/],
  ])('bounds archive work with %j', async (limits, message) => {
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(projectionEntries()), { version, limits }),
    ).rejects.toThrow(message);
  });

  it('counts implicit directories toward the entry limit', async () => {
    const archive = await archiveFor([{ name: 'runtime/claude/a/b/c/file', body: 'data' }]);
    await expect(
      inspectNativeRuntimeArchive(archive, { version, limits: { entries: 4 } }),
    ).rejects.toThrow(/too many entries/);
  });

  it.each([512, 1024])('rejects projections hidden after a %i-byte zero prefix', async (size) => {
    const archive = await archiveFor(projectionEntries(), (bytes) =>
      Buffer.concat([Buffer.alloc(size), bytes]),
    );
    await expect(inspectNativeRuntimeArchive(archive, { version })).rejects.toThrow(
      /non-padding data after tar termination/,
    );
  });

  it('rejects a nonzero pseudo-header that the tar parser silently skips', async () => {
    const archive = await archiveFor(projectionEntries(), (bytes) => {
      const prefix = Buffer.alloc(512);
      // tar-stream recognizes null headers without checking the checksum field.
      prefix.write('000400', 148, 'ascii');
      return Buffer.concat([prefix, bytes]);
    });
    await expect(inspectNativeRuntimeArchive(archive, { version })).rejects.toThrow(
      /unparsed tar headers/,
    );
  });

  it.each([
    ['a second tar archive', (bytes) => Buffer.concat([bytes, bytes])],
    ['one trailing nonzero byte', (bytes) => Buffer.concat([bytes, Buffer.from('x')])],
    [
      'data after extra zero padding',
      (bytes) => Buffer.concat([bytes, Buffer.alloc(20 * 512), Buffer.from('unexpected')]),
    ],
    [
      'a nonzero second end block',
      (bytes) => {
        const changed = Buffer.from(bytes);
        changed[changed.length - 1] = 1;
        return changed;
      },
    ],
  ])('rejects %s after tar termination', async (_label, transform) => {
    const archive = await archiveFor(projectionEntries(), transform);
    await expect(inspectNativeRuntimeArchive(archive, { version })).rejects.toThrow(
      /non-padding data after tar termination/,
    );
  });

  it('rejects a second gzip member containing another tar archive', async () => {
    const archive = await archiveFor(projectionEntries());
    await expect(
      inspectNativeRuntimeArchive(Buffer.concat([archive, archive]), { version }),
    ).rejects.toThrow(/non-padding data after tar termination/);
  });

  it.each([
    ['missing end blocks', (bytes) => bytes.subarray(0, -1024)],
    ['only one end block', (bytes) => bytes.subarray(0, -512)],
    ['a partial end block', (bytes) => bytes.subarray(0, -1)],
    ['partial trailing padding', (bytes) => Buffer.concat([bytes, Buffer.alloc(1)])],
  ])('rejects %s', async (_label, transform) => {
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(projectionEntries(), transform), { version }),
    ).rejects.toThrow(/missing or truncated tar termination/);
  });

  it('accepts zero-filled file payloads and complete trailing padding blocks', async () => {
    const entries = projectionEntries();
    entries.push({
      name: 'runtime/claude/.claude/tools/data/zero-filled.bin',
      body: Buffer.alloc(32 * 1024),
    });
    const archive = await archiveFor(entries, (bytes) =>
      Buffer.concat([bytes, Buffer.alloc(20 * 512)]),
    );
    const result = await inspectNativeRuntimeArchive(archive, { version });
    expect(result.fileCount).toBe(17);
    expect(result.expandedBytes).toBe(
      entries.reduce((sum, { body }) => sum + Buffer.byteLength(body), 0),
    );
    expect(result.projections).toHaveLength(4);
  });

  it('preserves PAX metadata support and counts its bytes toward the decoded limit', async () => {
    const entries = projectionEntries();
    entries[0].pax = { comment: 'metadata'.repeat(4096) };
    const archive = await archiveFor(entries);
    expect((await inspectNativeRuntimeArchive(archive, { version })).projections).toHaveLength(4);
    await expect(
      inspectNativeRuntimeArchive(archive, { version, limits: { decodedBytes: 16 * 1024 } }),
    ).rejects.toThrow(/decoded size limit/);
  });

  it('accepts bounded base-256 entry sizes supported by the tar parser', async () => {
    const entries = projectionEntries();
    const archive = await archiveFor(entries, (bytes) => {
      const header = bytes.subarray(0, 512);
      header.fill(0, 124, 136);
      header[124] = 0x80;
      header.writeUIntBE(Buffer.byteLength(entries[0].body), 130, 6);
      header.fill(32, 148, 156);
      const checksum = header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0');
      header.write(`${checksum}\0 `, 148, 'ascii');
      return bytes;
    });
    expect((await inspectNativeRuntimeArchive(archive, { version })).projections).toHaveLength(4);
  });

  it('rejects PAX size overrides that change the physical tar framing', async () => {
    const entries = projectionEntries();
    entries[0].pax = { size: '0' };
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
    ).rejects.toThrow(/entry size disagrees with its tar header/);
  });

  it('rejects corruption and missing harnesses instead of reporting partial support', async () => {
    await expect(inspectNativeRuntimeArchive(Buffer.from('not gzip'), { version })).rejects.toThrow(
      /corrupt/,
    );
    const incomplete = projectionEntries().filter((e) => !e.name.startsWith('runtime/kiro/'));
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(incomplete), { version }),
    ).rejects.toThrow(/one projection stamp for kiro/);
  });

  it('rejects inconsistent projection versions, missing integration files and undeclared files', async () => {
    const wrongVersion = projectionEntries();
    wrongVersion[0].body = wrongVersion[0].body.replace(version, '2.8.0');
    const missingFile = projectionEntries().filter((e) => e.name !== 'runtime/claude/AGENTS.md');
    const extraFile = [
      ...projectionEntries(),
      { name: 'runtime/claude/undeclared-hook', body: 'bad' },
    ];
    for (const entries of [wrongVersion, missingFile, extraFile]) {
      await expect(
        inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
      ).rejects.toThrow(/identity|root integration|unclassified/);
    }
  });

  it('rejects malformed JSON integration keys and empty unclassified directories', async () => {
    const entries = projectionEntries();
    const descriptor = JSON.parse(entries[1].body);
    descriptor.rootIntegrations[0] = { path: 'AGENTS.md', policy: 'json-array' };
    entries[1].body = JSON.stringify(descriptor);
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
    ).rejects.toThrow(/root integration/);
    const extraDirectory = [
      ...projectionEntries(),
      {
        name: 'runtime/claude/undeclared/',
        type: 'directory',
      },
    ];
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(extraDirectory), { version }),
    ).rejects.toThrow(/unclassified/);
  });
});

describe('upstream projection legacy metadata', () => {
  it('accepts historical managed-file, whole-file and JSON-entry signatures', async () => {
    const entries = withClaudeDescriptor((descriptor, files) => {
      descriptor.legacyManagedFileHashes = { '.claude/tools/native.js': legacyHashes };
      descriptor.rootIntegrations = [
        {
          path: 'AGENTS.md',
          policy: 'managed-block',
          marker: 'agents',
          legacySignatures: { wholeFileHashes: legacyHashes },
        },
        {
          path: '.mcp.json',
          policy: 'json-map',
          jsonKey: 'mcpServers',
          optional: true,
          legacySignatures: { jsonEntryHashes: { context7: legacyHashes } },
        },
      ];
      files.push({
        name: 'runtime/claude/.mcp.json',
        body: JSON.stringify({ mcpServers: { context7: { command: 'native-tool' } } }),
      });
    });
    // These are historical migration signatures, not hashes of current files.
    expect(legacyHashes).not.toContain(`sha256:${digest('// never executed\n')}`);
    expect(
      (await inspectNativeRuntimeArchive(await archiveFor(entries), { version })).projections,
    ).toHaveLength(4);
  });

  it('accepts whole-file legacy signatures for the whole-file integration policy', async () => {
    const entries = withClaudeDescriptor((descriptor) => {
      descriptor.rootIntegrations[0].legacySignatures = { wholeFileHashes: legacyHashes };
    });
    expect(
      (await inspectNativeRuntimeArchive(await archiveFor(entries), { version })).projections,
    ).toHaveLength(4);
  });

  it.each([null, [], {}, 'invalid'])(
    'rejects invalid managed-file signature maps %j',
    async (value) => {
      const entries = withClaudeDescriptor((descriptor) => {
        descriptor.legacyManagedFileHashes = value;
      });
      await expect(
        inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
      ).rejects.toThrow(/legacy managed-file signatures/);
    },
  );

  it.each([
    '.claude/missing-file.js',
    'AGENTS.md',
    '.claude/tools',
    '../outside.js',
    '.claude/../AGENTS.md',
  ])('rejects a missing, unmanaged, non-file or unsafe legacy path %s', async (file) => {
    const entries = withClaudeDescriptor((descriptor) => {
      descriptor.legacyManagedFileHashes = { [file]: legacyHashes };
    });
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
    ).rejects.toThrow(/legacy managed file|unsafe path/);
  });

  it.each([
    [],
    legacyHashes[0],
    [legacyHashes[0], legacyHashes[0]],
    [`sha256:${'A'.repeat(64)}`],
    [`sha256:${'a'.repeat(63)}`],
    [digest('unprefixed')],
    [`${legacyHashes[0]}\n`],
    [null],
  ])('rejects malformed or duplicate historical hashes %j', async (hashes) => {
    const entries = withClaudeDescriptor((descriptor) => {
      descriptor.legacyManagedFileHashes = { '.claude/tools/native.js': hashes };
    });
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
    ).rejects.toThrow(/legacy signatures/);
  });

  it.each([null, [], {}, { unknown: legacyHashes }])(
    'rejects malformed integration legacy signatures %j',
    async (legacySignatures) => {
      const entries = withClaudeDescriptor((descriptor) => {
        descriptor.rootIntegrations[0].legacySignatures = legacySignatures;
      });
      await expect(
        inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
      ).rejects.toThrow(/legacy signatures/);
    },
  );

  it('rejects invalid hashes in whole-file integration signatures', async () => {
    const entries = withClaudeDescriptor((descriptor) => {
      descriptor.rootIntegrations[0].legacySignatures = { wholeFileHashes: ['not-a-hash'] };
    });
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
    ).rejects.toThrow(/legacy signatures/);
  });

  it.each(['json-map', 'json-array'])('rejects whole-file signatures on %s', async (policy) => {
    const entries = withClaudeDescriptor((descriptor) => {
      descriptor.rootIntegrations[0] = {
        path: 'AGENTS.md',
        policy,
        jsonKey: 'entries',
        legacySignatures: { wholeFileHashes: legacyHashes },
      };
    });
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
    ).rejects.toThrow(/cannot use legacy whole-file signatures/);
  });

  it.each(['whole-file', 'managed-block', 'json-array'])(
    'rejects JSON-entry signatures on %s',
    async (policy) => {
      const entries = withClaudeDescriptor((descriptor) => {
        descriptor.rootIntegrations[0] = {
          path: 'AGENTS.md',
          policy,
          marker: 'agents',
          jsonKey: 'entries',
          legacySignatures: { jsonEntryHashes: { context7: legacyHashes } },
        };
      });
      await expect(
        inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
      ).rejects.toThrow(/legacy JSON-entry signatures/);
    },
  );

  it.each([null, [], {}, { '': legacyHashes }, { context7: [] }, { context7: ['not-a-hash'] }])(
    'rejects invalid JSON-entry signature maps %j',
    async (jsonEntryHashes) => {
      const entries = withClaudeDescriptor((descriptor) => {
        descriptor.rootIntegrations[0] = {
          path: 'AGENTS.md',
          policy: 'json-map',
          jsonKey: 'mcpServers',
          legacySignatures: { jsonEntryHashes },
        };
      });
      await expect(
        inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
      ).rejects.toThrow(/legacy/);
    },
  );

  it('matches upstream by skipping migration metadata for an absent optional integration', async () => {
    const entries = withClaudeDescriptor((descriptor) => {
      descriptor.rootIntegrations.push({
        path: '.mcp.json',
        policy: 'json-map',
        jsonKey: 'mcpServers',
        optional: true,
        legacySignatures: null,
      });
    });
    expect(
      (await inspectNativeRuntimeArchive(await archiveFor(entries), { version })).projections,
    ).toHaveLength(4);
    entries.push({ name: 'runtime/claude/.mcp.json', body: '{"mcpServers":{}}' });
    await expect(
      inspectNativeRuntimeArchive(await archiveFor(entries), { version }),
    ).rejects.toThrow(/legacy signatures/);
  });
});

describe('native release directory verification', () => {
  it('rejects checksummed releases whose projections are hidden after tar termination', async () => {
    const runtime = await archiveFor(projectionEntries(), (bytes) =>
      Buffer.concat([Buffer.alloc(1024), bytes]),
    );
    const directory = await makeRelease({ runtime });
    await expect(verifyNativeReleaseDirectory({ directory, source })).rejects.toThrow(
      /non-padding data after tar termination/,
    );
  });

  it('rejects checksummed releases declaring nonexistent legacy managed files', async () => {
    const directory = await makeRelease({
      entries: withClaudeDescriptor((descriptor) => {
        descriptor.legacyManagedFileHashes = { '.claude/missing-file.js': legacyHashes };
      }),
    });
    await expect(verifyNativeReleaseDirectory({ directory, source })).rejects.toThrow(
      /legacy managed file/,
    );
  });

  it('produces a repeatable source-bound package identity without qualifying agent execution', async () => {
    const directory = await makeRelease();
    const first = await verifyNativeReleaseDirectory({ directory, source });
    expect(await verifyNativeReleaseDirectory({ directory, source })).toEqual(first);
    expect(first.packageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.verification).toEqual({
      integrity: 'verified',
      projectionLayout: 'verified',
      attestation: 'not-verified',
      harnessExecution: 'not-verified',
    });
    const other = await verifyNativeReleaseDirectory({
      directory,
      source: { ...source, repository: 'example/another-fork' },
    });
    expect(other.packageId).not.toBe(first.packageId);
    expect(first).not.toHaveProperty('directory');
  });

  it.each(['aidlc-linux-arm64', `aidlc-runtime-${version}.tar.gz`])(
    'rejects mutated %s bytes before archive processing',
    async (name) => {
      const directory = await makeRelease();
      await writeFile(join(directory, name), 'corrupt replacement');
      await expect(verifyNativeReleaseDirectory({ directory, source })).rejects.toThrow(
        /checksum and size/,
      );
    },
  );

  it('rejects a swapped source commit, floating selection and token-bearing repository URLs', async () => {
    const directory = await makeRelease();
    for (const change of [
      { commit: 'b'.repeat(40) },
      { release: 'latest' },
      { repository: 'https://sensitive-token@github.com/example/fork' },
      { repository: 'example/fork\n' },
      { commit: `${source.commit}\n` },
    ]) {
      await expect(
        verifyNativeReleaseDirectory({ directory, source: { ...source, ...change } }),
      ).rejects.toThrow();
    }
  });

  it('does not follow asset symlinks', async () => {
    const directory = await makeRelease();
    const asset = join(directory, 'aidlc-linux-arm64');
    await writeFile(join(directory, 'target'), await readFile(asset));
    await rm(asset);
    await symlink(join(directory, 'target'), asset);
    await expect(verifyNativeReleaseDirectory({ directory, source })).rejects.toThrow(
      /regular file/,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO without hanging the operator command',
    async () => {
      const directory = await makeRelease();
      const asset = join(directory, 'aidlc-linux-arm64');
      await rm(asset);
      await exec('mkfifo', [asset]);
      await expect(
        exec(
          process.execPath,
          [
            'scripts/verify-native-release.mjs',
            '--directory',
            directory,
            '--repository',
            source.repository,
            '--release',
            source.release,
            '--commit',
            source.commit,
          ],
          { timeout: 2000 },
        ),
      ).rejects.toMatchObject({
        code: 1,
        killed: false,
        stderr: expect.stringMatching(/regular file/),
      });
    },
  );

  it('exercises the operator CLI without executing or changing release files', async () => {
    const directory = await makeRelease();
    const before = await readFile(join(directory, 'aidlc-linux-arm64'));
    const { stdout, stderr } = await exec(process.execPath, [
      'scripts/verify-native-release.mjs',
      '--directory',
      directory,
      '--repository',
      source.repository,
      '--release',
      source.release,
      '--commit',
      source.commit,
    ]);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout).verification.harnessExecution).toBe('not-verified');
    expect(await readFile(join(directory, 'aidlc-linux-arm64'))).toEqual(before);
  });
});
