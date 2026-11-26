import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeNativePackagePin, nativePackageIdentityOf } from '../native-package-pin.js';
import { NATIVE_PACKAGE_LIMITS, NativePackageError } from '../native-runtime-package.js';
import { canonicalJson } from '../workflow-checkpoint.js';

const PACKAGE_ID = 'sha256:5e9b57d096ffe74b040151415a94d916ee178bec727e3f6f63b4a85c62c5971a';
const ABSENT_ID = 'sha256:aa1b6b432d98934f88ad4693a1a64e2fd6a2d17349c342115dca9697ca41d201';
const PROOF_ID = 'sha256:c6761a010ec75824b7b6c78f941e45495b2d707186702d5d0b8bdd52562eab23';
const ATTESTATION_NAME = 'aidlc-release.intoto.jsonl';
// Authored metadata only: these hashes are not claims about real package bytes.
const identity = () => ({
  schemaVersion: 1,
  source: {
    provider: 'github',
    repository: 'example/private-workflows',
    release: 'v2.9.0',
    commit: 'f'.repeat(40),
  },
  target: 'linux-arm64',
  version: '2.9.0',
  manifestSha256: 'a'.repeat(64),
  checksumsSha256: 'b'.repeat(64),
  assets: {
    binary: { name: 'aidlc-linux-arm64', sha256: 'c'.repeat(64), bytes: 17 },
    runtime: { name: 'aidlc-runtime-2.9.0.tar.gz', sha256: 'd'.repeat(64), bytes: 55 },
  },
  harnesses: ['claude', 'codex', 'kiro', 'opencode'],
});
const pin = () => ({ ...identity(), packageId: PACKAGE_ID });
const proof = () => ({ sha256: 'e'.repeat(64), bytes: 23 });
const rehash = (value) => ({
  ...value,
  packageId: `sha256:${createHash('sha256')
    .update(canonicalJson(nativePackageIdentityOf(value)))
    .digest('hex')}`,
});

describe('shared native package pin description', () => {
  it('preserves the existing schema-1 package and sidecar materialization golden IDs', () => {
    const description = describeNativePackagePin(pin(), proof());
    expect(description).toEqual({
      identity: identity(),
      packageId: PACKAGE_ID,
      attestation: { name: ATTESTATION_NAME, ...proof() },
      materializationId: PROOF_ID,
      files: [
        {
          name: 'version.json',
          sha256: 'a'.repeat(64),
          limit: NATIVE_PACKAGE_LIMITS.metadataBytes,
        },
        {
          name: 'checksums.txt',
          sha256: 'b'.repeat(64),
          limit: NATIVE_PACKAGE_LIMITS.metadataBytes,
        },
        { ...identity().assets.binary, limit: NATIVE_PACKAGE_LIMITS.assetBytes },
        { ...identity().assets.runtime, limit: NATIVE_PACKAGE_LIMITS.compressedBytes },
        { name: ATTESTATION_NAME, ...proof(), limit: NATIVE_PACKAGE_LIMITS.metadataBytes },
      ],
    });
    for (const file of description.files.slice(0, 2)) {
      expect(file).not.toHaveProperty('bytes');
    }
    expect(describeNativePackagePin(pin(), { name: ATTESTATION_NAME, ...proof() })).toEqual(
      description,
    );
  });

  it('preserves explicit absence as a distinct four-file materialization of the same package', () => {
    const absent = describeNativePackagePin(pin(), null);
    expect(absent).toMatchObject({
      packageId: PACKAGE_ID,
      attestation: null,
      materializationId: ABSENT_ID,
    });
    expect(absent.files.map(({ name }) => name)).toEqual([
      'version.json',
      'checksums.txt',
      'aidlc-linux-arm64',
      'aidlc-runtime-2.9.0.tar.gz',
    ]);
    expect(describeNativePackagePin(pin(), proof()).materializationId).not.toBe(ABSENT_ID);
  });

  it('changes materialization identity when sidecar bytes change without changing package identity', () => {
    const first = describeNativePackagePin(pin(), proof());
    const second = describeNativePackagePin(pin(), { ...proof(), sha256: '0'.repeat(64) });
    expect(second.packageId).toBe(first.packageId);
    expect(second.materializationId).not.toBe(first.materializationId);
  });

  it('ignores verification, inventory and unrelated claims in the identity projection', () => {
    const input = {
      ...pin(),
      verification: { harnessExecution: 'verified', attestation: 'verified' },
      inventory: { projections: [] },
      token: 'not an authority token',
      files: [{ name: '../private', limit: Infinity }],
    };
    expect(nativePackageIdentityOf(input)).toEqual(identity());
    expect(describeNativePackagePin(input, { ...proof(), token: 'private' })).toEqual(
      describeNativePackagePin(pin(), proof()),
    );
  });

  it('synchronously snapshots the pin and proof and returns detached file descriptions', () => {
    const input = pin();
    const attestation = proof();
    const result = describeNativePackagePin(input, attestation);
    input.packageId = `sha256:${'0'.repeat(64)}`;
    input.source.commit = '0'.repeat(40);
    input.assets.binary.name = '../unsafe';
    input.harnesses.reverse();
    attestation.bytes += 1;
    attestation.sha256 = '0'.repeat(64);
    expect(result).toEqual(describeNativePackagePin(pin(), proof()));

    result.files[2].bytes = 999;
    result.files[4].sha256 = '0'.repeat(64);
    expect(result.identity.assets.binary.bytes).toBe(17);
    expect(result.attestation.sha256).toBe('e'.repeat(64));
  });

  it.each([
    ['github', 'example/fork'],
    ['gitlab', 'group/subgroup/fork'],
    ['bitbucket', 'workspace/fork'],
  ])(
    'accepts canonical %s sources without assuming the official repository',
    (provider, repository) => {
      const value = pin();
      value.source = { ...value.source, provider, repository };
      const described = describeNativePackagePin(rehash(value), null);
      expect(described.identity.source).toEqual(value.source);
      expect(described.packageId).not.toBe(PACKAGE_ID);
    },
  );

  it.each(['0.0.0', '2.10.0', '2.10.0-preview.20260918.1'])(
    'accepts native release version %s with its exact tag and filename',
    (version) => {
      const value = pin();
      value.version = version;
      value.source.release = `v${version}`;
      value.assets.runtime.name = `aidlc-runtime-${version}.tar.gz`;
      const described = describeNativePackagePin(rehash(value), null);
      expect(described.identity.version).toBe(version);
      expect(described.files[3].name).toBe(`aidlc-runtime-${version}.tar.gz`);
    },
  );

  it.each([
    ['schema', (value) => (value.schemaVersion = 2)],
    ['target', (value) => (value.target = 'linux-x64')],
    ['unsafe version', (value) => (value.version = '../private')],
    ['unrecognized version', (value) => (value.version = '2.9.0-rc.1')],
    ['noncanonical version', (value) => (value.version = '02.9.0')],
    ['version newline', (value) => (value.version = '2.9.0\n')],
    ['overlong version filename', (value) => (value.version = `${'9'.repeat(250)}.0.0`)],
    ['missing source', (value) => (value.source = null)],
    ['unknown provider', (value) => (value.source.provider = 'custom')],
    ['repository URL', (value) => (value.source.repository = 'https://secret@github.com/a/b')],
    ['repository traversal', (value) => (value.source.repository = 'owner/../repo')],
    ['repository slash', (value) => (value.source.repository = 'owner/repo/')],
    ['repository newline', (value) => (value.source.repository = 'owner/repo\n')],
    ['overlong repository', (value) => (value.source.repository = `owner/${'r'.repeat(512)}`)],
    ['noncanonical repository', (value) => (value.source.repository = 'Owner/Repo')],
    ['short commit', (value) => (value.source.commit = 'a'.repeat(39))],
    ['noncanonical commit', (value) => (value.source.commit = 'A'.repeat(40))],
    ['floating release', (value) => (value.source.release = 'latest')],
    ['different tag', (value) => (value.source.release = 'v2.8.0')],
    ['source credentials', (value) => (value.source.token = 'private-token')],
    ['manifest digest', (value) => (value.manifestSha256 = 'A'.repeat(64))],
    ['checksums digest', (value) => (value.checksumsSha256 = 'a'.repeat(63))],
    ['missing assets', (value) => (value.assets = null)],
    ['extra asset role', (value) => (value.assets.other = { name: 'unknown' })],
    ['unsafe binary path', (value) => (value.assets.binary.name = '../aidlc-linux-arm64')],
    ['unsafe runtime path', (value) => (value.assets.runtime.name = '/absolute.tar.gz')],
    [
      'wrong runtime version',
      (value) => (value.assets.runtime.name = 'aidlc-runtime-2.8.0.tar.gz'),
    ],
    ['extra asset fields', (value) => (value.assets.binary.limit = Infinity)],
    ['asset digest newline', (value) => (value.assets.binary.sha256 = `${'a'.repeat(64)}\n`)],
    ['missing harness', (value) => value.harnesses.pop()],
    ['duplicate harness', (value) => (value.harnesses[3] = 'kiro')],
    ['wrong harness order', (value) => value.harnesses.reverse()],
  ])('rejects a self-consistently hashed pin with %s', (_name, change) => {
    const value = pin();
    change(value);
    expect(() => describeNativePackagePin(rehash(value), null)).toThrow(NativePackageError);
  });

  it.each(['binary', 'runtime'])('enforces known sizes and limits for %s', (role) => {
    const limit =
      role === 'binary' ? NATIVE_PACKAGE_LIMITS.assetBytes : NATIVE_PACKAGE_LIMITS.compressedBytes;
    for (const bytes of [undefined, null, '17', 0, -1, 1.5, Infinity, limit + 1]) {
      const value = pin();
      value.assets[role].bytes = bytes;
      expect(() => describeNativePackagePin(rehash(value), null)).toThrow(NativePackageError);
    }
    const value = pin();
    value.assets[role].bytes = limit;
    expect(describeNativePackagePin(rehash(value), null).identity.assets[role].bytes).toBe(limit);
  });

  it.each([
    undefined,
    null,
    {},
    { ...pin(), packageId: undefined },
    { ...pin(), packageId: 'sha256:not-a-hash' },
    { ...pin(), packageId: `sha256:${'0'.repeat(64)}` },
    { ...pin(), manifestSha256: '0'.repeat(64) },
    { ...pin(), assets: { ...pin().assets, binary: () => 'not data' } },
  ])('rejects incomplete or inconsistent input %# with a sanitized error', (value) => {
    expect(() => describeNativePackagePin(value, null)).toThrow(NativePackageError);
  });

  it('rejects cyclic malformed identity without leaking a serializer or stack error', () => {
    const value = pin();
    value.harnesses[0] = value.harnesses;
    expect(() => describeNativePackagePin(value, null)).toThrow(NativePackageError);
  });

  it('rejects sparse harness arrays even when their incomplete identity hash is supplied', () => {
    const value = pin();
    delete value.harnesses[0];
    expect(() => describeNativePackagePin(rehash(value), null)).toThrow(NativePackageError);
  });

  it.each([
    undefined,
    {},
    { ...proof(), name: 'other-proof.jsonl' },
    { ...proof(), name: '../aidlc-release.intoto.jsonl' },
    { ...proof(), sha256: 'A'.repeat(64) },
    { ...proof(), sha256: `${'a'.repeat(64)}\n` },
    { ...proof(), bytes: '23' },
    { ...proof(), bytes: 0 },
    { ...proof(), bytes: -1 },
    { ...proof(), bytes: 1.5 },
    { ...proof(), bytes: NATIVE_PACKAGE_LIMITS.metadataBytes + 1 },
  ])(
    'rejects a missing or malformed sidecar pin %# instead of treating it as absent',
    (attestation) => {
      expect(() => describeNativePackagePin(pin(), attestation)).toThrow(
        'An attestation pin or explicit absence is required',
      );
    },
  );
});
