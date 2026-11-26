import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadNativePackage } from '../../agentcore/native/package-loader.js';
import { assessNativePackageTrust, NativePackageTrustError } from '../native-package-trust.js';
import { verifyNativeReleaseDirectory } from '../native-runtime-package.js';
import {
  prepareWorkflowSourceBinding,
  workflowSourceIdentity,
} from '../workflow-source-bindings.js';
import { canonicalJson } from '../workflow-checkpoint.js';
import { createNativeReleaseFixture } from './fixtures/native-release.js';

const REVISION = '11111111-1111-4111-8111-111111111111';
const NEXT_REVISION = '22222222-2222-4222-8222-222222222222';
const PROOF = 'aidlc-release.intoto.jsonl';
const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
let root;
let baseline;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'native-trust-'));
  const release = await createNativeReleaseFixture(join(root, 'release'));
  const proof = Buffer.from('Authored unsigned provenance fixture; never authenticated\n');
  await writeFile(join(release.directory, PROOF), proof);
  const pin = await verifyNativeReleaseDirectory({
    directory: release.directory,
    source: release.source,
  });
  baseline = await loadNativePackage({
    releaseDirectory: release.directory,
    cacheDirectory: join(root, 'cache'),
    pin,
    attestation: { sha256: createHash('sha256').update(proof).digest('hex'), bytes: proof.length },
  });
});

afterAll(async () => {
  const writable = async (directory) => {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name));
    }
  };
  if (root) {
    await writable(root);
    await rm(root, { recursive: true });
  }
});

const packageId = (value) =>
  `sha256:${digest(
    Object.fromEntries(
      [
        'schemaVersion',
        'source',
        'target',
        'version',
        'manifestSha256',
        'checksumsSha256',
        'assets',
        'harnesses',
      ].map((key) => [key, value[key]]),
    ),
  )}`;

const bindSignature = (input, status = 'absent') => {
  const { materialization } = input;
  materialization.materializationId = `sha256:${digest({
    schemaVersion: 1,
    packageId: materialization.package.packageId,
    attestation:
      materialization.attestation === null
        ? null
        : {
            name: PROOF,
            sha256: materialization.attestation.sha256,
            bytes: materialization.attestation.bytes,
          },
  })}`;
  // A synthetic trusted-verifier RESULT, not a cryptographic verification.
  input.signature = {
    status,
    packageId: materialization.package.packageId,
    materializationId: materialization.materializationId,
    attestationSha256: materialization.attestation?.sha256 ?? null,
  };
  return input;
};

const inputFor = (provider = 'github') => {
  const materialization = structuredClone(baseline);
  materialization.package.source.provider = provider;
  materialization.package.packageId = packageId(materialization.package);
  const binding = prepareWorkflowSourceBinding({
    projectId: 'project-one',
    provider,
    repository: materialization.package.source.repository,
    actorId: 'configuring-admin',
    revision: REVISION,
    verified: {
      purpose: 'workflow-source',
      authType: 'public',
      capabilities: { repositoryRead: true, repositoryWrite: false },
    },
  });
  return bindSignature({ binding, materialization });
};

const denied = (input, code = 'native_package_trust_invalid') => {
  let error;
  try {
    assessNativePackageTrust(input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(NativePackageTrustError);
  expect(error.code).toBe(code);
  expect(error.message).not.toContain(root);
  expect(error).not.toHaveProperty('cause');
  return error;
};

describe('owner-selected native package trust policy', () => {
  it.each(['github', 'gitlab', 'bitbucket'])(
    'allows explicitly absent signatures for a verified %s source',
    (provider) => {
      const input = inputFor(provider);
      const evidence = assessNativePackageTrust(input);
      expect(evidence).toEqual({
        schemaVersion: 1,
        policy: 'owner-selected-source-v1',
        projectId: 'project-one',
        sourceId: input.binding.sourceId,
        bindingRevision: REVISION,
        configuredBy: 'configuring-admin',
        packageId: input.materialization.package.packageId,
        materializationId: input.materialization.materializationId,
        signature: { status: 'absent' },
        allowed: true,
      });
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence.signature)).toBe(true);
      expect(input.materialization.package.verification.attestation).toBe('not-verified');
    },
  );

  it('accepts explicit absence with a null proof using the schema-1 materialization identity', () => {
    const input = inputFor();
    const withProof = input.materialization.materializationId;
    input.materialization.attestation = null;
    bindSignature(input);
    expect(input.materialization.materializationId).not.toBe(withProof);
    expect(assessNativePackageTrust(input).signature).toEqual({ status: 'absent' });
  });

  it('accepts verified results with bounded opaque signer evidence and deeply freezes it', () => {
    const input = bindSignature(inputFor(), 'verified');
    input.signature.signer = {
      subject: 'repository build identity',
      issuer: 'operator issuer',
      keyId: 'key-17',
    };
    const evidence = assessNativePackageTrust(input);
    expect(evidence.signature).toEqual({ status: 'verified', signer: input.signature.signer });
    expect(Object.isFrozen(evidence.signature.signer)).toBe(true);
    expect(() => {
      evidence.signature.signer.keyId = 'changed';
    }).toThrow(TypeError);
    input.signature.signer.keyId = 'changed';
    input.binding.updatedBy = 'changed';
    expect(evidence.signature.signer.keyId).toBe('key-17');
    expect(evidence.configuredBy).toBe('configuring-admin');
  });

  it('excludes credentials, paths, proof bodies, supplied authority and unrelated identity fields', () => {
    const input = bindSignature(inputFor(), 'verified');
    const secret = 'PRIVATE-CONTENT-MUST-NOT-LEAK';
    Object.assign(input.binding, { token: secret, credentialRef: secret, configuredBy: 'wrong' });
    Object.assign(input.materialization, {
      token: secret,
      projectId: 'wrong',
      bindingRevision: NEXT_REVISION,
    });
    Object.assign(input.materialization.package, { credentials: secret, trust: { allowed: true } });
    Object.assign(input.signature, {
      token: secret,
      certificate: secret,
      raw: secret,
      allowed: true,
      projectId: 'wrong',
      sourceId: 'wrong',
      bindingRevision: NEXT_REVISION,
      signer: { keyId: 'key-17', token: secret, certificate: secret },
    });
    const evidence = assessNativePackageTrust(input);
    expect(evidence.signature).toEqual({ status: 'verified', signer: { keyId: 'key-17' } });
    expect(evidence.projectId).toBe(input.binding.projectId);
    expect(evidence.bindingRevision).toBe(REVISION);
    for (const value of [secret, root, 'wrong', NEXT_REVISION]) {
      expect(JSON.stringify(evidence)).not.toContain(value);
    }
  });

  it('records the currently authorized tenant and revision, not previous assessment authority', () => {
    const input = inputFor();
    const first = assessNativePackageTrust(input);
    input.binding.projectId = 'project-two';
    input.binding.revision = NEXT_REVISION;
    input.binding.updatedBy = 'next-admin';
    const current = assessNativePackageTrust(input);
    expect(current).toMatchObject({
      projectId: 'project-two',
      bindingRevision: NEXT_REVISION,
      configuredBy: 'next-admin',
      packageId: first.packageId,
    });
    // Membership, role and freshness checks remain broker preconditions.
    expect(first.projectId).toBe('project-one');
    expect(first.bindingRevision).toBe(REVISION);
  });

  it.each([
    ['schemaVersion', 2],
    ['purpose', 'application'],
    ['status', 'deleted'],
    ['access', 'write'],
    ['updatedBy', undefined],
    ['updatedBy', ' '],
    ['updatedBy', 'admin\n'],
    ['updatedBy', 'a'.repeat(257)],
    ['projectId', undefined],
    ['projectId', 'tenant\u0000other'],
    ['revision', 'not-a-revision'],
    ['revision', `${REVISION}\n`],
    ['capabilities', { repositoryRead: true, repositoryWrite: true, contents: 'read' }],
  ])('rejects an invalid binding %s value %j', (key, value) => {
    const input = inputFor();
    input.binding[key] = value;
    denied(input);
  });

  it.each(['sourceId', 'repo', 'repository'])(
    'rejects a noncanonical or mismatched binding %s',
    (field) => {
      const input = inputFor();
      input.binding[field] = field === 'sourceId' ? 'c'.repeat(64) : 'other/workflows';
      denied(input, 'native_package_trust_mismatch');
    },
  );

  it('rejects another authorized source even when the package digests are valid', () => {
    const input = inputFor();
    const source = workflowSourceIdentity('github', 'other/workflows');
    Object.assign(input.binding, source, { repo: source.repository });
    denied(input, 'native_package_trust_mismatch');
  });

  it.each([
    ['integrity', undefined],
    ['integrity', 'unverified'],
    ['projectionLayout', undefined],
    ['projectionLayout', 'failed'],
  ])('requires verified %s rather than trusting package identifiers', (field, value) => {
    const input = inputFor();
    input.materialization.package.verification[field] = value;
    denied(input);
  });

  it.each([
    ['schemaVersion', 2],
    ['target', 'linux-x64'],
    ['version', '2.9.0\n'],
    ['manifestSha256', 'a'.repeat(64) + '\n'],
    ['checksumsSha256', undefined],
    ['harnesses', ['codex']],
    ['inventory', undefined],
  ])('rejects an incomplete or malformed verifier report %s', (field, value) => {
    const input = inputFor();
    input.materialization.package[field] = value;
    denied(input);
  });

  it('requires all four projection reports and strict projection digests', () => {
    const input = inputFor();
    input.materialization.package.inventory.projections[0].stampSha256 += '\n';
    denied(input);
    input.materialization.package.inventory.projections = [];
    denied(input);
  });

  it.each(['commit', 'release', 'binary', 'runtime', 'packageId', 'materializationId'])(
    'rejects a changed %s pin',
    (field) => {
      const input = inputFor();
      const materialization = input.materialization;
      if (field === 'commit') materialization.package.source.commit = 'c'.repeat(40);
      else if (field === 'release') materialization.package.source.release = 'v2.8.0';
      else if (['binary', 'runtime'].includes(field))
        materialization.package.assets[field].sha256 = 'c'.repeat(64);
      else if (field === 'packageId') materialization.package.packageId += '\n';
      else materialization.materializationId += '\n';
      denied(
        input,
        field === 'release' ? 'native_package_trust_invalid' : 'native_package_trust_mismatch',
      );
    },
  );

  it.each(['binary', 'runtime'])(
    'requires a bounded nonempty %s asset with the expected filename',
    (role) => {
      const input = inputFor();
      input.materialization.package.assets[role].bytes = 0;
      denied(input);
      input.materialization.package.assets[role].bytes = 1;
      input.materialization.package.assets[role].name = '../private';
      denied(input);
    },
  );

  it.each([undefined, {}, { sha256: 'a'.repeat(64), bytes: 0 }])(
    'does not infer a null proof from malformed metadata %j',
    (attestation) => {
      const input = inputFor();
      input.materialization.attestation = attestation;
      denied(input);
    },
  );

  it.each(['invalid', 'failed', 'unavailable', 'error', 'unknown', 'verified\n', undefined, null])(
    'fails closed on signature status %s',
    (status) => {
      const input = inputFor();
      input.signature.status = status;
      const error = denied(input, 'native_package_trust_denied');
      expect(error.message).toBe(
        'Native package signature verification did not permit this package',
      );
    },
  );

  it.each([undefined, null, new Error('private verifier URL/token')])(
    'does not classify a missing or failed verifier result as absent',
    (signature) => {
      const input = inputFor();
      input.signature = signature;
      const error = denied(input, 'native_package_trust_denied');
      expect(error.message).not.toContain('private verifier');
    },
  );

  it.each(['verified', 'absent'])(
    'binds a %s result to package, materialization and exact proof',
    (status) => {
      for (const field of ['packageId', 'materializationId', 'attestationSha256']) {
        const input = bindSignature(inputFor(), status);
        input.signature[field] =
          field === 'attestationSha256' ? 'c'.repeat(64) : `sha256:${'c'.repeat(64)}`;
        denied(input, 'native_package_trust_mismatch');
      }
    },
  );

  it('requires explicit null in verifier evidence when there is no proof', () => {
    const input = inputFor();
    input.materialization.attestation = null;
    bindSignature(input);
    delete input.signature.attestationSha256;
    denied(input, 'native_package_trust_mismatch');
  });

  it.each([
    { subject: '' },
    { issuer: 'private\nissuer' },
    { keyId: 'a'.repeat(513) },
    { token: 'secret' },
  ])('rejects malformed or unbounded signer evidence %j', (signer) => {
    const input = bindSignature(inputFor(), 'verified');
    input.signature.signer = signer;
    denied(input);
  });

  it.each([undefined, null, [], {}])('sanitizes malformed assessment input %j', (input) => {
    denied(input);
  });

  it('sanitizes unexpected inspection failures without copying their cause', () => {
    const input = inputFor();
    Object.defineProperty(input.signature, 'status', {
      get() {
        throw new Error('private-path/token/raw-provider-error');
      },
    });
    expect(denied(input).message).toBe('Native package trust inputs are invalid');
    expect(new NativePackageTrustError('private-verifier-detail').code).toBe(
      'native_package_trust_invalid',
    );
  });
});
