import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  NativeReleaseValidationError,
  verifyNativeReleaseManifest,
} from '../native-release-manifest.js';

const COMMIT = 'c8262851e50252865bb8882b43769a3348c9ec49';
const VERSION = '2.5.0';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const asset = (name, kind, target) => ({
  name,
  sha256: sha256(`authored fixture: ${name}`),
  bytes: Buffer.byteLength(`authored fixture: ${name}`),
  kind,
  ...(target ? { target } : {}),
});

// Authored metadata in the shape emitted by upstream scripts/package-release.ts
// and tests/harness/release-fixture.ts. No upstream fixture code is executed,
// and these synthetic digests do not establish artifact or harness validity.
const manifestFixture = (version = VERSION) => ({
  schemaVersion: 1,
  version,
  date: '2026-09-18',
  sourceRef: version.includes('-preview.') ? 'refs/heads/main' : `refs/tags/v${version}`,
  sourceDigest: COMMIT,
  distributions: [
    { name: 'claude', productName: 'Claude Code' },
    { name: 'kiro', productName: 'Kiro CLI' },
    { name: 'opencode', productName: 'OpenCode' },
    { name: 'codex', productName: 'Codex' },
  ],
  assets: [
    asset('aidlc-linux-arm64', 'binary', 'linux-arm64'),
    {
      ...asset('aidlc-windows-x64.exe', 'binary', 'windows-x64'),
      verification: { status: 'UNVERIFIED', mode: 'inspection-only', hostTarget: 'linux-arm64' },
    },
    asset(`aidlc-runtime-${version}.tar.gz`, 'runtime'),
    asset('install.sh', 'installer'),
    asset('install.ps1', 'installer'),
  ],
});

const encode = (manifest = manifestFixture(), text = `${JSON.stringify(manifest, null, 2)}\n`) => {
  const versionJson = Buffer.from(text);
  return {
    versionJson,
    checksums: Buffer.from(
      [
        `${sha256(versionJson)}  version.json`,
        ...manifest.assets.map((entry) => `${entry.sha256}  ${entry.name}`),
        '',
      ].join('\n'),
    ),
    expectedCommit: COMMIT,
    expectedRelease: `v${manifest.version}`,
  };
};

const reject = (input) => {
  expect(() => verifyNativeReleaseManifest(input)).toThrow(NativeReleaseValidationError);
  expect(() => verifyNativeReleaseManifest(input)).toThrow(
    expect.objectContaining({ code: 'native_release_invalid' }),
  );
};

describe('verifyNativeReleaseManifest', () => {
  it('selects native linux-arm64 assets and returns only frozen sanitized metadata', () => {
    const manifest = manifestFixture();
    manifest.publisherUrl = 'https://untrusted.invalid/private';
    manifest.assets[0].untrustedInstruction = 'execute an installer';
    const input = encode(manifest);
    const result = verifyNativeReleaseManifest(input);
    expect(result).toEqual({
      version: VERSION,
      sourceRef: `refs/tags/v${VERSION}`,
      sourceDigest: COMMIT,
      harnesses: ['claude', 'codex', 'kiro', 'opencode'],
      assets: {
        binary: {
          name: 'aidlc-linux-arm64',
          sha256: manifest.assets[0].sha256,
          bytes: manifest.assets[0].bytes,
        },
        runtime: {
          name: `aidlc-runtime-${VERSION}.tar.gz`,
          sha256: manifest.assets[2].sha256,
          bytes: manifest.assets[2].bytes,
        },
      },
      manifestSha256: sha256(input.versionJson),
      checksumsSha256: sha256(input.checksums),
    });
    for (const value of [
      result,
      result.harnesses,
      result.assets,
      ...Object.values(result.assets),
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => result.harnesses.push('other')).toThrow(TypeError);
    expect(() => {
      result.assets.binary.name = 'other';
    }).toThrow(TypeError);
  });

  it.each(['0.0.0', '12.30.400', '2.5.1-preview.20260918.1', '2.5.1-preview.20260918.12'])(
    'accepts the native stable/preview grammar: %s',
    (version) => {
      const result = verifyNativeReleaseManifest(encode(manifestFixture(version)));
      expect(result.version).toBe(version);
      expect(result.sourceRef).toBe(
        version.includes('-preview.') ? 'refs/heads/main' : `refs/tags/v${version}`,
      );
    },
  );

  it('accepts compatible fork metadata without assuming an upstream repository or commit', () => {
    const manifest = manifestFixture();
    manifest.sourceDigest = 'a'.repeat(40);
    const result = verifyNativeReleaseManifest({
      ...encode(manifest),
      expectedCommit: manifest.sourceDigest,
    });
    expect(result.sourceDigest).toBe(manifest.sourceDigest);
  });

  it('accepts string metadata and CRLF checksums while hashing the original bytes', () => {
    const input = encode();
    input.versionJson = input.versionJson.toString();
    input.checksums = input.checksums.toString().replaceAll('\n', '\r\n');
    const result = verifyNativeReleaseManifest(input);
    expect(result.manifestSha256).toBe(sha256(input.versionJson));
    expect(result.checksumsSha256).toBe(sha256(input.checksums));
  });

  it('supports an explicitly selected packaged target without returning verification claims', () => {
    const result = verifyNativeReleaseManifest({ ...encode(), target: 'windows-x64' });
    expect(result.assets.binary.name).toBe('aidlc-windows-x64.exe');
    expect(result.assets.binary).not.toHaveProperty('verification');
  });

  it('retains additional valid distributions while requiring all four platform harnesses', () => {
    const manifest = manifestFixture();
    manifest.distributions.push({ name: 'another-harness', productName: 'Another harness' });
    expect(verifyNativeReleaseManifest(encode(manifest)).harnesses).toContain('another-harness');
  });

  it.each([
    undefined,
    '',
    'latest',
    'main',
    COMMIT.slice(0, 7),
    COMMIT.toUpperCase(),
    `${COMMIT}\n`,
    `${COMMIT}\r`,
    'g'.repeat(40),
    'a'.repeat(64),
    123,
  ])('rejects an unpinned/invalid source commit: %s', (expectedCommit) => {
    reject({ ...encode(), expectedCommit });
  });

  it.each([
    undefined,
    '',
    'latest',
    'main',
    VERSION,
    `refs/tags/v${VERSION}`,
    'v2.4.0',
    'fork-2.5.0',
  ])('rejects an unknown or mismatched release tag protocol: %s', (expectedRelease) =>
    reject({ ...encode(), expectedRelease }),
  );

  it.each([
    '2.5',
    'v2.5.0',
    '02.5.0',
    '2.05.0',
    '2.5.00',
    '2.5.0-beta.1',
    '2.5.0+build.1',
    '2.5.1-preview.20260918.0',
    '2.5.1-preview.20260918.01',
    '2.5.1-preview.2026091.1',
    '2.5.1-preview.2026-09-18.1',
    '2.5.0\n',
    250,
    null,
  ])('rejects unsupported version grammar: %s', (version) => {
    const manifest = manifestFixture();
    manifest.version = version;
    reject(encode(manifest));
  });

  it.each([
    ['schemaVersion', 2],
    ['schemaVersion', '1'],
    ['sourceRef', undefined],
    ['sourceRef', 'refs/heads/main'],
    ['sourceRef', 'refs/tags/v2.4.0'],
    ['sourceRef', 'refs/tags/v2.5.0\n'],
    ['sourceDigest', undefined],
    ['sourceDigest', 'b'.repeat(40)],
    ['sourceDigest', COMMIT.toUpperCase()],
    ['sourceDigest', `${COMMIT}\n`],
    ['sourceDigest', COMMIT.slice(0, 7)],
  ])('rejects invalid or mismatched source/schema: %s=%s', (field, value) => {
    const manifest = manifestFixture();
    manifest[field] = value;
    reject(encode(manifest));
  });

  it('rejects preview source refs that silently use a stable-tag or another-branch protocol', () => {
    for (const sourceRef of ['refs/tags/v2.5.1-preview.20260918.1', 'refs/heads/develop']) {
      const manifest = manifestFixture('2.5.1-preview.20260918.1');
      manifest.sourceRef = sourceRef;
      reject(encode(manifest));
    }
  });

  it.each([null, [], 'text', 1, true])('rejects invalid validator input: %s', (input) =>
    reject(input),
  );

  it.each(['versionJson', 'checksums'])('rejects missing, non-buffer or empty %s', (field) => {
    for (const value of [undefined, null, {}, [], 1, Buffer.alloc(0), '']) {
      reject({ ...encode(), [field]: value });
    }
  });

  it.each(['versionJson', 'checksums'])('rejects oversized %s before parsing', (field) => {
    reject({ ...encode(), [field]: Buffer.alloc(1024 * 1024 + 1, 32) });
    reject({ ...encode(), [field]: 'é'.repeat(512 * 1024 + 1) });
  });

  it('accepts metadata exactly at the 1 MiB boundary', () => {
    const manifest = manifestFixture();
    const text = JSON.stringify(manifest).padEnd(1024 * 1024, ' ');
    const input = encode(manifest, text);
    input.checksums = Buffer.from(input.checksums.toString().padEnd(1024 * 1024, '\n'));
    expect(verifyNativeReleaseManifest(input).version).toBe(VERSION);
  });

  it.each(['versionJson', 'checksums'])('rejects malformed UTF-8 in %s', (field) => {
    reject({ ...encode(), [field]: Buffer.from([0xc3, 0x28]) });
  });

  it.each(['null', '[]', '"metadata"', '1', '{"schemaVersion":', '\ufeff{}'])(
    'rejects malformed/non-object manifest JSON: %s',
    (text) => reject(encode(manifestFixture(), text)),
  );

  it('verifies exact manifest bytes, not reserialized or trimmed JSON', () => {
    const input = encode();
    input.versionJson = Buffer.concat([input.versionJson, Buffer.from('\n')]);
    reject(input);
    const manifest = manifestFixture();
    expect(verifyNativeReleaseManifest(encode(manifest, JSON.stringify(manifest))).version).toBe(
      VERSION,
    );
  });

  it.each([
    '',
    `${'a'.repeat(64)} version.json`,
    `${'a'.repeat(64)} *version.json`,
    `${'A'.repeat(64)}  version.json`,
    `${'a'.repeat(64)}  ../version.json`,
    `${'a'.repeat(64)}  version.json `,
    ` ${'a'.repeat(64)}  version.json`,
    `${'a'.repeat(64)}  version.json\0`,
    `${'a'.repeat(64)}  version.json`,
  ])('rejects malformed or mismatched checksums: %s', (checksums) => {
    reject({ ...encode(), checksums });
  });

  it('requires a checksum for version.json and rejects duplicate checksum rows', () => {
    const input = encode();
    const rows = input.checksums.toString().trimEnd().split('\n');
    reject({ ...input, checksums: rows.slice(1).join('\n') });
    reject({ ...input, checksums: [...rows, rows[0]].join('\n') });
    reject({ ...input, checksums: [...rows, rows[1]].join('\n') });
  });

  it('checks every manifest asset even when it is not selected', () => {
    const input = encode();
    const rows = input.checksums.toString().trimEnd().split('\n');
    reject({ ...input, checksums: rows.filter((row) => !row.endsWith('install.ps1')).join('\n') });
    reject({
      ...input,
      checksums: rows
        .map((row) => (row.endsWith('install.ps1') ? `${'f'.repeat(64)}  install.ps1` : row))
        .join('\n'),
    });
    reject({ ...input, checksums: `${input.checksums}${'a'.repeat(64)}  unknown-file\n` });
  });

  it.each(['claude', 'kiro', 'opencode', 'codex'])('requires the %s distribution', (name) => {
    const manifest = manifestFixture();
    manifest.distributions = manifest.distributions.filter((entry) => entry.name !== name);
    reject(encode(manifest));
  });

  it('rejects missing, duplicate and unsafe distributions', () => {
    for (const distributions of [
      undefined,
      null,
      {},
      [],
      [null],
      [...manifestFixture().distributions, { name: 'claude', productName: 'Duplicate' }],
      [...manifestFixture().distributions, { name: '../escape', productName: 'Invalid' }],
      [...manifestFixture().distributions, { name: 'other', productName: ' \n' }],
      [...manifestFixture().distributions, { name: 'other', productName: {} }],
    ]) {
      const manifest = manifestFixture();
      manifest.distributions = distributions;
      reject(encode(manifest));
    }
  });

  it('rejects missing, empty and non-array asset inventories', () => {
    for (const assets of [undefined, null, {}, []]) {
      const manifest = manifestFixture();
      const input = encode(manifest, JSON.stringify({ ...manifest, assets }));
      reject(input);
    }
  });

  it('rejects duplicate manifest assets even with a unique checksum list', () => {
    const manifest = manifestFixture();
    manifest.assets.push({ ...manifest.assets[0] });
    const input = encode(manifest);
    input.checksums = [...new Set(input.checksums.toString().split('\n'))].join('\n');
    reject(input);
  });

  it.each([
    ['name', '../aidlc-linux-arm64'],
    ['name', 'dir/aidlc-linux-arm64'],
    ['name', 'dir\\aidlc-linux-arm64'],
    ['name', '/aidlc-linux-arm64'],
    ['name', 'aidlc-linux-arm64\n'],
    ['name', 'aidlc-linux-arm64\0'],
    ['name', '-aidlc-linux-arm64'],
    ['name', 'a'.repeat(256)],
    ['sha256', 'A'.repeat(64)],
    ['sha256', 'a'.repeat(63)],
    ['sha256', null],
    ['bytes', -1],
    ['bytes', 1.5],
    ['bytes', '10'],
    ['bytes', null],
    ['bytes', 1024 * 1024 * 1024 + 1],
    ['bytes', Number.MAX_SAFE_INTEGER + 1],
    ['kind', 'unknown-protocol'],
    ['kind', 'runtime'],
    ['target', 'linux-x64'],
    ['target', 'linux-future'],
    ['target', null],
    ['verification', null],
    ['verification', { status: 'VERIFIED', mode: 'unknown', hostTarget: 'linux-arm64' }],
  ])('rejects invalid asset metadata: %s=%s', (field, value) => {
    const manifest = manifestFixture();
    manifest.assets[0][field] = value;
    reject(encode(manifest));
  });

  it('rejects a null asset with a safe typed error', () => {
    const manifest = manifestFixture();
    reject(encode(manifest, JSON.stringify({ ...manifest, assets: [null] })));
  });

  it('preserves upstream nonnegative bounded byte-count grammar without claiming payload validity', () => {
    const manifest = manifestFixture();
    manifest.assets[0].bytes = 0;
    manifest.assets[2].bytes = 1024 * 1024 * 1024;
    expect(verifyNativeReleaseManifest(encode(manifest)).assets.binary.bytes).toBe(0);
  });

  it.each(['linux-arm64', 'runtime'])('requires the selected native %s asset', (selection) => {
    const manifest = manifestFixture();
    manifest.assets = manifest.assets.filter((entry) =>
      selection === 'runtime' ? entry.kind !== 'runtime' : entry.target !== selection,
    );
    reject(encode(manifest));
  });

  it.each([
    { name: `aidlc-copy-runtime-${VERSION}.tar.gz` },
    { name: 'aidlc-runtime-2.4.0.tar.gz' },
    { kind: 'installer' },
    { target: 'linux-arm64' },
    { verification: { status: 'VERIFIED', mode: 'full-runtime', hostTarget: 'linux-arm64' } },
  ])('rejects copy-channel or malformed native runtime metadata: %s', (change) => {
    const manifest = manifestFixture();
    Object.assign(manifest.assets[2], change);
    reject(encode(manifest));
  });

  it('rejects undeclared copy-channel checksums instead of selecting them as a fallback', () => {
    const input = encode();
    input.checksums = `${input.checksums}${'a'.repeat(64)}  aidlc-copy-runtime-${VERSION}.tar.gz\n`;
    reject(input);
  });

  it.each([null, '', 'native', 'linux-future', '../linux-arm64', 'LINUX-ARM64'])(
    'rejects unsupported or unsafe selected targets: %s',
    (target) => reject({ ...encode(), target }),
  );

  it('does not echo metadata or JSON parser diagnostics in errors', () => {
    const secret = 'private-token-do-not-log';
    for (const input of [
      encode(manifestFixture(), `{"schemaVersion":1,"secret":"${secret}`),
      { ...encode(), checksums: `${secret}  version.json` },
      { ...encode(), expectedRelease: secret },
    ]) {
      try {
        verifyNativeReleaseManifest(input);
        expect.unreachable('invalid input was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(NativeReleaseValidationError);
        expect(error.code).toBe('native_release_invalid');
        expect(error.message).not.toContain(secret);
        expect(error).not.toHaveProperty('cause');
      }
    }
  });
});
