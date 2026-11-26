import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';

const harnessDirs = { claude: '.claude', codex: '.codex', kiro: '.kiro', opencode: '.aidlc' };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const projectionEntries = (version) =>
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
      {
        name: `${root}/${harnessDir}/tools/native.js`,
        body: '// Authored synthetic fixture; never executed.\n',
      },
      { name: `${root}/AGENTS.md`, body: '# Synthetic native projection fixture\n' },
    ];
  });

const runtimeArchive = async (version) => {
  const pack = tar.pack();
  const chunks = [];
  const consume = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  const entries = [
    ...projectionEntries(version),
    {
      name: 'plugins/example/codex/.codex/instructions.md',
      body: 'Authored synthetic plugin content for package preservation tests.\n',
    },
  ];
  for (const { name, body } of entries) {
    await new Promise((resolve, reject) =>
      pack.entry(
        // Identical fixture inputs should produce identical package digests.
        {
          name,
          type: 'file',
          mode: 0o644,
          uid: 0,
          gid: 0,
          mtime: new Date('2026-09-15T00:00:00Z'),
        },
        body,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  pack.finalize();
  await consume;
  return gzipSync(Buffer.concat(chunks));
};

/**
 * Author a prebuilt-release fixture for filesystem intake tests.
 *
 * The binary is inert synthetic bytes, never an executable to launch. Source
 * fields may override the defaults; the release tag defaults to v<version>.
 * The caller owns directory cleanup. Exactly four role files are written;
 * this fixture makes no attestation or harness-execution claim.
 */
export const createNativeReleaseFixture = async (
  directory,
  {
    version = '2.9.0',
    source: sourceOverrides,
    binary = 'synthetic executable bytes; never executed\n',
  } = {},
) => {
  const source = {
    provider: 'github',
    repository: 'example/private-workflows',
    release: `v${version}`,
    commit: 'a'.repeat(40),
    ...sourceOverrides,
  };
  const binaryName = 'aidlc-linux-arm64';
  const runtimeName = `aidlc-runtime-${version}.tar.gz`;
  const binaryBytes = Buffer.from(binary);
  const runtime = await runtimeArchive(version);
  const assets = [
    {
      name: binaryName,
      kind: 'binary',
      target: 'linux-arm64',
      sha256: digest(binaryBytes),
      bytes: binaryBytes.length,
    },
    {
      name: runtimeName,
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
  const files = [
    ['version.json', manifest],
    ['checksums.txt', checksums],
    [binaryName, binaryBytes],
    [runtimeName, runtime],
  ];
  await mkdir(directory, { recursive: true });
  await Promise.all(files.map(([name, bytes]) => writeFile(join(directory, name), bytes)));
  return { directory, source, binaryName, runtimeName, fileNames: files.map(([name]) => name) };
};
