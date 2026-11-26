// G1 configuration qualification only. This internal service has no HTTP/agent
// route. Its host supplies protected package authorization and storage. Running
// an owner-selected package still requires a runtime/container security boundary;
// private directories and process groups do not sandbox hostile same-UID code.
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { NATIVE_HARNESSES } from '../../shared/native-runtime-package.js';
import { runNativeCommand } from './command-runner.js';
import { inspectNativeInitialization } from './initialization-evidence.js';

const ENGINES = Object.freeze({
  claude: '.claude',
  codex: '.codex',
  kiro: '.kiro',
  opencode: '.aidlc',
});
const COMMAND_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 20 * 60_000;
const safeString = (value) =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const digestId = (value) =>
  typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
const versionText = (value) =>
  typeof value === 'string' &&
  !/\s/.test(value) &&
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/.test(value);

export class NativeInitializationProbeError extends Error {
  constructor(code) {
    const messages = {
      native_probe_invalid: 'Native initialization probe inputs are invalid',
      native_probe_platform: 'Native initialization requires a Linux ARM64 runtime',
      native_probe_storage: 'Native initialization evidence could not be stored',
      native_probe_authorization: 'Native initialization package authorization failed',
      native_probe_busy: 'A native initialization probe is already running',
      native_probe_runtime_unhealthy:
        'Native initialization runtime requires replacement after incomplete process cleanup',
    };
    const safeCode = Object.hasOwn(messages, code) ? code : 'native_probe_invalid';
    super(messages[safeCode]);
    this.name = 'NativeInitializationProbeError';
    this.code = safeCode;
  }
}
const fail = (code = 'native_probe_invalid') => {
  throw new NativeInitializationProbeError(code);
};

const privateRoot = async (path) => {
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    fail('native_probe_storage');
  return realpath(path);
};

const successfulEnvelope = (value) =>
  record(value) &&
  value.schemaVersion === 1 &&
  value.ok === true &&
  value.code === 0 &&
  record(value.data);

const githubSignerEnvironment = (loaded, configured) => {
  const source = loaded.package.source;
  // Other providers need an explicit supported signer mapping from their host
  // adapter. Their repository coordinates are not GitHub signer identities.
  if (source?.provider !== 'github') return { ...configured };
  const repository = source.repository;
  if (
    typeof repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split('/').some((part) => part === '.' || part === '..') ||
    /\s/.test(repository)
  )
    fail('native_probe_authorization');
  const signature = loaded.trust.signature;
  let workflow;
  if (signature?.status === 'verified') {
    const signer = signature.signer;
    if (
      signer?.issuer !== 'https://token.actions.githubusercontent.com' ||
      typeof signer.subject !== 'string'
    )
      fail('native_probe_authorization');
    workflow = signer.subject.replace(/^github\.com\//, '');
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/.test(
        workflow,
      ) ||
      /\s/.test(workflow) ||
      workflow.split('/').some((part) => part === '.' || part === '..')
    )
      fail('native_probe_authorization');
  } else if (signature?.status === 'absent') {
    workflow = `${repository}/.github/workflows/${loaded.package.version.includes('-preview.') ? 'preview-release.yml' : 'release.yml'}`;
  } else fail('native_probe_authorization');
  const expected = {
    AIDLC_RELEASE_REPOSITORY: repository,
    AIDLC_RELEASE_WORKFLOW: workflow,
  };
  for (const [key, value] of Object.entries(configured)) {
    const normalized =
      key === 'AIDLC_RELEASE_WORKFLOW' ? value.replace(/^github\.com\//, '') : value;
    if (normalized !== expected[key]) fail('native_probe_authorization');
  }
  return expected;
};

const parseOutput = (result) => {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
};

const doctorEvidence = (value) => {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.data)) return null;
  const report = value.data;
  if (!Array.isArray(report.checks) || report.checks.length === 0 || report.checks.length > 10_000)
    return null;
  const counts = { passed: 0, warnings: 0, failed: 0 };
  const checks = [];
  for (const check of report.checks) {
    if (
      !record(check) ||
      typeof check.pass !== 'boolean' ||
      !safeString(check.label) ||
      check.label.length > 16_384 ||
      (check.severity !== undefined && check.severity !== 'warn') ||
      (check.fix !== undefined && (typeof check.fix !== 'string' || check.fix.length > 16_384))
    )
      return null;
    counts[check.pass ? 'passed' : check.severity === 'warn' ? 'warnings' : 'failed'] += 1;
    checks.push({
      pass: check.pass,
      label: check.label,
      ...(check.severity ? { severity: check.severity } : {}),
      ...(check.fix !== undefined ? { fix: check.fix } : {}),
    });
  }
  if (Object.entries(counts).some(([key, count]) => report[key] !== count)) return null;
  const status = counts.failed > 0 ? 'failed' : counts.warnings > 0 ? 'warning' : 'ok';
  if (value.status !== status) return null;
  return { ...counts, checks };
};

const configEvidence = (value, version, harness, project) => {
  if (
    !successfulEnvelope(value) ||
    value.data.version !== version ||
    value.data.distribution !== harness ||
    value.data.projectDir !== project ||
    !record(value.data.counts) ||
    value.data.counts.conflict !== 0 ||
    !Array.isArray(value.data.actions) ||
    value.data.actions.some((action) => !record(action) || action.action === 'conflict') ||
    !Array.isArray(value.data.outstandingActions)
  )
    return null;
  // Raw command output stays in private evidence. Only bounded native fields
  // are retained here; outstanding actions are findings, never auto-approved.
  return { counts: value.data.counts, outstandingActions: value.data.outstandingActions };
};

/**
 * Dependencies are supplied by protected host code, not caller JSON.
 * `loadForExecution` must be the broker's fresh-authorization entry point.
 * `host`, `commandRunner`, and `inspectInitialization` are testable host ports;
 * replacing one with a fixture does not qualify a distributed native binary.
 * The returned evidence includes private paths and is not an API response.
 */
export const createNativeInitializationProbe = ({
  loadForExecution,
  probeRoot,
  gitBinary,
  hostPath,
  signerEnvironment = {},
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  commandRunner = runNativeCommand,
  inspectInitialization = inspectNativeInitialization,
  host = { platform: process.platform, arch: process.arch },
  now = Date.now,
}) => {
  if (
    typeof loadForExecution !== 'function' ||
    !safeString(probeRoot) ||
    !isAbsolute(probeRoot) ||
    !safeString(gitBinary) ||
    !isAbsolute(gitBinary) ||
    !safeString(hostPath) ||
    hostPath.split(delimiter).some((path) => !isAbsolute(path)) ||
    !positive(commandTimeoutMs) ||
    !positive(probeTimeoutMs) ||
    typeof commandRunner !== 'function' ||
    typeof inspectInitialization !== 'function' ||
    typeof now !== 'function' ||
    !record(signerEnvironment) ||
    Object.entries(signerEnvironment).some(
      ([key, value]) =>
        !['AIDLC_RELEASE_REPOSITORY', 'AIDLC_RELEASE_WORKFLOW'].includes(key) || !safeString(value),
    )
  )
    fail();
  const signerEnv = { ...signerEnvironment };
  const platform = host?.platform;
  const arch = host?.arch;
  let active = false;
  let unhealthy = false;

  const run = async ({ actorId, resolution, signal } = {}) => {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail();
    if (platform !== 'linux' || arch !== 'arm64') fail('native_probe_platform');
    if (signal?.aborted) fail();
    let loaded;
    try {
      // Never accept a caller-supplied receipt instead of consulting authority.
      loaded = await loadForExecution({ actorId, resolution });
    } catch {
      fail('native_probe_authorization');
    }
    const version = loaded?.package?.version;
    const trust = loaded?.trust;
    if (
      !versionText(version) ||
      loaded?.package?.target !== 'linux-arm64' ||
      !digestId(loaded?.package?.packageId) ||
      !digestId(loaded?.materializationId) ||
      !safeString(loaded?.directory) ||
      !isAbsolute(loaded.directory) ||
      loaded.binaryPath !== join(loaded.directory, 'aidlc-linux-arm64') ||
      trust?.allowed !== true ||
      trust.policy !== 'owner-selected-source-v1' ||
      trust.packageId !== loaded.package.packageId ||
      trust.materializationId !== loaded.materializationId
    )
      fail('native_probe_authorization');
    const nativeSignerEnv = githubSignerEnvironment(loaded, signerEnv);

    let attemptRoot;
    try {
      const root = await privateRoot(probeRoot);
      attemptRoot = await mkdtemp(join(root, 'initialization-'));
      const directories = ['machine/data', 'machine/bin', 'projects', 'evidence', 'home', 'tmp'];
      await Promise.all(
        directories.map((name) => mkdir(join(attemptRoot, name), { recursive: true, mode: 0o700 })),
      );
    } catch {
      fail('native_probe_storage');
    }
    const installRoot = join(attemptRoot, 'machine/data');
    const binRoot = join(attemptRoot, 'machine/bin');
    const evidenceRoot = join(attemptRoot, 'evidence');
    const installedBinary = join(binRoot, 'aidlc');
    const environment = Object.freeze({
      PATH: `${binRoot}${delimiter}${hostPath}`,
      HOME: join(attemptRoot, 'home'),
      TMPDIR: join(attemptRoot, 'tmp'),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      AIDLC_INSTALL_ROOT: installRoot,
      AIDLC_BIN_DIR: binRoot,
      AIDLC_OFFLINE: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...nativeSignerEnv,
    });
    const startedAt = now();
    const deadline = startedAt + probeTimeoutMs;
    const report = {
      schemaVersion: 1,
      qualification: 'initialization-only',
      status: 'failed',
      packageId: loaded.package.packageId,
      materializationId: loaded.materializationId,
      version,
      trust,
      startedAt: new Date(startedAt).toISOString(),
      attemptRoot,
      commands: [],
      harnesses: NATIVE_HARNESSES.map((harness) => ({
        harness,
        status: 'not-run',
        projectDirectory: join(attemptRoot, 'projects', harness),
      })),
      workflowExecution: 'not-tested',
      humanInteraction: 'not-tested',
      recovery: 'not-tested',
    };
    let halted = false;
    const store = async (name, value) => {
      try {
        await writeFile(join(evidenceRoot, name), `${JSON.stringify(value, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch {
        fail('native_probe_storage');
      }
    };
    const replaceFailedSummary = async () => {
      let temporary;
      try {
        temporary = await mkdtemp(join(evidenceRoot, '.summary-'));
        const path = join(temporary, 'summary.json');
        await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
        // Same-filesystem replacement never opens/truncates the old summary
        // or follows a symlink at its destination.
        await rename(path, join(evidenceRoot, 'summary.json'));
      } catch {
        fail('native_probe_storage');
      } finally {
        if (temporary) {
          try {
            await rm(temporary, { recursive: true });
          } catch {
            fail('native_probe_storage');
          }
        }
      }
    };
    const invoke = async (stage, harness, command, args, cwd, validate) => {
      if (halted) return false;
      const remaining = deadline - now();
      if (signal?.aborted || remaining <= 0) {
        halted = true;
        report.haltReason = signal?.aborted ? 'aborted' : 'deadline';
        return false;
      }
      const begun = now();
      let result;
      try {
        result = await commandRunner({
          command,
          args,
          cwd,
          env: environment,
          timeoutMs: Math.min(commandTimeoutMs, remaining),
          signal,
        });
        if (
          !record(result) ||
          typeof result.stdout !== 'string' ||
          typeof result.stderr !== 'string'
        ) {
          throw new Error('Invalid command-runner result');
        }
      } catch {
        // A host-port failure cannot prove there is no live subprocess.
        result = {
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          spawnError: 'RUNNER_FAILED',
          cleanupComplete: false,
        };
      }
      const finished = now();
      if (result?.cleanupComplete !== true) unhealthy = true;
      const value = parseOutput(result);
      let details = null;
      try {
        details = validate(value, result);
      } catch {}
      const passed =
        result.exitCode === 0 &&
        result.signal === null &&
        !result.timedOut &&
        !result.outputLimitExceeded &&
        !result.spawnError &&
        result.cleanupComplete === true &&
        details !== null &&
        !signal?.aborted &&
        finished < deadline;
      const commandReport = {
        stage,
        ...(harness ? { harness } : {}),
        status: passed ? 'passed' : 'failed',
        ...(!passed
          ? {
              failure:
                result.cleanupComplete !== true
                  ? 'cleanup-incomplete'
                  : signal?.aborted
                    ? 'aborted'
                    : finished >= deadline
                      ? 'deadline'
                      : result.timedOut
                        ? 'timeout'
                        : result.outputLimitExceeded
                          ? 'output-limit'
                          : result.spawnError || result.exitCode !== 0 || result.signal !== null
                            ? 'command-failed'
                            : 'contract-mismatch',
            }
          : {}),
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut === true,
        outputLimitExceeded: result.outputLimitExceeded === true,
        cleanupComplete: result.cleanupComplete === true,
        elapsedMs: Math.max(0, finished - begun),
        ...(details !== null ? { details } : {}),
        evidenceFile: `${String(report.commands.length + 1).padStart(2, '0')}-${harness ?? 'machine'}-${stage}.json`,
      };
      await store(commandReport.evidenceFile, {
        ...commandReport,
        command,
        args,
        cwd,
        startedAt: new Date(begun).toISOString(),
        process: result,
      });
      report.commands.push(commandReport);
      if (result.cleanupComplete !== true || signal?.aborted || finished >= deadline) {
        halted = true;
        report.haltReason =
          result.cleanupComplete !== true
            ? 'cleanup-incomplete'
            : signal?.aborted
              ? 'aborted'
              : 'deadline';
      }
      return passed;
    };

    const installed = await invoke(
      'install',
      null,
      loaded.binaryPath,
      ['use', version, '--from', loaded.directory, '--offline', '--json'],
      attemptRoot,
      (value) => (successfulEnvelope(value) && value.data.version === version ? { version } : null),
    );
    const versionMatches =
      installed &&
      (await invoke(
        'version',
        null,
        installedBinary,
        ['version', '--json'],
        attemptRoot,
        (value) =>
          record(value) &&
          value.schemaVersion === 1 &&
          value.binaryVersion === version &&
          value.runtimeVersion === version
            ? { version }
            : null,
      ));
    if (versionMatches) {
      for (const harnessReport of report.harnesses) {
        if (halted) break;
        const { harness, projectDirectory } = harnessReport;
        harnessReport.status = 'failed';
        try {
          await mkdir(projectDirectory, { mode: 0o700 });
        } catch {
          fail('native_probe_storage');
        }
        const git = await invoke(
          'git',
          harness,
          gitBinary,
          ['init', '--quiet', projectDirectory],
          attemptRoot,
          () => ({}),
        );
        if (!git) continue;
        const pin = await invoke(
          'pin',
          harness,
          installedBinary,
          [
            'config',
            '--pin',
            version,
            '--project-dir',
            projectDirectory,
            '--from',
            loaded.directory,
            '--offline',
            '--json',
          ],
          projectDirectory,
          (value) =>
            successfulEnvelope(value) &&
            value.data.version === version &&
            value.data.pinned === true &&
            value.data.projectDir === projectDirectory
              ? { version, pinned: true }
              : null,
        );
        if (!pin) continue;
        const configured = await invoke(
          'configure',
          harness,
          installedBinary,
          [
            'config',
            '--harness',
            harness,
            '--project-dir',
            projectDirectory,
            '--from',
            join(installRoot, 'versions', version, 'runtime', harness),
            '--mcp',
            'none',
            '--yes',
            '--json',
          ],
          projectDirectory,
          (value) => configEvidence(value, version, harness, projectDirectory),
        );
        if (!configured) continue;
        const doctor = await invoke(
          'doctor',
          harness,
          installedBinary,
          ['doctor', '--project-dir', projectDirectory, '--offline', '--json'],
          projectDirectory,
          (value) => {
            const evidence = doctorEvidence(value);
            return evidence && value.ok === (value.code === 0) && [0, 1, 2].includes(value.code)
              ? { ...evidence, nativeCode: value.code }
              : null;
          },
        );
        if (halted) break;
        let filesystem;
        try {
          filesystem = await inspectInitialization({
            projectDirectory,
            installRoot,
            version,
            harness,
          });
        } catch {
          filesystem = {
            ok: false,
            checks: [
              {
                id: 'inspection',
                status: 'failed',
                message: 'Initialization evidence could not be read',
              },
            ],
          };
        }
        await store(`${harness}-filesystem.json`, filesystem);
        harnessReport.filesystem = filesystem;
        if (signal?.aborted || now() >= deadline) {
          halted = true;
          report.haltReason = signal?.aborted ? 'aborted' : 'deadline';
          break;
        }
        const doctorResult = report.commands.at(-1);
        harnessReport.status =
          doctor &&
          doctorResult.details?.nativeCode === 0 &&
          doctorResult.details?.failed === 0 &&
          filesystem.ok === true
            ? 'passed'
            : 'failed';
        harnessReport.engineDirectory = join(projectDirectory, ENGINES[harness]);
      }
    }
    const finished = now();
    if (signal?.aborted || finished >= deadline) {
      halted = true;
      report.haltReason ??= signal?.aborted ? 'aborted' : 'deadline';
    }
    report.finishedAt = new Date(finished).toISOString();
    report.status =
      versionMatches && !halted && report.harnesses.every((entry) => entry.status === 'passed')
        ? 'passed'
        : 'failed';
    // Evidence has no consumer until run() settles. This first summary can be
    // preliminary if its write crosses the deadline or receives cancellation.
    await store('summary.json', report);
    const stored = now();
    if (report.status === 'passed' && (signal?.aborted || stored >= deadline)) {
      report.status = 'failed';
      report.haltReason = signal?.aborted ? 'aborted' : 'deadline';
      report.finishedAt = new Date(stored).toISOString();
      await replaceFailedSummary();
      // Failure is final. Do not keep moving its timestamp or retrying writes
      // merely because failure persistence itself takes more time.
    }
    return report;
  };
  return Object.freeze({
    async run(request) {
      if (unhealthy) fail('native_probe_runtime_unhealthy');
      if (active) fail('native_probe_busy');
      active = true;
      try {
        return await run(request);
      } finally {
        active = false;
      }
    },
  });
};
