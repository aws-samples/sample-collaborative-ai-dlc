import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import {
  createNativePackageArchive,
  describeNativePackageArchiveReceipt,
} from '../../shared/native-package-archive.js';
import { describeNativePackagePin } from '../../shared/native-package-pin.js';
import { workflowSourceIdentity } from '../../shared/workflow-source-bindings.js';
import { createNativePublications } from '../../shared/native-publication.js';
import { createNativeInteractions } from '../../shared/native-interaction.js';
import { createNativeExecutionFence } from '../../shared/native-execution-fence.js';
import { createNativeRecoveryCheckpoints } from '../../shared/native-recovery-checkpoint.js';
import { loadNativePackage } from './package-loader.js';
import { runNativeCommand } from './command-runner.js';
import { withGitCredential } from '../git-auth.js';
import { isValidRepoPath } from '../../shared/repo-validation.js';
import { recordNativeBoundary } from '../../shared/native-lifecycle.js';
import { captureNativeSourceBaseline } from './source-baseline.js';

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const HOSTS = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };
const text = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 65536 && !value.includes('\0');
const checkIdentity = (env, payload) => {
  if (
    !payload ||
    env.NATIVE_RUNTIME_MODE !== 'isolated' ||
    env.NATIVE_EXECUTION_ENABLED !== 'true' ||
    payload.projectId !== env.NATIVE_RUNTIME_PROJECT_ID ||
    payload.executionId !== env.NATIVE_RUNTIME_EXECUTION_ID ||
    payload.bindingId !== env.NATIVE_RUNTIME_BINDING_ID ||
    payload.attemptId !== env.NATIVE_EXECUTION_ATTEMPT_ID ||
    payload.epoch !== 1 ||
    String(payload.epoch) !== env.NATIVE_EXECUTION_EPOCH ||
    payload.runtimeSessionId !== env.NATIVE_EXECUTION_RUNTIME_SESSION_ID
  )
    fail('native_execution_scope_mismatch');
};
const privateDirectory = async (path) => {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) ||
    (await realpath(path)) !== path
  )
    fail('native_execution_directory_invalid');
  return stat;
};
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const canonicalPath = (value) =>
  typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
const checkAbort = (signal) => {
  if (!(signal instanceof AbortSignal)) fail('native_execution_preparation_invalid');
  if (signal.aborted) fail('native_execution_cancelled');
};
const executionScope = (identity) =>
  Object.fromEntries(
    ['projectId', 'executionId', 'bindingId', 'attemptId', 'epoch', 'runtimeSessionId'].map(
      (key) => [key, identity[key]],
    ),
  );

export const createNativeExecutionPorts = ({
  env = process.env,
  s3 = new S3Client({}),
  commandRunner = runNativeCommand,
  packageArchive = createNativePackageArchive,
  materialize = loadNativePackage,
  gitCredential = withGitCredential,
  publicationFactory = createNativePublications,
  interactionFactory = createNativeInteractions,
  recoveryFactory = createNativeRecoveryCheckpoints,
} = {}) => {
  const readActive = async ({ identity, writerGeneration = 1, signal }) => {
    checkIdentity(env, identity);
    checkAbort(signal);
    const scope = executionScope(identity);
    // Read latest, never a cached or pinned old version. The shared reader
    // checks the full scope, record shape and real S3 VersionId. This runtime
    // only receives .read; no ensureActive/cancel call is permitted here.
    try {
      const fence = createNativeExecutionFence({
        s3,
        bucket: env.NATIVE_PUBLICATION_BUCKET,
        accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
      });
      const record = await fence.read(scope);
      checkAbort(signal);
      if (record.state !== 'ACTIVE' || (record.writerGeneration ?? 1) !== writerGeneration)
        fail('native_execution_cancelled');
      return record;
    } catch {
      // Missing, malformed, mismatched and unavailable fences all deny spawn.
      fail('native_execution_cancelled');
    }
  };
  const assertActive = async (input) => {
    await readActive(input);
  };
  const assertRecoveryAdmission = async (input) => {
    const record = await readActive(input);
    if (
      input.writerGeneration < 2 ||
      record.recoveryId !== input.recoveryId ||
      record.checkpointId !== input.checkpointId
    )
      fail('native_execution_recovery_unconfirmed');
  };
  const recoveryStorage = () =>
    recoveryFactory({
      s3,
      bucket: env.NATIVE_PUBLICATION_BUCKET,
      accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
    });
  return {
    assertActive,
    assertRecoveryAdmission,
    async prepareContinuation({ payload, signal }) {
      checkIdentity(env, payload);
      checkAbort(signal);
      const dispatch = structuredClone(payload);
      const model = dispatch.credentials?.model;
      const harness = dispatch.configuration?.harness;
      if (
        !['claude', 'codex', 'kiro', 'opencode'].includes(harness) ||
        model?.provider !== (harness === 'kiro' ? 'kiro' : 'bedrock') ||
        !text(model.value)
      )
        fail('native_execution_credentials_missing');
      await assertActive({
        identity: dispatch,
        writerGeneration: dispatch.writerGeneration,
        signal,
      });
      checkAbort(signal);
      return {
        authEnv: {
          [model.provider === 'kiro' ? 'KIRO_API_KEY' : 'AWS_BEARER_TOKEN_BEDROCK']: model.value,
          BEDROCK_REGION: env.AWS_REGION,
        },
        forbiddenBytes: [model.value, dispatch.credentials?.git?.password].filter(Boolean),
      };
    },
    async prepare({ payload, root, project, home, signal }) {
      checkIdentity(env, payload);
      checkAbort(signal);
      // Snapshot before the first asynchronous operation; never reread mutable
      // dispatch credentials or a floating repository ref after verification.
      const dispatch = structuredClone(payload);
      await assertActive({
        identity: dispatch,
        writerGeneration: dispatch.writerGeneration,
        signal,
      });
      const config = dispatch.configuration;
      const repo = config?.repository;
      const model = dispatch.credentials?.model;
      const git = dispatch.credentials?.git;
      if (
        !Object.hasOwn(HOSTS, repo?.provider) ||
        !isValidRepoPath(repo.repository) ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(repo.commit ?? '') ||
        !text(repo.branch) ||
        !text(git?.username) ||
        !text(git?.password) ||
        !text(model?.value) ||
        !['claude', 'codex', 'kiro', 'opencode'].includes(config?.harness) ||
        model.provider !== (config.harness === 'kiro' ? 'kiro' : 'bedrock') ||
        ![root, project, home].every(canonicalPath) ||
        project !== join(root, 'project') ||
        home === root ||
        home.startsWith(`${root}/`)
      )
        fail('native_execution_preparation_invalid');
      const candidate = dispatch.package?.candidate;
      if (
        candidate?.projectId !== dispatch.projectId ||
        candidate?.packagePin?.version !== config.packageVersion ||
        !candidate?.packagePin?.harnesses?.includes(config.harness)
      )
        fail('native_execution_package_invalid');
      let pin;
      let archiveReceipt;
      try {
        pin = describeNativePackagePin(candidate.packagePin, candidate.attestation);
        if (
          pin.materializationId !== candidate.materializationId ||
          workflowSourceIdentity(pin.identity.source.provider, pin.identity.source.repository)
            .sourceId !== candidate.sourceId
        )
          fail('native_execution_package_invalid');
        archiveReceipt = describeNativePackageArchiveReceipt(
          dispatch.package.archiveReceipt,
          pin.materializationId,
        );
      } catch {
        fail('native_execution_package_invalid');
      }
      const roots = new Map();
      for (const path of [root, project, home]) roots.set(path, await privateDirectory(path));
      if (roots.get(root).dev !== roots.get(project).dev)
        fail('native_execution_directory_invalid');
      const recheck = async () => {
        checkIdentity(env, dispatch);
        checkAbort(signal);
        for (const [path, before] of roots) {
          if (!sameNode(before, await privateDirectory(path)))
            fail('native_execution_directory_invalid');
        }
      };
      if ((await readdir(project)).length) fail('native_execution_checkout_exists');
      for (const dir of [join(root, 'package-downloads'), join(root, 'packages')]) {
        await mkdir(dir, { mode: 0o700 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
        await privateDirectory(dir);
      }
      const archive = packageArchive({
        s3,
        bucket: env.NATIVE_PACKAGE_BUCKET,
        expectedBucketOwner: env.NATIVE_RUNTIME_ACCOUNT_ID,
        workRoot: join(root, 'package-downloads'),
        materialize,
      });
      recordNativeBoundary(dispatch, 'packageVerificationStarted');
      const loaded = await archive.restore({
        projectId: dispatch.projectId,
        sourceId: candidate.sourceId,
        pin: candidate.packagePin,
        attestation: candidate.attestation,
        materializationId: candidate.materializationId,
        receipt: archiveReceipt,
        cacheDirectory: join(root, 'packages'),
        beforeMaterialize: recheck,
      });
      await recheck();
      const directory = join(root, 'packages', pin.materializationId.slice('sha256:'.length));
      try {
        const observed = describeNativePackagePin(loaded?.package, loaded?.attestation);
        if (
          observed.packageId !== pin.packageId ||
          observed.materializationId !== pin.materializationId ||
          loaded.materializationId !== pin.materializationId ||
          loaded.directory !== directory ||
          loaded.binaryPath !== join(directory, pin.identity.assets.binary.name)
        )
          fail('native_execution_package_invalid');
        await privateDirectory(directory); // loadNativePackage publishes mode 0500.
        const binary = await lstat(loaded.binaryPath);
        if (
          !binary.isFile() ||
          binary.isSymbolicLink() ||
          binary.nlink !== 1 ||
          binary.dev !== roots.get(root).dev ||
          (await realpath(loaded.binaryPath)) !== loaded.binaryPath
        )
          fail('native_execution_package_invalid');
      } catch {
        fail('native_execution_package_invalid');
      }
      recordNativeBoundary(dispatch, 'packageVerificationCompleted');
      recordNativeBoundary(dispatch, 'checkoutStarted');
      const baseEnv = {
        HOME: home,
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_LFS_SKIP_SMUDGE: '1',
      };
      const runGit = async (args, extraEnv = {}, stdin) => {
        await recheck();
        const result = await commandRunner({
          command: '/usr/bin/git',
          args: [
            '-c',
            'credential.helper=',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'http.followRedirects=false',
            '-c',
            'protocol.allow=never',
            '-c',
            'protocol.https.allow=always',
            '-c',
            'protocol.file.allow=never',
            ...args,
          ],
          cwd: project,
          env: { ...baseEnv, ...extraEnv },
          signal,
          ...(stdin === undefined ? {} : { stdin }),
          timeoutMs: 300000,
          stdoutBytes: 1024 * 1024,
          stderrBytes: 128 * 1024,
        });
        if (result.cleanupComplete !== true) fail('native_execution_cleanup_incomplete');
        if (
          result.exitCode !== 0 ||
          result.signal ||
          result.spawnError ||
          result.timedOut ||
          result.outputLimitExceeded ||
          result.cleanupComplete !== true
        )
          fail('native_execution_checkout_failed');
        await recheck();
        return result.stdout.trim();
      };
      await runGit(['init', '--quiet']);
      await runGit([
        'remote',
        'add',
        'origin',
        `https://${HOSTS[repo.provider]}/${repo.repository}.git`,
      ]);
      await gitCredential(
        {
          projectId: dispatch.projectId,
          executionId: dispatch.executionId,
          provider: repo.provider,
          repository: repo.repository,
          requiredAccess: 'read',
        },
        ({ env: gitEnv }) =>
          runGit(
            ['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', 'origin', repo.commit],
            gitEnv,
          ),
        {
          broker: async () => ({ ...git }),
        },
      );
      // No credential environment, helper or tokenized remote reaches checkout
      // hooks, package installation, model tools or published files.
      await runGit(['checkout', '--quiet', '--detach', repo.commit]);
      const commit = await runGit(['rev-parse', 'HEAD']);
      if (commit !== repo.commit) fail('native_execution_checkout_commit_mismatch');
      const index = await runGit(['ls-files', '--stage', '-z']);
      const entries = index.split('\0').filter(Boolean);
      if (entries.some((line) => line.startsWith('160000 ')))
        fail('native_execution_submodules_unavailable');
      if (entries.some((line) => line.startsWith('120000 ')))
        fail('native_execution_checkout_link');
      // Native engine/session authority material must never enter a future Git
      // commit. Existing tracked private records are rejected, not silently
      // removed from the user's repository.
      if (
        entries.some((line) => {
          const path = line.slice(line.indexOf('\t') + 1);
          return path
            .split('/')
            .some((part) =>
              ['.aidlc-sessions', '.aidlc-engine', '.native-control', '.native-homes'].includes(
                part,
              ),
            );
        })
      )
        fail('native_execution_private_state_tracked');
      // Global filters are disabled and smudge is skipped during trusted checkout.
      // Never publish LFS pointers as hydrated source: this milestone fails
      // explicitly when the checked-out attributes select the LFS filter.
      const paths = entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
      if (paths.length) {
        const attributes = await runGit(
          ['check-attr', '-z', '--stdin', 'filter'],
          {},
          Buffer.from(`${paths.join('\0')}\0`),
        );
        const fields = attributes.split('\0');
        if (fields.at(-1) === '') fields.pop();
        if (
          fields.length !== paths.length * 3 ||
          paths.some(
            (path, position) =>
              fields[position * 3] !== path || fields[position * 3 + 1] !== 'filter',
          )
        )
          fail('native_execution_checkout_failed');
        if (paths.some((_path, position) => fields[position * 3 + 2] === 'lfs'))
          fail('native_execution_lfs_unavailable');
      }
      for (const path of [join(project, '.git'), join(project, '.git/info')]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
          fail('native_execution_directory_invalid');
      }
      const exclude = await open(
        join(project, '.git/info/exclude'),
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      try {
        const stat = await exclude.stat();
        if (!stat.isFile() || stat.nlink !== 1) fail('native_execution_file_invalid');
        await exclude.writeFile(
          '\n# Native runtime recovery and private engine records\n.native-control/\n.native-homes/\naidlc/**/.aidlc-engine/\naidlc/.aidlc-sessions/\n',
        );
        await exclude.sync();
      } finally {
        await exclude.close();
      }
      await recheck();
      recordNativeBoundary(dispatch, 'checkoutCompleted');
      const sourceBaseline = await captureNativeSourceBaseline({
        project,
        identity: executionScope(dispatch),
        repository: { commit, branch: repo.branch },
        packageId: pin.packageId,
        signal,
        forbiddenBytes: [git.password, model.value],
        publications: publicationFactory({
          s3,
          bucket: env.NATIVE_PUBLICATION_BUCKET,
          accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
        }),
      });
      await recheck();
      return {
        sourceBaseline,
        package: {
          directory: loaded.directory,
          binaryPath: loaded.binaryPath,
          version: pin.identity.version,
          packageId: pin.packageId,
          sourceRepository: pin.identity.source.repository,
        },
        repositoryCommit: commit,
        authEnv: {
          [model.provider === 'kiro' ? 'KIRO_API_KEY' : 'AWS_BEARER_TOKEN_BEDROCK']: model.value,
          BEDROCK_REGION: env.AWS_REGION,
        },
        forbiddenBytes: [git.password, model.value],
      };
    },
    async publish({
      identity,
      packageId,
      nativeSessionId,
      outcome,
      repository,
      files,
      questionPath,
      signal,
      sequence = 1,
      sourceBaseline,
    }) {
      checkIdentity(env, identity);
      checkAbort(signal);
      const publications = publicationFactory({
        s3,
        bucket: env.NATIVE_PUBLICATION_BUCKET,
        accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
      });
      const receipt = await publications.write({
        identity,
        packageId,
        nativeSessionId,
        outcome,
        repository,
        files,
        questionPath,
        sequence,
        ...(sourceBaseline ? { sourceBaseline } : {}),
      });
      checkAbort(signal);
      return { uploaded: true, receipt };
    },
    async publishInteraction({ identity, signal, ...input }) {
      checkIdentity(env, identity);
      checkAbort(signal);
      const receipt = await interactionFactory({
        s3,
        bucket: env.NATIVE_PUBLICATION_BUCKET,
        accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
      }).write({ identity, ...input });
      checkAbort(signal);
      return receipt;
    },
    async publishRecovery({ identity, signal, ...input }) {
      checkIdentity(env, identity);
      checkAbort(signal);
      if (input.imageDigest !== env.NATIVE_EXECUTION_IMAGE_DIGEST)
        fail('native_execution_recovery_unconfirmed');
      await assertActive({ identity, writerGeneration: input.writerGeneration, signal });
      const receipt = await recoveryStorage().publish({
        identity: executionScope(identity),
        ...input,
      });
      checkAbort(signal);
      return receipt;
    },
    async loadRecovery({ payload, signal }) {
      checkIdentity(env, payload);
      checkAbort(signal);
      await assertRecoveryAdmission({
        identity: payload,
        writerGeneration: payload.writerGeneration,
        recoveryId: payload.recoveryId,
        checkpointId: payload.checkpoint?.id,
        signal,
      });
      recordNativeBoundary(payload, 'checkpointVerificationStarted');
      const loaded = await recoveryStorage().readFiles(executionScope(payload), payload.checkpoint);
      const publications = publicationFactory({
        s3,
        bucket: env.NATIVE_PUBLICATION_BUCKET,
        accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
      });
      const publication = await publications.read(executionScope(payload), payload.publication);
      // Validate the retained original baseline before propagating its pointer.
      await publications.source(executionScope(payload), publication);
      checkAbort(signal);
      recordNativeBoundary(payload, 'checkpointVerificationCompleted');
      return { ...loaded, sourceBaseline: publication.sourceBaseline ?? null };
    },
    async prepareRecovery({ payload, root, project, home, signal }) {
      checkIdentity(env, payload);
      checkAbort(signal);
      const dispatch = structuredClone(payload);
      await assertRecoveryAdmission({
        identity: dispatch,
        writerGeneration: dispatch.writerGeneration,
        recoveryId: dispatch.recoveryId,
        checkpointId: dispatch.checkpoint?.id,
        signal,
      });
      const config = dispatch.configuration;
      const candidate = dispatch.package?.candidate;
      if (
        ![root, project, home].every(canonicalPath) ||
        project !== join(root, 'project') ||
        home === root ||
        home.startsWith(`${root}/`) ||
        candidate?.projectId !== dispatch.projectId ||
        candidate?.packagePin?.version !== config?.packageVersion ||
        !candidate?.packagePin?.harnesses?.includes(config?.harness)
      )
        fail('native_execution_package_invalid');
      let pin, archiveReceipt;
      try {
        pin = describeNativePackagePin(candidate.packagePin, candidate.attestation);
        if (
          pin.materializationId !== candidate.materializationId ||
          workflowSourceIdentity(pin.identity.source.provider, pin.identity.source.repository)
            .sourceId !== candidate.sourceId
        )
          fail('native_execution_package_invalid');
        archiveReceipt = describeNativePackageArchiveReceipt(
          dispatch.package.archiveReceipt,
          pin.materializationId,
        );
      } catch {
        fail('native_execution_package_invalid');
      }
      const roots = new Map();
      for (const path of [root, project, home]) roots.set(path, await privateDirectory(path));
      if (roots.get(root).dev !== roots.get(project).dev)
        fail('native_execution_directory_invalid');
      const recheck = async () => {
        checkAbort(signal);
        for (const [path, before] of roots)
          if (!sameNode(before, await privateDirectory(path)))
            fail('native_execution_directory_invalid');
      };
      for (const directory of [join(root, 'package-downloads'), join(root, 'packages')]) {
        await mkdir(directory, { mode: 0o700 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
        await privateDirectory(directory);
      }
      const archive = packageArchive({
        s3,
        bucket: env.NATIVE_PACKAGE_BUCKET,
        expectedBucketOwner: env.NATIVE_RUNTIME_ACCOUNT_ID,
        workRoot: join(root, 'package-downloads'),
        materialize,
      });
      const loaded = await archive.restore({
        projectId: dispatch.projectId,
        sourceId: candidate.sourceId,
        pin: candidate.packagePin,
        attestation: candidate.attestation,
        materializationId: candidate.materializationId,
        receipt: archiveReceipt,
        cacheDirectory: join(root, 'packages'),
        beforeMaterialize: recheck,
      });
      await recheck();
      const directory = join(root, 'packages', pin.materializationId.slice(7));
      try {
        const observed = describeNativePackagePin(loaded?.package, loaded?.attestation);
        if (
          observed.packageId !== pin.packageId ||
          observed.materializationId !== pin.materializationId ||
          loaded?.materializationId !== pin.materializationId ||
          loaded.directory !== directory ||
          loaded.binaryPath !== join(directory, pin.identity.assets.binary.name)
        )
          fail('native_execution_package_invalid');
        await privateDirectory(directory);
        const binary = await lstat(loaded.binaryPath);
        if (
          !binary.isFile() ||
          binary.isSymbolicLink() ||
          binary.nlink !== 1 ||
          binary.dev !== roots.get(root).dev ||
          (await realpath(loaded.binaryPath)) !== loaded.binaryPath
        )
          fail('native_execution_package_invalid');
      } catch {
        fail('native_execution_package_invalid');
      }
      return {
        package: {
          directory: loaded.directory,
          binaryPath: loaded.binaryPath,
          version: pin.identity.version,
          packageId: pin.packageId,
          sourceRepository: pin.identity.source.repository,
        },
      };
    },
  };
};
