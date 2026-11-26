import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitHubNativeSignatureVerifier } from '../native/github-signature-verifier.js';
import { loadNativePackage } from '../native/package-loader.js';
import { createNativePackageIntake } from '../../shared/native-package-intake.js';
import { NativePackageTrustError } from '../../shared/native-package-trust.js';
import {
  verifyNativeReleaseDirectory,
  NATIVE_PACKAGE_LIMITS,
} from '../../shared/native-runtime-package.js';
import { prepareWorkflowSourceBinding } from '../../shared/workflow-source-bindings.js';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';
import { createNativeReleaseFixture } from '../../shared/test/fixtures/native-release.js';

// Files, descriptors, digests, and metadata validation are real. The bundle and
// gh output are authored inert fixtures; no gh verification or network runs.
// These tests do not establish cryptographic validity of a real release bundle.
const PROOF = 'aidlc-release.intoto.jsonl';
const ISSUER = 'https://token.actions.githubusercontent.com';
const PREDICATE = 'https://slsa.dev/provenance/v1';
const SECRET = 'private-gh-output-must-not-escape';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const id = (value) => `sha256:${sha(canonicalJson(value))}`;
const complete = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  outputLimitExceeded: false,
  spawnError: null,
  cleanupComplete: true,
  stderr: '',
};
const ghOutput = (checksum) => [
  {
    attestation: { fixture: 'inert bundle placeholder' },
    verificationResult: {
      signature: { certificate: { fixture: 'opaque parsed certificate placeholder' } },
      verifiedTimestamps: [{ fixture: 'opaque verified timestamp placeholder' }],
      statement: {
        subject: [{ name: 'build/output/checksums.txt', digest: { sha256: checksum } }],
        predicateType: PREDICATE,
        predicate: { fixture: 'user-controlled predicate is not signer authority' },
      },
    },
  },
];
let root;
let workRoot;
let input;
let commandRunner;
let options;

const packageFixture = async (version = '2.9.0', provider = 'github', extraDistributions = []) => {
  const release = await createNativeReleaseFixture(join(root, `release-${provider}-${version}`), {
    version,
    source: { provider },
  });
  await fs.chmod(release.directory, 0o700);
  if (version.includes('-preview.') || extraDistributions.length > 0) {
    const path = join(release.directory, 'version.json');
    const manifest = JSON.parse(await fs.readFile(path, 'utf8'));
    if (version.includes('-preview.')) manifest.sourceRef = 'refs/heads/main';
    manifest.distributions.push(
      ...extraDistributions.map((name) => ({ name, productName: 'AI-DLC' })),
    );
    const bytes = Buffer.from(JSON.stringify(manifest));
    await fs.writeFile(path, bytes);
    const checksumPath = join(release.directory, 'checksums.txt');
    const checksums = await fs.readFile(checksumPath, 'utf8');
    await fs.writeFile(checksumPath, checksums.replace(/^[a-f0-9]{64}/, sha(bytes)));
  }
  const proofBytes = Buffer.from(
    '{"fixture":"unsigned inert bundle; not cryptographic evidence"}\n',
  );
  await fs.writeFile(join(release.directory, PROOF), proofBytes);
  const pin = await verifyNativeReleaseDirectory(release);
  const attestation = { name: PROOF, sha256: sha(proofBytes), bytes: proofBytes.length };
  const materialization = await loadNativePackage({
    releaseDirectory: release.directory,
    cacheDirectory: join(root, 'fixture-cache'),
    pin,
    attestation,
  });
  // Keep the real loader report and bytes. Permit owner writes in this private
  // fixture only so corruption/link tests can exercise post-load tampering.
  await fs.chmod(materialization.directory, 0o700);
  for (const name of ['version.json', 'checksums.txt', PROOF]) {
    await fs.chmod(join(materialization.directory, name), 0o600);
  }
  return {
    binding: prepareWorkflowSourceBinding({
      projectId: 'project-one',
      provider,
      repository: release.source.repository,
      actorId: 'configuring-admin',
      revision: '11111111-1111-4111-8111-111111111111',
      verified: {
        purpose: 'workflow-source',
        authType: 'public',
        capabilities: { repositoryRead: true, repositoryWrite: false },
      },
    }),
    materialization,
  };
};
const configure = (overrides = {}) =>
  createGitHubNativeSignatureVerifier({ ...options, ...overrides });
const expectDenied = async (promise, code) => {
  const error = await promise.then(
    () => {
      throw new Error('Expected signature verification to reject');
    },
    (failure) => failure,
  );
  expect(error).toBeInstanceOf(NativePackageTrustError);
  expect(error.code).toMatch(/^native_package_trust_(invalid|denied)$/);
  if (code) expect(error.code).toBe(code);
  expect(error.message).not.toContain(root);
  expect(error.message).not.toContain(SECRET);
  expect(error).not.toHaveProperty('cause');
};
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-github-signature-')));
  workRoot = join(root, 'verification');
  input = await packageFixture();
  commandRunner = vi.fn(async () => ({
    ...complete,
    stdout: JSON.stringify(ghOutput(input.materialization.package.checksumsSha256)),
  }));
  options = {
    ghBinary: '/trusted/bin/gh',
    workRoot,
    hostPath: ['/trusted/bin', '/usr/bin'],
    commandRunner,
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const writable = async (directory) => {
    await fs.chmod(directory, 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(join(directory, entry.name));
    }
  };
  await writable(root);
  await fs.rm(root, { recursive: true, force: true });
});

describe('GitHub native signature adapter', () => {
  it('accepts additional upstream distributions while retaining all four supported harnesses', async () => {
    // The real v2.9.0 manifest also advertises Copilot, Cursor and Kiro IDE.
    // The loader deliberately pins the four harnesses supported by this app.
    input = await packageFixture('2.9.0', 'github', ['copilot', 'cursor', 'kiro-ide']);
    expect(input.materialization.package.harnesses).toEqual([
      'claude',
      'codex',
      'kiro',
      'opencode',
    ]);
    const evidence = await configure()(input);
    expect(evidence.status).toBe('verified');
    expect(commandRunner).toHaveBeenCalledOnce();
    expect(commandRunner.mock.calls[0][0].args).toContain(
      input.materialization.package.source.commit,
    );
  });

  it('binds gh verification to private copied bytes, exact signer constraints, and package identities', async () => {
    vi.stubEnv('GH_TOKEN', SECRET);
    vi.stubEnv('GITHUB_TOKEN', SECRET);
    vi.stubEnv('GH_CONFIG_DIR', join(root, 'ambient-config'));
    commandRunner.mockImplementationOnce(async (request) => {
      expect(request.command).toBe('/trusted/bin/gh');
      expect(request.cwd).not.toBe(input.materialization.directory);
      expect(request.args).toEqual([
        'attestation',
        'verify',
        join(request.cwd, 'checksums.txt'),
        '--bundle',
        join(request.cwd, PROOF),
        '--repo',
        input.binding.repository,
        '--signer-workflow',
        `${input.binding.repository}/.github/workflows/release.yml`,
        '--source-ref',
        'refs/tags/v2.9.0',
        '--source-digest',
        input.materialization.package.source.commit,
        '--format=json',
        '--predicate-type',
        PREDICATE,
        '--cert-oidc-issuer',
        ISSUER,
      ]);
      expect(request.env).toEqual({
        HOME: join(request.cwd, 'home'),
        GH_CONFIG_DIR: join(request.cwd, 'gh-config'),
        TMPDIR: join(request.cwd, 'tmp'),
        PATH: `/trusted/bin${delimiter}/usr/bin`,
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
      });
      expect(request).toMatchObject({
        timeoutMs: 120_000,
        stdoutBytes: 2 * 1024 * 1024,
        stderrBytes: 1024 * 1024,
      });
      for (const folder of [
        request.cwd,
        request.env.HOME,
        request.env.GH_CONFIG_DIR,
        request.env.TMPDIR,
      ]) {
        expect((await fs.stat(folder)).mode & 0o077).toBe(0);
      }
      for (const name of ['version.json', 'checksums.txt', PROOF]) {
        expect(await fs.readFile(join(request.cwd, name))).toEqual(
          await fs.readFile(join(input.materialization.directory, name)),
        );
      }
      expect(await fs.readdir(request.cwd)).not.toContain(
        input.materialization.package.assets.binary.name,
      );
      return {
        ...complete,
        stdout: JSON.stringify(ghOutput(input.materialization.package.checksumsSha256)),
      };
    });
    const evidence = await configure()(input);
    expect(evidence).toEqual({
      status: 'verified',
      packageId: input.materialization.package.packageId,
      materializationId: input.materialization.materializationId,
      attestationSha256: input.materialization.attestation.sha256,
      signer: {
        subject: `${input.binding.repository}/.github/workflows/release.yml`,
        issuer: ISSUER,
      },
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.signer)).toBe(true);
    expect(await fs.readdir(workRoot)).toEqual([]);
  });

  it('uses the preview workflow and main source ref while retaining the exact preview tag pin', async () => {
    input = await packageFixture('2.10.0-preview.20260918.1');
    await configure()(input);
    const args = commandRunner.mock.calls[0][0].args;
    expect(args[args.indexOf('--signer-workflow') + 1]).toBe(
      `${input.binding.repository}/.github/workflows/preview-release.yml`,
    );
    expect(args[args.indexOf('--source-ref') + 1]).toBe('refs/heads/main');
    expect(input.materialization.package.source.release).toBe('v2.10.0-preview.20260918.1');
  });

  it('permits a trusted synchronous reusable-workflow override without forwarding binding credentials', async () => {
    const signerWorkflowForSource = vi.fn((source) => {
      expect(Object.isFrozen(source)).toBe(true);
      expect(source).toEqual({
        ...input.materialization.package.source,
        version: '2.9.0',
        preview: false,
      });
      return 'github.com/trusted/builders/.github/workflows/native.yml';
    });
    const evidence = await configure({
      signerWorkflowForSource,
      hostPath: '/trusted/bin:/usr/bin',
    })(input);
    expect(evidence.signer.subject).toBe(
      'github.com/trusted/builders/.github/workflows/native.yml',
    );
  });

  it.each(['gitlab', 'bitbucket'])(
    'explicitly denies %s evidence without deriving GitHub signer coordinates',
    async (provider) => {
      input = await packageFixture('2.9.0', provider);
      const signerWorkflowForSource = vi.fn();
      await expectDenied(
        configure({ signerWorkflowForSource })(input),
        'native_package_trust_denied',
      );
      expect(signerWorkflowForSource).not.toHaveBeenCalled();
      expect(commandRunner).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'inactive binding',
      (value) => {
        value.binding.status = 'deleted';
      },
    ],
    [
      'invalid revision',
      (value) => {
        value.binding.revision = 'stale';
      },
    ],
    [
      'foreign source',
      (value) => {
        value.binding.repository = 'other/private';
      },
    ],
    [
      'foreign source identity',
      (value) => {
        value.binding.sourceId = '0'.repeat(64);
      },
    ],
    [
      'stale package pin',
      (value) => {
        value.materialization.package.source.commit = 'b'.repeat(40);
      },
    ],
    [
      'stale materialization ID',
      (value) => {
        value.materialization.materializationId = `sha256:${'0'.repeat(64)}`;
      },
    ],
    [
      'stale proof pin',
      (value) => {
        value.materialization.attestation.sha256 = '0'.repeat(64);
      },
    ],
    [
      'missing proof',
      (value) => {
        delete value.materialization.attestation;
      },
    ],
    [
      'explicit null proof',
      (value) => {
        value.materialization.attestation = null;
        value.materialization.attestationPath = null;
      },
    ],
    [
      'foreign proof path',
      (value) => {
        value.materialization.attestationPath = '/other/private/bundle';
      },
    ],
  ])('rejects %s before invoking gh', async (_label, mutate) => {
    mutate(input);
    await expectDenied(configure()(input));
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it.each(['version.json', 'checksums.txt', PROOF])(
    'rejects changed exact bytes in %s before invoking gh',
    async (name) => {
      const path = join(input.materialization.directory, name);
      const bytes = await fs.readFile(path);
      bytes[0] ^= 1;
      await fs.writeFile(path, bytes);
      await expectDenied(configure()(input));
      expect(commandRunner).not.toHaveBeenCalled();
      expect(await fs.readdir(workRoot)).toEqual([]);
    },
  );

  it('rejects a proof size mismatch even if the file digest still matches', async () => {
    input.materialization.attestation.bytes += 1;
    input.materialization.materializationId = id({
      schemaVersion: 1,
      packageId: input.materialization.package.packageId,
      attestation: input.materialization.attestation,
    });
    await expectDenied(configure()(input));
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it.each(['version.json', 'checksums.txt', PROOF])(
    'rejects a %s symlink without reading its target',
    async (name) => {
      const path = join(input.materialization.directory, name);
      const target = join(root, `original-${name}`);
      await fs.rename(path, target);
      await fs.symlink(target, path);
      await expectDenied(configure()(input));
      expect(commandRunner).not.toHaveBeenCalled();
      expect(await fs.readFile(target)).not.toHaveLength(0);
    },
  );

  it.each(['source link', 'source public', 'work link', 'work public'])(
    'rejects a %s directory',
    async (kind) => {
      if (kind.startsWith('source')) {
        if (kind.endsWith('public')) await fs.chmod(input.materialization.directory, 0o755);
        else {
          const link = join(root, 'source-link');
          await fs.symlink(input.materialization.directory, link);
          input.materialization.directory = link;
          input.materialization.attestationPath = join(link, PROOF);
        }
      } else if (kind.endsWith('public')) {
        await fs.mkdir(workRoot, { mode: 0o755 });
      } else {
        const target = join(root, 'work-target');
        await fs.mkdir(target, { mode: 0o700 });
        await fs.symlink(target, workRoot);
      }
      await expectDenied(configure()(input));
      expect(commandRunner).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO promptly, with a bounded rescue writer if blocking regresses',
    async () => {
      const path = join(input.materialization.directory, PROOF);
      await fs.unlink(path);
      execFileSync('/usr/bin/mkfifo', [path]);
      let rescueStarted = false;
      let rescue;
      const watchdog = setTimeout(() => {
        rescueStarted = true;
        // The rescue writer itself is nonblocking, so this test cannot hang if
        // a regressed reader waits for a FIFO writer in libuv's thread pool.
        rescue = fs
          .open(path, constants.O_WRONLY | constants.O_NONBLOCK)
          .then((handle) => handle.close())
          .catch(() => {});
      }, 500);
      try {
        await expectDenied(configure()(input));
        expect(rescueStarted).toBe(false);
        expect(commandRunner).not.toHaveBeenCalled();
      } finally {
        clearTimeout(watchdog);
        await rescue;
      }
    },
    2000,
  );

  it('rejects oversized metadata before hashing or invoking gh', async () => {
    await fs.writeFile(
      join(input.materialization.directory, 'checksums.txt'),
      Buffer.alloc(NATIVE_PACKAGE_LIMITS.metadataBytes + 1),
    );
    await expectDenied(configure()(input));
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it.each([
    ['failed signature', { exitCode: 1 }],
    ['missing gh', { exitCode: null, spawnError: 'ENOENT' }],
    ['timeout', { timedOut: true }],
    ['output overflow', { outputLimitExceeded: true }],
    ['termination signal', { signal: 'SIGKILL' }],
  ])(
    'denies %s even if stdout contains a matching verification statement',
    async (_label, failure) => {
      commandRunner.mockResolvedValueOnce({
        ...complete,
        stdout: JSON.stringify(ghOutput(input.materialization.package.checksumsSha256)),
        stderr: `${SECRET} ${root}`,
        ...failure,
      });
      await expectDenied(configure()(input), 'native_package_trust_denied');
      expect(await fs.readdir(workRoot)).toEqual([]);
    },
  );

  it.each([
    ['invalid JSON', () => `{${SECRET}`],
    ['empty results', () => '[]'],
    ['wrong envelope', () => '{}'],
    ['wrong digest', () => JSON.stringify(ghOutput('0'.repeat(64)))],
    [
      'wrong predicate',
      (checksum) => {
        const value = ghOutput(checksum);
        value[0].verificationResult.statement.predicateType = 'https://example.invalid/other';
        return JSON.stringify(value);
      },
    ],
    [
      'missing certificate',
      (checksum) => {
        const value = ghOutput(checksum);
        delete value[0].verificationResult.signature;
        return JSON.stringify(value);
      },
    ],
    [
      'missing timestamp result',
      (checksum) => {
        const value = ghOutput(checksum);
        delete value[0].verificationResult.verifiedTimestamps;
        return JSON.stringify(value);
      },
    ],
  ])('denies %s rather than trusting exit zero alone', async (_label, output) => {
    commandRunner.mockResolvedValueOnce({
      ...complete,
      stdout: output(input.materialization.package.checksumsSha256),
    });
    await expectDenied(configure()(input), 'native_package_trust_denied');
    expect(await fs.readdir(workRoot)).toEqual([]);
  });

  it.each(['throws', 'cleanup false', 'cleanup missing'])(
    'quarantines and permanently poisons the instance when the runner %s',
    async (mode) => {
      commandRunner.mockImplementationOnce(async () => {
        if (mode === 'throws') throw new Error(`${SECRET} ${root}`);
        const result = { ...complete, stdout: '[]', cleanupComplete: false };
        if (mode === 'cleanup missing') delete result.cleanupComplete;
        return result;
      });
      const verify = configure();
      await expectDenied(verify(input), 'native_package_trust_denied');
      const attempt = commandRunner.mock.calls[0][0].cwd;
      expect((await fs.stat(attempt)).isDirectory()).toBe(true);
      expect(await fs.readFile(join(attempt, PROOF))).not.toHaveLength(0);
      await expectDenied(verify(input), 'native_package_trust_denied');
      expect(commandRunner).toHaveBeenCalledTimes(1);
      expect(await fs.readdir(workRoot)).toHaveLength(1);
    },
  );

  it('permits an explicit retry after failed verification with complete process cleanup', async () => {
    commandRunner.mockResolvedValueOnce({ ...complete, exitCode: 1, stdout: SECRET });
    const verify = configure();
    await expectDenied(verify(input), 'native_package_trust_denied');
    expect(await fs.readdir(workRoot)).toEqual([]);
    expect((await verify(input)).status).toBe('verified');
    expect(commandRunner).toHaveBeenCalledTimes(2);
    expect(commandRunner.mock.calls[0][0].cwd).not.toBe(commandRunner.mock.calls[1][0].cwd);
  });

  it('gates real intake.loadForExecution with this verifier and a fresh real loader report', async () => {
    const getAuthorizedBinding = vi.fn(async () => structuredClone(input.binding));
    const intake = createNativePackageIntake({
      workflowSources: { getAuthorizedBinding },
      resolveCredential: vi.fn(async () => ({ purpose: 'workflow-source', token: null })),
      materialize: (request) =>
        loadNativePackage({
          ...request,
          releaseDirectory: input.materialization.directory,
        }),
      cacheRoot: join(root, 'intake-cache'),
      workRoot: join(root, 'intake-work'),
      verifyBuildSignature: configure(),
    });
    const resolution = {
      schemaVersion: 1,
      projectId: input.binding.projectId,
      sourceId: input.binding.sourceId,
      bindingRevision: input.binding.revision,
      packagePin: input.materialization.package,
      materializationId: input.materialization.materializationId,
      attestation: input.materialization.attestation,
    };
    const loaded = await intake.loadForExecution({ actorId: 'member', resolution });
    expect(loaded.trust).toMatchObject({
      allowed: true,
      packageId: input.materialization.package.packageId,
      materializationId: input.materialization.materializationId,
      bindingRevision: input.binding.revision,
      signature: { status: 'verified' },
    });
    expect(loaded.directory).not.toBe(input.materialization.directory);
    expect(getAuthorizedBinding).toHaveBeenCalledTimes(4);
    expect(commandRunner).toHaveBeenCalledTimes(1);
    commandRunner.mockResolvedValueOnce({ ...complete, exitCode: 1, stdout: SECRET });
    await expectDenied(
      intake.loadForExecution({ actorId: 'member', resolution }),
      'native_package_trust_denied',
    );
    expect(commandRunner).toHaveBeenCalledTimes(2);
  });

  it('snapshots inputs before asynchronous I/O', async () => {
    const expected = input.materialization.package.packageId;
    const pending = configure()(input);
    input.binding.repository = 'other/private';
    input.materialization.package.packageId = `sha256:${'0'.repeat(64)}`;
    expect((await pending).packageId).toBe(expected);
  });

  it.each([
    { ghBinary: 'gh' },
    { workRoot: 'relative' },
    { hostPath: '/trusted/bin::/usr/bin' },
    { hostPath: ['relative'] },
    { timeoutMs: 0 },
  ])('rejects unsafe host configuration before invoking gh: %j', (overrides) => {
    expect(() => configure(overrides)).toThrow(NativePackageTrustError);
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it.each([
    () => '--repo other/private',
    () => 'example/private-workflows/.github/workflows/../../other.yml',
    async () => {
      throw new Error(SECRET);
    },
    () => {
      throw Object.assign(new NativePackageTrustError(), { message: SECRET });
    },
  ])(
    'rejects invalid/asynchronous signer configuration without leaking errors',
    async (signerWorkflowForSource) => {
      await expectDenied(configure({ signerWorkflowForSource })(input));
      expect(commandRunner).not.toHaveBeenCalled();
    },
  );
});
