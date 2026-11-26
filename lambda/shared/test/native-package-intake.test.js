import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadNativePackage,
  NativePackageLoadError,
} from '../../agentcore/native/package-loader.js';
import { createNativePackageIntake } from '../native-package-intake.js';
import {
  createNativePackageArchive,
  NativePackageArchiveError,
} from '../native-package-archive.js';
import { discoverNativeRelease } from '../native-release-catalog.js';
import { WorkflowSourceError, workflowSourceIdentity } from '../workflow-source-bindings.js';
import { createNativeReleaseFixture } from './fixtures/native-release.js';
import { createNativePackageS3 } from './fixtures/native-package-s3.js';

const filesystem = vi.hoisted(() => ({ beforeRemove: undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rm: async (path, options) => {
      await filesystem.beforeRemove?.(path);
      return actual.rm(path, options);
    },
  };
});

const REVISION = '11111111-1111-4111-8111-111111111111';
const NEXT_REVISION = '22222222-2222-4222-8222-222222222222';
const PROOF = 'aidlc-release.intoto.jsonl';
const SECRET = 'private-test-credential';
const COMMIT = 'a'.repeat(40);
let root;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'native-intake-')));
});
afterEach(async () => {
  filesystem.beforeRemove = undefined;
  const writable = async (directory) => {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name));
    }
  };
  await writable(root);
  await rm(root, { recursive: true });
});

// HTTP fixtures exercise the real provider catalog, scoped transport, manifest
// verifier and filesystem materializer. Only project/credential authority is
// injected; these tests do not claim live IAM or provider qualification.
const setup = async ({
  provider = 'github',
  authType = `${provider}-oauth`,
  withProof = true,
  verifyBuildSignature,
  archive,
} = {}) => {
  const source = workflowSourceIdentity(provider, 'example/private-workflows');
  const release = await createNativeReleaseFixture(join(root, 'release'), { source });
  if (withProof)
    await writeFile(join(release.directory, PROOF), 'synthetic provenance; never authenticated\n');
  const names = [...release.fileNames, ...(withProof ? [PROOF] : [])];
  const files = new Map(
    await Promise.all(
      names.map(async (name) => [name, await readFile(join(release.directory, name))]),
    ),
  );
  const binding = {
    schemaVersion: 1,
    projectId: 'project-one',
    ...source,
    repo: source.repository,
    purpose: 'workflow-source',
    revision: REVISION,
    projectIdentity: 'project-vertex-original',
    delegatorMembershipIdentity: authType === 'public' ? undefined : 'membership-edge-original',
    status: 'active',
    access: 'read',
    updatedBy: 'owner',
    authType,
    capabilities: { repositoryRead: true, repositoryWrite: false, contents: 'read' },
    ...(authType === 'public'
      ? {}
      : {
          credentialRef: `${provider}-oauth:owner`,
          connectionUserId: 'owner',
          connectionCreatedAt: '2026-09-15T00:00:00.000Z',
          connectionIdentity: 'b'.repeat(64),
        }),
  };
  const projectPath =
    provider === 'gitlab'
      ? `/projects/${encodeURIComponent(source.repository)}`
      : provider === 'github'
        ? `/repos/${source.repository}`
        : `/repositories/${source.repository}`;
  const releaseRow = () => ({
    id: 10,
    tag_name: release.source.release,
    draft: false,
    prerelease: false,
    published_at: '2026-09-15T00:00:00.000Z',
    released_at: '2026-09-15T00:00:00.000Z',
    upcoming_release: false,
    assets: {
      links: names.map((name, i) => ({
        id: 101 + i,
        name,
        direct_asset_url: `https://gitlab.com/${source.repository}/-/releases/${release.source.release}/downloads/${name}`,
      })),
    },
  });
  let metadataRead = 0;
  let override;
  const json = (data) =>
    new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = vi.fn(async (url, options) => {
    if (override) {
      const response = await override(url, options);
      if (response) return response;
    }
    const parsed = new URL(url);
    const path = parsed.pathname.replace(provider === 'gitlab' ? /^\/api\/v4/ : /^\/2\.0/, '');
    if (path === `${projectPath}/releases`) {
      metadataRead += 1;
      return json([releaseRow()]);
    }
    if (path === `${projectPath}/releases/10/assets`) {
      return json(names.map((name, i) => ({ id: 101 + i, name, state: 'uploaded' })));
    }
    if (path === `${projectPath}/git/ref/tags/${release.source.release}`) {
      return json({
        ref: `refs/tags/${release.source.release}`,
        object: { type: 'commit', sha: COMMIT },
      });
    }
    if (path === `${projectPath}/repository/tags/${release.source.release}`) {
      return json({ name: release.source.release, commit: { id: COMMIT } });
    }
    if (path === `${projectPath}/downloads`) {
      metadataRead += 1;
      return json({ pagelen: 100, size: names.length, values: names.map((name) => ({ name })) });
    }
    if (path === `${projectPath}/refs/tags/${release.source.release}`) {
      return json({ name: release.source.release, target: { type: 'commit', hash: COMMIT } });
    }
    const name =
      provider === 'github' ? names[Number(path.split('/').at(-1)) - 101] : path.split('/').at(-1);
    if (files.has(name)) return new Response(files.get(name));
    throw new Error(`Unexpected request: ${url}`);
  });
  const getAuthorizedBinding = vi.fn(async ({ projectId, actorId }) => {
    if (actorId !== 'member')
      throw new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied');
    return { ...binding, projectId };
  });
  const resolveCredential = vi.fn(async ({ binding: resolvedBinding }) => ({
    purpose: 'workflow-source',
    token: resolvedBinding.authType === 'public' ? null : SECRET,
  }));
  const materialize = vi.fn(loadNativePackage);
  const discoverRelease = vi.fn(discoverNativeRelease);
  const createIntake = (overrides = {}) =>
    createNativePackageIntake({
      workflowSources: { getAuthorizedBinding },
      resolveCredential,
      materialize,
      discoverRelease,
      fetchImpl,
      cacheRoot: join(root, 'cache'),
      workRoot: join(root, 'work'),
      verifyBuildSignature,
      archive,
      ...overrides,
    });
  const intake = createIntake();
  const scope = {
    projectId: binding.projectId,
    actorId: 'member',
    sourceId: source.sourceId,
    expectedRevision: REVISION,
  };
  return {
    intake,
    createIntake,
    scope,
    binding,
    files,
    names,
    release,
    source,
    fetchImpl,
    materialize,
    getAuthorizedBinding,
    resolveCredential,
    discoverRelease,
    override: (fn) => {
      override = fn;
    },
    metadataReads: () => metadataRead,
    prepare: () => intake.prepare(scope),
  };
};

const expectNoStaging = async () => {
  const entries = await readdir(join(root, 'work')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  expect(entries).toEqual([]);
};

describe('native package intake', () => {
  it.each(['github', 'gitlab', 'bitbucket'])(
    'admits a %s publication without a sidecar under the owner-selected-source policy',
    async (provider) => {
      const verifier = vi.fn();
      const f = await setup({ provider, withProof: false, verifyBuildSignature: verifier });
      const resolution = await f.prepare();
      expect(resolution.attestation).toBeNull();
      const loaded = await f.intake.loadForExecution({ actorId: 'member', resolution });
      expect(loaded).toMatchObject({
        attestation: null,
        attestationPath: null,
        trust: {
          policy: 'owner-selected-source-v1',
          allowed: true,
          configuredBy: 'owner',
          projectId: f.scope.projectId,
          sourceId: f.source.sourceId,
          bindingRevision: REVISION,
          packageId: resolution.packagePin.packageId,
          materializationId: resolution.materializationId,
          signature: { status: 'absent' },
        },
      });
      expect(verifier).not.toHaveBeenCalled();
      expect(loaded.package.verification.harnessExecution).toBe('not-verified');
    },
  );

  it.each([true, false])(
    'detects sidecar %s -> opposite presence changes during intake',
    async (withProof) => {
      const f = await setup({ withProof });
      f.discoverRelease.mockImplementationOnce(discoverNativeRelease);
      f.discoverRelease.mockImplementationOnce(async (input) => {
        if (withProof) f.names.splice(f.names.indexOf(PROOF), 1);
        else f.names.push(PROOF);
        return discoverNativeRelease(input);
      });
      await expect(f.prepare()).rejects.toMatchObject({ code: 'native_release_changed' });
      expect(f.materialize).not.toHaveBeenCalled();
    },
  );

  it('allows byte inspection but denies execution of a present proof without a verifier', async () => {
    const f = await setup();
    const resolution = await f.prepare();
    expect(await f.intake.loadPinned({ actorId: 'member', resolution })).not.toHaveProperty(
      'trust',
    );
    await expect(
      f.intake.loadForExecution({ actorId: 'member', resolution }),
    ).rejects.toMatchObject({ code: 'native_package_trust_denied' });
  });

  it('binds trusted verification results to the exact loaded package and returns bounded evidence', async () => {
    const verifier = vi.fn(async ({ materialization }) => ({
      status: 'verified',
      packageId: materialization.package.packageId,
      materializationId: materialization.materializationId,
      attestationSha256: materialization.attestation.sha256,
      signer: { subject: 'synthetic-test-signer' },
      rawProof: 'do not expose',
    }));
    const f = await setup({ verifyBuildSignature: verifier });
    const resolution = await f.prepare();
    const loaded = await f.intake.loadForExecution({ actorId: 'member', resolution });
    expect(loaded.trust.signature).toEqual({
      status: 'verified',
      signer: { subject: 'synthetic-test-signer' },
    });
    expect(JSON.stringify(verifier.mock.calls)).not.toContain(SECRET);
    expect(f.getAuthorizedBinding).toHaveBeenCalledTimes(10);
    // This verifies the broker boundary, not cryptographic signature checking.
  });

  it.each(['invalid', 'failed', 'unavailable', 'unknown', 'throws', 'wrong-package'])(
    'never downgrades a %s verifier result into an unsigned package',
    async (status) => {
      const verifier = vi.fn(async ({ materialization }) => {
        if (status === 'throws') throw new Error(`${SECRET} https://signed.example/private`);
        return {
          status: status === 'wrong-package' ? 'verified' : status,
          packageId: `sha256:${'0'.repeat(64)}`,
          materializationId: materialization.materializationId,
          attestationSha256: materialization.attestation.sha256,
        };
      });
      const f = await setup({ verifyBuildSignature: verifier });
      const resolution = await f.prepare();
      await expect(
        f.intake.loadForExecution({
          actorId: 'member',
          resolution: { ...resolution, trust: { allowed: true, signature: { status: 'absent' } } },
        }),
      ).rejects.toMatchObject({
        code:
          status === 'wrong-package'
            ? 'native_package_trust_mismatch'
            : 'native_package_trust_denied',
      });
    },
  );

  it.each(['membership', 'configuration'])(
    'rechecks %s after signature verification before permitting execution',
    async (change) => {
      const verifier = vi.fn(async ({ materialization }) => {
        if (change === 'membership') {
          f.getAuthorizedBinding.mockRejectedValue(
            new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied'),
          );
        } else {
          f.binding.updatedBy = 'different-owner';
        }
        return {
          status: 'verified',
          packageId: materialization.package.packageId,
          materializationId: materialization.materializationId,
          attestationSha256: materialization.attestation.sha256,
        };
      });
      const f = await setup({ verifyBuildSignature: verifier });
      const resolution = await f.prepare();
      await expect(
        f.intake.loadForExecution({ actorId: 'member', resolution }),
      ).rejects.toMatchObject({
        code:
          change === 'membership' ? 'WORKFLOW_SOURCE_FORBIDDEN' : 'native_package_intake_invalid',
      });
    },
  );

  it.each(['github', 'gitlab', 'bitbucket'])(
    'resolves and materializes a %s release with the real catalog and transport',
    async (provider) => {
      const f = await setup({ provider });
      const resolution = await f.prepare();
      expect(resolution).toMatchObject({
        schemaVersion: 1,
        projectId: f.scope.projectId,
        sourceId: f.source.sourceId,
        bindingRevision: REVISION,
        requestedRelease: 'latest',
        packagePin: {
          source: { provider, repository: f.source.repository, release: 'v2.9.0', commit: COMMIT },
          verification: {
            integrity: 'verified',
            attestation: 'not-verified',
            harnessExecution: 'not-verified',
          },
        },
      });
      expect(f.metadataReads()).toBe(2);
      expect(f.getAuthorizedBinding).toHaveBeenCalledTimes(6);
      expect(f.resolveCredential).toHaveBeenCalledTimes(3);
      expect(f.fetchImpl.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
      const serialized = JSON.stringify(resolution);
      for (const privateValue of [
        SECRET,
        'credentialRef',
        'connectionIdentity',
        'locator',
        root,
        'https://',
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
      const loaded = await f.intake.loadPinned({ actorId: 'member', resolution });
      expect(loaded.cacheHit).toBe(true);
      expect(await readFile(loaded.runtimePath)).toEqual(f.files.get(f.release.runtimeName));
      await expectNoStaging();
    },
  );

  it.each(['github', 'gitlab', 'bitbucket'])(
    'keeps public %s requests anonymous',
    async (provider) => {
      const f = await setup({ provider, authType: 'public' });
      await f.prepare();
      expect(
        f.fetchImpl.mock.calls.every(
          ([, options]) => !Object.hasOwn(options.headers, 'Authorization'),
        ),
      ).toBe(true);
    },
  );

  it('does not read the provider or touch storage when project authorization fails', async () => {
    const f = await setup();
    await expect(f.intake.prepare({ ...f.scope, actorId: 'outsider' })).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    expect(f.resolveCredential).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.materialize).not.toHaveBeenCalled();
    await expect(lstat(join(root, 'work'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a changed tag commit before downloading binary/runtime assets', async () => {
    const f = await setup();
    f.override(
      (url) =>
        url.includes('/git/ref/tags/') &&
        new Response(
          JSON.stringify({
            ref: 'refs/tags/v2.9.0',
            object: { type: 'commit', sha: 'c'.repeat(40) },
          }),
        ),
    );
    await expect(f.prepare()).rejects.toMatchObject({ code: 'native_release_invalid' });
    expect(f.fetchImpl.mock.calls.some(([url]) => /\/releases\/assets\/10[34]$/.test(url))).toBe(
      false,
    );
    expect(f.materialize).not.toHaveBeenCalled();
    await expectNoStaging();
  });

  it('rejects corrupted binary bytes and never publishes a cache entry', async () => {
    const f = await setup();
    f.files.set(f.release.binaryName, Buffer.alloc(f.files.get(f.release.binaryName).length, 88));
    await expect(f.prepare()).rejects.toMatchObject({ code: 'native_release_changed' });
    expect(f.materialize).not.toHaveBeenCalled();
    await expectNoStaging();
  });

  it('detects metadata changing behind a stable download URL', async () => {
    const f = await setup({ provider: 'gitlab' });
    let versionReads = 0;
    f.override((url) => {
      if (!url.endsWith('/version.json')) return;
      versionReads += 1;
      if (versionReads > 1)
        return new Response(Buffer.concat([f.files.get('version.json'), Buffer.from('\n')]));
    });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'native_release_changed' });
    expect(f.materialize).not.toHaveBeenCalled();
    await expectNoStaging();
  });

  it('detects a changed latest selection before publishing', async () => {
    const f = await setup();
    f.discoverRelease.mockImplementationOnce(discoverNativeRelease);
    f.discoverRelease.mockImplementationOnce(async (input) => {
      const catalog = await discoverNativeRelease(input);
      return { ...catalog, source: { ...catalog.source, commit: 'c'.repeat(40) } };
    });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'native_release_changed' });
    expect(f.materialize).not.toHaveBeenCalled();
    await expectNoStaging();
  });

  it.each(['membership', 'revision', 'connection'])(
    'rechecks %s before cache publication',
    async (change) => {
      const f = await setup();
      f.getAuthorizedBinding.mockResolvedValueOnce(f.binding);
      f.getAuthorizedBinding.mockResolvedValueOnce(f.binding);
      f.getAuthorizedBinding.mockImplementationOnce(async () => {
        if (change === 'membership')
          throw new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied');
        return {
          ...f.binding,
          ...(change === 'revision'
            ? { revision: NEXT_REVISION }
            : { connectionIdentity: 'c'.repeat(64) }),
        };
      });
      await expect(f.prepare()).rejects.toThrow();
      expect(f.materialize).not.toHaveBeenCalled();
      await expectNoStaging();
    },
  );

  it('does not return a resolution if membership is revoked during materialization', async () => {
    const f = await setup();
    f.materialize.mockImplementationOnce(async (input) => {
      const loaded = await loadNativePackage(input);
      f.getAuthorizedBinding.mockRejectedValue(
        new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied'),
      );
      return loaded;
    });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_FORBIDDEN' });
    expect(f.materialize).toHaveBeenCalledTimes(1);
    await expectNoStaging();
  });

  it('rechecks membership after successful staging cleanup before returning a resolution', async () => {
    const f = await setup();
    let entered;
    let resume;
    const paused = new Promise((resolve) => {
      entered = resolve;
    });
    const continued = new Promise((resolve) => {
      resume = resolve;
    });
    filesystem.beforeRemove = async (path) => {
      if (String(path).includes('/.native-intake-')) {
        entered();
        await continued;
      }
    };
    const pending = f.prepare();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_FORBIDDEN' });
    await paused;
    f.getAuthorizedBinding.mockRejectedValue(
      new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied'),
    );
    resume();
    await rejected;
    await expectNoStaging();
  });

  it('loads an existing pin without rediscovering latest or redownloading bytes', async () => {
    const f = await setup();
    const resolution = await f.prepare();
    f.fetchImpl.mockClear().mockRejectedValue(new Error('Publication was removed'));
    f.discoverRelease.mockClear();
    const loaded = await f.intake.loadPinned({ actorId: 'member', resolution });
    expect(loaded.cacheHit).toBe(true);
    expect(f.discoverRelease).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.getAuthorizedBinding).toHaveBeenCalledTimes(10);
    expect(f.resolveCredential).toHaveBeenCalledTimes(5);
  });

  it('preserves a retryable publication conflict and succeeds with the same pin after the lock is released', async () => {
    const f = await setup();
    const resolution = await f.prepare();
    const cached = await f.intake.loadPinned({ actorId: 'member', resolution });
    await chmod(cached.directory, 0o700);
    await rm(cached.directory, { recursive: true });
    const lock = `${cached.directory}.lock`;
    await mkdir(lock, { mode: 0o700 });
    await expect(f.prepare()).rejects.toMatchObject({
      code: 'native_package_busy',
      message: 'Native package publication is busy; retry without changing its pin',
    });
    expect((await lstat(lock)).isDirectory()).toBe(true);
    await expectNoStaging();
    await rm(lock, { recursive: true });
    const retried = await f.prepare();
    expect(retried.packagePin.packageId).toBe(resolution.packagePin.packageId);
    expect(retried.materializationId).toBe(resolution.materializationId);
  });

  it('isolates packages by project even when their bytes and source match', async () => {
    const f = await setup();
    const first = await f.prepare();
    const second = await f.intake.prepare({ ...f.scope, projectId: 'project-two' });
    const a = await f.intake.loadPinned({ actorId: 'member', resolution: first });
    const b = await f.intake.loadPinned({ actorId: 'member', resolution: second });
    expect(a.directory).not.toBe(b.directory);
    expect(a.materializationId).toBe(b.materializationId);
  });

  it('cannot use another project cache as a fallback', async () => {
    const f = await setup();
    const resolution = await f.prepare();
    f.fetchImpl.mockClear();
    f.discoverRelease.mockClear();
    await expect(
      f.intake.loadPinned({
        actorId: 'member',
        resolution: { ...resolution, projectId: 'project-two' },
      }),
    ).rejects.toThrow();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.discoverRelease).not.toHaveBeenCalled();
  });

  it('rechecks access on cache hits and never exposes paths to a revoked caller', async () => {
    const f = await setup();
    const resolution = await f.prepare();
    f.materialize.mockClear();
    await expect(f.intake.loadPinned({ actorId: 'outsider', resolution })).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    expect(f.materialize).not.toHaveBeenCalled();
  });

  it.each(
    ['prepare', 'loadPinned', 'loadForExecution'].flatMap((operation) =>
      ['membership', 'revision', 'connection', 'project', 'delegation'].map((change) => [
        operation,
        change,
      ]),
    ),
  )(
    'rechecks %s authority after a %s change during its final credential lookup',
    async (operation, change) => {
      const f = await setup({ withProof: false });
      const resolution = operation === 'prepare' ? undefined : await f.prepare();
      const finalLookup = operation === 'prepare' ? 3 : 2;
      let entered;
      let resume;
      const paused = new Promise((resolve) => {
        entered = resolve;
      });
      const continued = new Promise((resolve) => {
        resume = resolve;
      });
      f.resolveCredential.mockClear().mockImplementation(async () => {
        if (f.resolveCredential.mock.calls.length === finalLookup) {
          entered();
          await continued;
        }
        return { purpose: 'workflow-source', token: SECRET };
      });
      const pending =
        operation === 'prepare'
          ? f.prepare()
          : f.intake[operation]({ actorId: 'member', resolution });
      const rejection = expect(pending).rejects.toMatchObject({
        code:
          change === 'membership'
            ? 'WORKFLOW_SOURCE_FORBIDDEN'
            : change === 'revision'
              ? 'WORKFLOW_SOURCE_CONFLICT'
              : 'native_package_intake_invalid',
      });
      await paused;
      if (change === 'membership') {
        f.getAuthorizedBinding.mockRejectedValue(
          new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied'),
        );
      } else if (change === 'revision') {
        f.binding.revision = NEXT_REVISION;
      } else if (change === 'project') {
        f.binding.projectIdentity = 'project-vertex-recreated';
      } else if (change === 'delegation') {
        f.binding.delegatorMembershipIdentity = 'membership-edge-readded';
      } else {
        f.binding.connectionIdentity = 'c'.repeat(64);
      }
      resume();
      await rejection;
      await expectNoStaging();
    },
  );

  it('sanitizes credential failure details and does not fall back to public access', async () => {
    const f = await setup();
    f.resolveCredential.mockRejectedValue(new Error(`https://private.example/token?key=${SECRET}`));
    await expect(f.prepare()).rejects.toMatchObject({
      code: 'native_package_intake_failed',
      message: 'Native package intake could not be completed',
    });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.materialize).not.toHaveBeenCalled();
  });

  it('does not treat a missing private credential as anonymous access', async () => {
    const f = await setup();
    f.resolveCredential.mockResolvedValue({ purpose: 'workflow-source', token: null });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'native_package_intake_invalid' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('pins the exact downloaded proof without claiming its authenticity', async () => {
    const f = await setup();
    const result = await f.prepare();
    const proof = f.files.get(PROOF);
    expect(result.attestation).toEqual({
      sha256: createHash('sha256').update(proof).digest('hex'),
      bytes: proof.length,
    });
    expect(result.packagePin.verification.attestation).toBe('not-verified');
  });
});

describe('durable intake authorization and publication', () => {
  const receiptFor = (materialization) => ({
    schemaVersion: 1,
    materializationId: materialization.materializationId,
    manifest: { versionId: 'manifest-version-1', sha256: 'a'.repeat(64), bytes: 1024 },
  });
  const archiveFixture = () => ({
    publish: vi.fn(async ({ beforeCommit, materialization }) => {
      await beforeCommit();
      return receiptFor(materialization);
    }),
    restore: vi.fn(),
    recoverReceipt: vi.fn(async ({ beforeReturn, materializationId }) => {
      await beforeReturn();
      return receiptFor({ materializationId });
    }),
  });
  const missing = () =>
    new NativePackageLoadError(
      'The pinned native package is not available in the local cache',
      'native_package_not_cached',
    );

  it('does not return a prepared resolution until publication and final access checks complete', async () => {
    const archive = archiveFixture();
    const f = await setup({ archive, withProof: false });
    let entered;
    let resume;
    const paused = new Promise((resolve) => {
      entered = resolve;
    });
    const continued = new Promise((resolve) => {
      resume = resolve;
    });
    archive.publish.mockImplementationOnce(async (request) => {
      entered();
      await continued;
      await request.beforeCommit();
      return receiptFor(request.materialization);
    });
    let returned = false;
    const pending = f.prepare().then((resolution) => {
      returned = true;
      return resolution;
    });
    await paused;
    expect(returned).toBe(false);
    resume();
    const resolution = await pending;
    expect(archive.publish).toHaveBeenCalledOnce();
    expect(resolution.archiveReceipt).toEqual(
      receiptFor(archive.publish.mock.calls[0][0].materialization),
    );
    expect(archive.publish.mock.calls[0][0]).toMatchObject({
      projectId: f.scope.projectId,
      sourceId: f.scope.sourceId,
      materialization: {
        materializationId: resolution.materializationId,
        package: { packageId: resolution.packagePin.packageId },
      },
    });
    expect(JSON.stringify(archive.publish.mock.calls)).not.toContain(SECRET);
  });

  it('withholds the resolution when durable publication fails', async () => {
    const archive = archiveFixture();
    const f = await setup({ archive });
    archive.publish.mockRejectedValue(
      new NativePackageArchiveError('native_package_archive_unavailable'),
    );
    await expect(f.prepare()).rejects.toMatchObject({ code: 'native_package_archive_unavailable' });
    expect(f.materialize).toHaveBeenCalledOnce();
    await expectNoStaging();
  });

  it.each(['before-commit', 'after-commit'])(
    'does not return a resolution when access is revoked %s',
    async (when) => {
      const archive = archiveFixture();
      const f = await setup({ archive });
      archive.publish.mockImplementationOnce(async ({ beforeCommit, materialization }) => {
        if (when === 'after-commit') await beforeCommit();
        f.getAuthorizedBinding.mockRejectedValue(
          new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied'),
        );
        if (when === 'before-commit') await beforeCommit();
        return receiptFor(materialization);
      });
      await expect(f.prepare()).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_FORBIDDEN' });
      await expectNoStaging();
    },
  );

  it('uses the exact confirmed pin to restore only a genuine cache miss', async () => {
    const archive = archiveFixture();
    const f = await setup({ archive, withProof: false });
    const resolution = await f.prepare();
    const loaded = await f.intake.loadPinned({ actorId: 'member', resolution });
    archive.restore.mockImplementationOnce(async ({ beforeMaterialize }) => {
      await beforeMaterialize();
      return loaded;
    });
    f.fetchImpl.mockClear().mockRejectedValue(new Error('Publication was overwritten'));
    f.discoverRelease.mockClear();
    f.materialize.mockRejectedValueOnce(missing());
    expect(await f.intake.loadPinned({ actorId: 'member', resolution })).toEqual(loaded);
    expect(archive.restore).toHaveBeenCalledWith({
      projectId: f.scope.projectId,
      sourceId: f.scope.sourceId,
      cacheDirectory: expect.stringMatching(/\/cache\/[a-f0-9]{64}$/),
      pin: resolution.packagePin,
      attestation: null,
      materializationId: resolution.materializationId,
      receipt: resolution.archiveReceipt,
      beforeMaterialize: expect.any(Function),
    });
    expect(f.discoverRelease).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(archive.restore.mock.calls)).not.toContain(SECRET);
  });

  it.each(['native_package_invalid', 'native_package_io', 'native_package_busy'])(
    'never replaces a cache with archive bytes after %s',
    async (code) => {
      const archive = archiveFixture();
      const f = await setup({ archive });
      const resolution = await f.prepare();
      f.materialize.mockRejectedValueOnce(new NativePackageLoadError('Failed locally', code));
      await expect(f.intake.loadPinned({ actorId: 'member', resolution })).rejects.toThrow();
      expect(archive.restore).not.toHaveBeenCalled();
    },
  );

  it('keeps a missing committed package unavailable instead of resolving latest', async () => {
    const archive = archiveFixture();
    const f = await setup({ archive });
    const resolution = await f.prepare();
    f.materialize.mockRejectedValueOnce(missing());
    archive.restore.mockRejectedValueOnce(
      new NativePackageArchiveError('native_package_archive_not_found'),
    );
    f.discoverRelease.mockClear();
    f.fetchImpl.mockClear();
    await expect(f.intake.loadPinned({ actorId: 'member', resolution })).rejects.toMatchObject({
      code: 'native_package_archive_not_found',
    });
    expect(f.discoverRelease).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('does not treat a local-only resolution as durable even on a warm cache', async () => {
    const f = await setup({ withProof: false });
    const localResolution = await f.prepare();
    const archive = archiveFixture();
    f.materialize.mockClear();
    const durableIntake = f.createIntake({ archive });
    await expect(
      durableIntake.loadPinned({
        actorId: 'member',
        resolution: localResolution,
      }),
    ).rejects.toMatchObject({ code: 'native_package_archive_invalid' });
    expect(f.materialize).not.toHaveBeenCalled();
    expect(archive.restore).not.toHaveBeenCalled();
  });

  it('rejects a publication port that returns no durable receipt', async () => {
    const archive = archiveFixture();
    archive.publish.mockResolvedValue(undefined);
    const f = await setup({ archive });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'native_package_archive_invalid' });
    await expectNoStaging();
  });

  it.each(['before-materialize', 'after-materialize'])(
    'withholds restored paths when access changes %s',
    async (when) => {
      const archive = archiveFixture();
      const f = await setup({ archive, withProof: false });
      const resolution = await f.prepare();
      const loaded = await f.intake.loadPinned({ actorId: 'member', resolution });
      f.materialize.mockRejectedValueOnce(missing());
      archive.restore.mockImplementationOnce(async ({ beforeMaterialize }) => {
        if (when === 'after-materialize') await beforeMaterialize();
        f.binding.projectIdentity = 'replacement-project';
        if (when === 'before-materialize') await beforeMaterialize();
        return loaded;
      });
      await expect(f.intake.loadPinned({ actorId: 'member', resolution })).rejects.toMatchObject({
        code: 'native_package_intake_invalid',
      });
    },
  );

  it('still requires signature verification after a successful restore', async () => {
    const archive = archiveFixture();
    const f = await setup({ archive });
    const resolution = await f.prepare();
    const loaded = await f.intake.loadPinned({ actorId: 'member', resolution });
    f.materialize.mockRejectedValueOnce(missing());
    archive.restore.mockImplementationOnce(async ({ beforeMaterialize }) => {
      await beforeMaterialize();
      return { ...loaded, trust: { allowed: true, signature: { status: 'verified' } } };
    });
    await expect(
      f.intake.loadForExecution({ actorId: 'member', resolution }),
    ).rejects.toMatchObject({
      code: 'native_package_trust_denied',
    });
  });

  it('reconciles only the original pinned candidate and returns no caller-supplied trust claims', async () => {
    const archive = archiveFixture();
    const f = await setup({ archive, withProof: false });
    const resolution = await f.prepare();
    f.fetchImpl.mockClear();
    f.discoverRelease.mockClear();
    f.materialize.mockClear();
    const reconciled = await f.intake.recoverPreparation({
      actorId: 'member',
      resolution: {
        ...resolution,
        archiveReceipt: undefined,
        privatePath: '/must-not-be-returned',
        trust: { allowed: true },
        packagePin: { ...resolution.packagePin, credentialRef: 'must-not-be-returned' },
      },
    });
    expect(reconciled.packagePin.packageId).toBe(resolution.packagePin.packageId);
    expect(reconciled.archiveReceipt).toEqual(resolution.archiveReceipt);
    expect(JSON.stringify(reconciled)).not.toMatch(/must-not-be-returned|allowed|credentialRef/);
    expect(reconciled.packagePin).not.toHaveProperty('verification');
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.discoverRelease).not.toHaveBeenCalled();
    expect(f.materialize).not.toHaveBeenCalled();
    expect(archive.publish).toHaveBeenCalledOnce();
  });

  it.each(['before-return', 'after-return'])(
    'denies reconciliation when membership is revoked %s',
    async (when) => {
      const archive = archiveFixture();
      const f = await setup({ archive, withProof: false });
      const resolution = await f.prepare();
      archive.recoverReceipt.mockImplementationOnce(async ({ beforeReturn, materializationId }) => {
        if (when === 'after-return') await beforeReturn();
        f.getAuthorizedBinding.mockRejectedValue(
          new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied'),
        );
        if (when === 'before-return') await beforeReturn();
        return receiptFor({ materializationId });
      });
      await expect(
        f.intake.recoverPreparation({
          actorId: 'member',
          resolution: { ...resolution, archiveReceipt: undefined },
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_FORBIDDEN' });
    },
  );

  it('keeps an incomplete archive unresolved without discovering a replacement release', async () => {
    const archive = archiveFixture();
    const f = await setup({ archive, withProof: false });
    const resolution = await f.prepare();
    f.discoverRelease.mockClear();
    f.fetchImpl.mockClear();
    archive.recoverReceipt.mockRejectedValueOnce(
      new NativePackageArchiveError('native_package_archive_not_found'),
    );
    await expect(
      f.intake.recoverPreparation({
        actorId: 'member',
        resolution: { ...resolution, archiveReceipt: undefined },
      }),
    ).rejects.toMatchObject({ code: 'native_package_archive_not_found' });
    expect(f.discoverRelease).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('does not replace an existing receipt through reconciliation', async () => {
    const archive = archiveFixture();
    const f = await setup({ archive, withProof: false });
    const resolution = await f.prepare();
    f.getAuthorizedBinding.mockClear();
    await expect(
      f.intake.recoverPreparation({
        actorId: 'member',
        resolution,
      }),
    ).rejects.toMatchObject({ code: 'native_package_intake_invalid' });
    expect(archive.recoverReceipt).not.toHaveBeenCalled();
    expect(f.getAuthorizedBinding).not.toHaveBeenCalled();
  });
});

describe('intake with the real durable archive and filesystem materializer', () => {
  const durable = () => {
    const storage = createNativePackageS3({
      bucket: 'native-test-packages',
      expectedBucketOwner: '123456789012',
    });
    const archive = createNativePackageArchive({
      s3: storage.s3,
      bucket: 'native-test-packages',
      expectedBucketOwner: '123456789012',
      workRoot: join(root, 'archive-work'),
      materialize: loadNativePackage,
    });
    return { archive, storage };
  };

  it.each(['github', 'gitlab', 'bitbucket'])(
    'recovers a prepared %s package in a fresh cache without rereading the release publication',
    async (provider) => {
      const { archive, storage } = durable();
      const f = await setup({ archive, provider, withProof: false });
      const resolution = await f.prepare();
      expect(resolution.archiveReceipt).toMatchObject({
        schemaVersion: 1,
        materializationId: resolution.materializationId,
        manifest: {
          versionId: expect.any(String),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      const uploadCount = storage.operations.length;
      expect(storage.operations.at(-1).input.Key).toMatch(/\/manifest\.json$/);
      f.discoverRelease.mockClear();
      f.fetchImpl.mockClear().mockRejectedValue(new Error('Rolling publication was replaced'));
      const cold = f.createIntake({
        cacheRoot: join(root, 'fresh-worker-cache'),
        workRoot: join(root, 'fresh-worker-work'),
      });

      const loaded = await cold.loadForExecution({ actorId: 'member', resolution });

      expect(loaded.package.packageId).toBe(resolution.packagePin.packageId);
      expect(loaded.trust.signature.status).toBe('absent');
      expect(loaded.directory).toContain('/fresh-worker-cache/');
      expect(await readFile(loaded.binaryPath)).toEqual(f.files.get(f.release.binaryName));
      expect(f.discoverRelease).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
      const reads = storage.operations.slice(uploadCount);
      expect(reads).toHaveLength(5);
      expect(reads.every(({ name, input }) => name === 'GetObjectCommand' && input.VersionId)).toBe(
        true,
      );
      expect(reads[0].input.VersionId).toBe(resolution.archiveReceipt.manifest.versionId);
      expect(JSON.stringify(storage.operations)).not.toContain(SECRET);
      expect(JSON.stringify(resolution)).not.toMatch(
        /native-test-packages|credentialRef|https:|archive-work/,
      );
      expect(await readdir(join(root, 'archive-work'))).toEqual([]);

      storage.operations.length = 0;
      await cold.loadPinned({ actorId: 'member', resolution });
      expect(storage.operations).toEqual([]);
    },
  );

  it('preserves the proof bytes across cold recovery and invokes the trusted verifier again', async () => {
    const { archive } = durable();
    const verifier = vi.fn(async ({ materialization }) => ({
      status: 'verified',
      packageId: materialization.package.packageId,
      materializationId: materialization.materializationId,
      attestationSha256: materialization.attestation.sha256,
      signer: { subject: 'synthetic-test-signer' },
    }));
    const f = await setup({ archive, verifyBuildSignature: verifier });
    const resolution = await f.prepare();
    expect(verifier).not.toHaveBeenCalled();
    const cold = f.createIntake({ cacheRoot: join(root, 'cold') });
    const loaded = await cold.loadForExecution({ actorId: 'member', resolution });
    expect(await readFile(loaded.attestationPath)).toEqual(f.files.get(PROOF));
    expect(verifier).toHaveBeenCalledOnce();
    expect(loaded.trust.signature.status).toBe('verified');
  });

  it('reads the pinned manifest and file versions after newer objects are written to the same keys', async () => {
    const { archive, storage } = durable();
    const f = await setup({ archive, withProof: false });
    const resolution = await f.prepare();
    for (const key of storage.objects.keys()) {
      storage.putVersion(key, Buffer.from('newer content must not replace a confirmed pin'));
    }
    const cold = f.createIntake({ cacheRoot: join(root, 'cold') });
    const loaded = await cold.loadPinned({ actorId: 'member', resolution });
    expect(await readFile(loaded.binaryPath)).toEqual(f.files.get(f.release.binaryName));
  });

  it('does not restore another project’s archive even when its package and source are the same', async () => {
    const { archive } = durable();
    const f = await setup({ archive, withProof: false });
    const resolution = await f.prepare();
    const cold = f.createIntake({ cacheRoot: join(root, 'cold') });
    await expect(
      cold.loadPinned({
        actorId: 'member',
        resolution: { ...resolution, projectId: 'other-project' },
      }),
    ).rejects.toMatchObject({ code: 'native_package_archive_not_found' });
  });

  it('denies recovery before reading private S3 objects when the member was removed', async () => {
    const { archive, storage } = durable();
    const f = await setup({ archive, withProof: false });
    const resolution = await f.prepare();
    storage.operations.length = 0;
    const cold = f.createIntake({ cacheRoot: join(root, 'cold') });
    await expect(cold.loadPinned({ actorId: 'outsider', resolution })).rejects.toMatchObject({
      code: 'WORKFLOW_SOURCE_FORBIDDEN',
    });
    expect(storage.operations).toEqual([]);
  });

  it('retains committed bytes but denies a resolution when access is revoked during the commit', async () => {
    const { archive, storage } = durable();
    const f = await setup({ archive, withProof: false });
    storage.afterSend = ({ name, input }) => {
      if (name === 'PutObjectCommand' && input.Key.endsWith('/manifest.json')) {
        f.getAuthorizedBinding.mockRejectedValue(
          new WorkflowSourceError('WORKFLOW_SOURCE_FORBIDDEN', 'Access denied'),
        );
      }
    };
    await expect(f.prepare()).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_FORBIDDEN' });
    expect([...storage.objects.keys()].some((key) => key.endsWith('/manifest.json'))).toBe(true);
    expect(storage.operations.every(({ name }) => name !== 'DeleteObjectCommand')).toBe(true);
    expect(await readdir(join(root, 'archive-work'))).toEqual([]);
  });

  it('reconciles a lost commit receipt after the original worker filesystem is lost', async () => {
    const { archive, storage } = durable();
    let candidate;
    let originalDirectory;
    let f;
    const journaledArchive = {
      ...archive,
      publish: async (request) => {
        // Simulates the protected host's persisted job input before upload.
        // The real host must await a durable conditional write at this point.
        candidate = structuredClone({
          schemaVersion: 1,
          projectId: request.projectId,
          sourceId: request.sourceId,
          bindingRevision: f.scope.expectedRevision,
          requestedRelease: 'latest',
          packagePin: request.materialization.package,
          attestation: request.materialization.attestation,
          materializationId: request.materialization.materializationId,
        });
        originalDirectory = request.materialization.directory;
        return archive.publish(request);
      },
    };
    f = await setup({ archive: journaledArchive, withProof: false });
    storage.afterSend = ({ name, input }) => {
      if (name === 'PutObjectCommand' && input.Key.endsWith('/manifest.json')) {
        throw new Error('Commit acknowledgment was lost');
      }
    };
    await expect(f.prepare()).rejects.toMatchObject({ code: 'native_package_archive_unavailable' });
    expect(candidate).toBeDefined();
    expect(candidate).not.toHaveProperty('archiveReceipt');
    await chmod(originalDirectory, 0o700);
    await rm(originalDirectory, { recursive: true });
    await rm(f.release.directory, { recursive: true });
    storage.afterSend = undefined;
    storage.operations.length = 0;
    f.discoverRelease.mockClear();
    f.fetchImpl
      .mockClear()
      .mockRejectedValue(new Error('Provider no longer publishes these files'));
    const cold = f.createIntake({
      cacheRoot: join(root, 'restarted-worker-cache'),
      workRoot: join(root, 'restarted-worker-work'),
    });
    const resolution = await cold.recoverPreparation({ actorId: 'member', resolution: candidate });
    const loaded = await cold.loadForExecution({ actorId: 'member', resolution });
    expect(loaded.package.packageId).toBe(candidate.packagePin.packageId);
    expect(await readFile(loaded.binaryPath)).toEqual(f.files.get(f.release.binaryName));
    expect(storage.operations.every(({ name }) => name === 'GetObjectCommand')).toBe(true);
    expect(f.discoverRelease).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(join(root, 'archive-work'))).toEqual([]);
  });
});
