import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { createNativeInitializationProbe } from '../native/initialization-probe.js';
import { inspectNativeInitialization } from '../native/initialization-evidence.js';

const filesystemHooks = vi.hoisted(() => ({ afterWrite: undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFile: async (...args) => {
      const result = await actual.writeFile(...args);
      await filesystemHooks.afterWrite?.(...args);
      return result;
    },
  };
});

// Synthetic G1 orchestration qualification only. No release, git executable,
// harness, credential provider, or subprocess runs. Output records and, in the
// filesystem integration cases, all inspected evidence use real private files.
const VERSION = '2.9.0';
const PACKAGE_ID = `sha256:${'a'.repeat(64)}`;
const MATERIALIZATION_ID = `sha256:${'b'.repeat(64)}`;
const HARNESSES = ['claude', 'codex', 'kiro', 'opencode'];
const ENGINES = { claude: '.claude', codex: '.codex', kiro: '.kiro', opencode: '.aidlc' };
const SYNTHETIC_FILES = {
  claude: {
    '.claude/settings.json': '{"synthetic":true}\n',
    '.claude/skills/aidlc/SKILL.md': '# Synthetic skill; never executed\n',
  },
  codex: {
    '.codex/hooks.json': '{"synthetic":true}\n',
    '.codex/config.toml': '# Synthetic configuration\n',
    '.codex/trust-seed.toml': '# Synthetic trust evidence, not approval\n',
    '.agents/skills/aidlc/SKILL.md': '# Synthetic skill; never executed\n',
  },
  kiro: {
    '.kiro/agents/aidlc.json':
      '{"synthetic":true,"hooks":{"agentSpawn":[{"command":"aidlc engine adapter kiro session-start"}]}}\n',
    '.kiro/hooks/aidlc-kiro-adapter.ts': '// Synthetic adapter; never imported\n',
    'AGENTS.md': '# Synthetic instructions\n',
  },
  opencode: {
    '.opencode/plugin/aidlc-opencode-adapter.ts': '// Synthetic plugin; never imported\n',
    'opencode.json': '{"synthetic":true}\n',
  },
};
const CLEAN_PROCESS = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  outputLimitExceeded: false,
  spawnError: null,
  cleanupComplete: true,
};
const output = (value, overrides = {}) => ({
  ...CLEAN_PROCESS,
  stdout: typeof value === 'string' ? value : `${JSON.stringify(value)}\n`,
  stderr: '',
  ...overrides,
});
const envelope = (data) => ({ schemaVersion: 1, ok: true, code: 0, status: 'ok', data });
const doctorOutput = (checks = [{ pass: true, label: 'Synthetic doctor check' }]) => {
  const counts = { passed: 0, warnings: 0, failed: 0 };
  for (const check of checks) {
    counts[check.pass ? 'passed' : check.severity === 'warn' ? 'warnings' : 'failed'] += 1;
  }
  return {
    schemaVersion: 1,
    ok: counts.failed === 0,
    code: counts.failed ? 1 : 0,
    status: counts.failed ? 'failed' : counts.warnings ? 'warning' : 'ok',
    data: { checks, ...counts },
  };
};
const syntheticInspection = () => ({
  schemaVersion: 1,
  ok: true,
  checks: [{ id: 'synthetic-inspector', status: 'passed', message: 'Synthetic inspection only' }],
});
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
const commandIdentity = ({ args }) => {
  if (args[0] === 'use') return { stage: 'install' };
  if (args[0] === 'version') return { stage: 'version' };
  if (args[0] === 'init')
    return { stage: 'git', harness: basename(args.at(-1)), project: args.at(-1) };
  const project = valueAfter(args, '--project-dir');
  return {
    project,
    harness: basename(project),
    stage: args[0] === 'doctor' ? 'doctor' : args.includes('--pin') ? 'pin' : 'configure',
  };
};
const jsonFile = (path) => readFile(path, 'utf8').then(JSON.parse);
const put = async (path, content, mode = 0o600) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode });
};
const putJson = (path, value) => put(path, `${JSON.stringify(value, null, 2)}\n`);

const seedPin = async (project, installRoot) => {
  await put(join(project, '.aidlc-version'), `${VERSION}\n`);
  await put(
    join(project, 'aidlc/.aidlc-sessions/pin-target'),
    `${join(installRoot, 'versions', VERSION, 'aidlc')}\n`,
  );
  const registryPath = join(installRoot, 'pins.json');
  const registry = await jsonFile(registryPath).catch((error) => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  await putJson(registryPath, { ...registry, [project]: VERSION });
};

const seedProjection = async (project, harness) => {
  const engine = ENGINES[harness];
  const data = join(project, engine, 'tools/data');
  const identity = { schemaVersion: 1, distribution: harness, harnessDir: engine };
  const description = {
    productName: `Synthetic ${harness}`,
    configNextStep: 'Synthetic G1 fixture; no executable workflow',
  };
  const harnessJson = `${JSON.stringify({
    ...identity,
    ...description,
    rulesSubdir: harness === 'kiro' ? 'steering' : harness === 'codex' ? 'aidlc-rules' : 'rules',
  })}\n`;
  await putJson(join(data, 'aidlc-stamp.json'), { ...identity, frameworkVersion: VERSION });
  await putJson(join(data, 'aidlc-projection.json'), {
    ...identity,
    ...description,
    managedDirectories: [engine, 'aidlc'],
    rootIntegrations: [],
  });
  await put(join(data, 'harness.json'), harnessJson);
  await putJson(join(data, 'aidlc-manifest.json'), {
    ...identity,
    frameworkVersion: VERSION,
    mcpMode: 'none',
    files: {
      [`${engine}/tools/data/harness.json`]: `sha256:${createHash('sha256').update(harnessJson).digest('hex')}`,
    },
    rootContributions: {},
  });
  await put(join(project, 'aidlc/spaces/default/memory/README.md'), 'Synthetic method memory\n');
  for (const [path, content] of Object.entries(SYNTHETIC_FILES[harness])) {
    await put(join(project, path), content);
  }
};

let root;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'native-initialization-probe-')));
});
afterEach(async () => {
  filesystemHooks.afterWrite = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const setup = async ({ realInspection = false, onCommand, ...overrides } = {}) => {
  const directory = join(root, 'verified-release');
  await mkdir(directory, { mode: 0o700 });
  const binaryPath = join(directory, 'aidlc-linux-arm64');
  await put(binaryPath, 'Synthetic pinned binary; never executed\n', 0o500);
  const loaded = {
    directory,
    binaryPath,
    package: { version: VERSION, target: 'linux-arm64', packageId: PACKAGE_ID },
    materializationId: MATERIALIZATION_ID,
    attestation: null,
    attestationPath: null,
    trust: {
      policy: 'owner-selected-source-v1',
      packageId: PACKAGE_ID,
      materializationId: MATERIALIZATION_ID,
      allowed: true,
      signature: { status: 'absent' },
    },
  };
  const loadForExecution = vi.fn(async () => loaded);
  const clock = { value: Date.parse('2026-09-18T12:00:00Z') };
  const inspectInitialization = vi.fn(
    realInspection ? inspectNativeInitialization : syntheticInspection,
  );
  const commandRunner = vi.fn(async (command) => {
    const identity = commandIdentity(command);
    const { stage, harness, project } = identity;
    const installRoot = command.env.AIDLC_INSTALL_ROOT;
    if (realInspection) {
      if (stage === 'install') {
        await put(
          join(installRoot, 'versions', VERSION, 'aidlc'),
          'Synthetic installed binary\n',
          0o500,
        );
        await put(join(command.env.AIDLC_BIN_DIR, 'aidlc'), 'Synthetic launcher\n', 0o500);
      } else if (stage === 'git') {
        await mkdir(join(project, '.git'), { mode: 0o700 });
      } else if (stage === 'pin') {
        await seedPin(project, installRoot);
      } else if (stage === 'configure') {
        await seedProjection(project, harness);
      }
    }
    let value;
    if (stage === 'install') value = envelope({ version: VERSION });
    else if (stage === 'version') {
      value = { schemaVersion: 1, binaryVersion: VERSION, runtimeVersion: VERSION };
    } else if (stage === 'git') value = '';
    else if (stage === 'pin')
      value = envelope({ version: VERSION, projectDir: project, pinned: true });
    else if (stage === 'configure') {
      value = envelope({
        version: VERSION,
        projectDir: project,
        distribution: harness,
        counts: { create: 1, conflict: 0 },
        actions: [{ path: 'synthetic', action: 'create' }],
        outstandingActions: [],
      });
    } else value = doctorOutput();
    const result = output(value);
    return (await onCommand?.(command, { ...identity, value, result, clock })) ?? result;
  });
  const options = {
    loadForExecution,
    probeRoot: join(root, 'probes'),
    gitBinary: join(root, 'host-bin/git'),
    hostPath: ['/usr/bin', '/bin'].join(delimiter),
    commandRunner,
    inspectInitialization,
    host: { platform: 'linux', arch: 'arm64' },
    now: () => clock.value,
    ...overrides,
  };
  const probe = createNativeInitializationProbe(options);
  const resolution = { synthetic: 'server-owned resolution fixture' };
  return {
    loaded,
    clock,
    options,
    loadForExecution,
    commandRunner,
    inspectInitialization,
    resolution,
    run: (input = {}) => probe.run({ actorId: 'member', resolution, ...input }),
  };
};
const identities = (f) => f.commandRunner.mock.calls.map(([command]) => commandIdentity(command));
const evidenceDirectory = (report) => join(report.attemptRoot, 'evidence');
const recordedCommand = (report, command) =>
  jsonFile(join(evidenceDirectory(report), command.evidenceFile));

describe('synthetic native initialization orchestration', () => {
  it('runs the exact public command sequence for all four harnesses and stores private records', async () => {
    const f = await setup({
      signerEnvironment: {
        AIDLC_RELEASE_REPOSITORY: 'example/approved-fork',
        AIDLC_RELEASE_WORKFLOW: 'example/approved-fork/.github/workflows/release.yml',
      },
    });
    const report = await f.run();
    expect(f.loadForExecution).toHaveBeenCalledExactlyOnceWith({
      actorId: 'member',
      resolution: f.resolution,
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      qualification: 'initialization-only',
      status: 'passed',
      packageId: PACKAGE_ID,
      materializationId: MATERIALIZATION_ID,
      workflowExecution: 'not-tested',
      humanInteraction: 'not-tested',
      recovery: 'not-tested',
    });
    expect(report.harnesses.map(({ harness, status }) => [harness, status])).toEqual(
      HARNESSES.map((harness) => [harness, 'passed']),
    );
    const installRoot = join(report.attemptRoot, 'machine/data');
    const installed = join(report.attemptRoot, 'machine/bin/aidlc');
    const expected = [
      {
        command: f.loaded.binaryPath,
        args: ['use', VERSION, '--from', f.loaded.directory, '--offline', '--json'],
        cwd: report.attemptRoot,
      },
      { command: installed, args: ['version', '--json'], cwd: report.attemptRoot },
    ];
    for (const harness of HARNESSES) {
      const project = join(report.attemptRoot, 'projects', harness);
      expected.push(
        {
          command: f.options.gitBinary,
          args: ['init', '--quiet', project],
          cwd: report.attemptRoot,
        },
        {
          command: installed,
          args: [
            'config',
            '--pin',
            VERSION,
            '--project-dir',
            project,
            '--from',
            f.loaded.directory,
            '--offline',
            '--json',
          ],
          cwd: project,
        },
        {
          command: installed,
          args: [
            'config',
            '--harness',
            harness,
            '--project-dir',
            project,
            '--from',
            join(installRoot, 'versions', VERSION, 'runtime', harness),
            '--mcp',
            'none',
            '--yes',
            '--json',
          ],
          cwd: project,
        },
        {
          command: installed,
          args: ['doctor', '--project-dir', project, '--offline', '--json'],
          cwd: project,
        },
      );
      expect(f.inspectInitialization).toHaveBeenCalledWith({
        projectDirectory: project,
        installRoot,
        version: VERSION,
        harness,
      });
    }
    expect(
      f.commandRunner.mock.calls.map(([{ command, args, cwd }]) => ({ command, args, cwd })),
    ).toEqual(expected);
    expect(report.commands).toHaveLength(18);
    const files = await readdir(evidenceDirectory(report));
    expect(files.toSorted()).toEqual(
      [
        'summary.json',
        ...HARNESSES.map((harness) => `${harness}-filesystem.json`),
        ...report.commands.map((command) => command.evidenceFile),
      ].toSorted(),
    );
    expect(await jsonFile(join(evidenceDirectory(report), 'summary.json'))).toEqual(report);
    for (const command of report.commands) {
      const saved = await recordedCommand(report, command);
      expect(saved).toMatchObject({
        stage: command.stage,
        status: 'passed',
        process: CLEAN_PROCESS,
        args: expect.any(Array),
      });
      expect(typeof saved.process.stdout).toBe('string');
      expect(Object.hasOwn(saved, 'env')).toBe(false);
    }
    for (const file of files) {
      const stat = await lstat(join(evidenceDirectory(report), file));
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.mode & 0o777).toBe(0o600);
    }
    for (const path of [
      f.options.probeRoot,
      report.attemptRoot,
      evidenceDirectory(report),
      installRoot,
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
  });

  it('builds an explicit environment without ambient credentials, hook overrides or shared HOME', async () => {
    const parent = {
      HOME: '/synthetic-parent-home',
      AWS_ACCESS_KEY_ID: 'synthetic-aws-key',
      AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret',
      AWS_SESSION_TOKEN: 'synthetic-session',
      GH_TOKEN: 'synthetic-github-token',
      GITLAB_TOKEN: 'synthetic-gitlab-token',
      BITBUCKET_TOKEN: 'synthetic-bitbucket-token',
      CODEX_HOME: '/synthetic-codex-home',
      AIDLC_GH_BIN: '/synthetic-bypass',
      AIDLC_RUNTIME_ROOT: '/synthetic-runtime',
      AIDLC_PROJECT_DIR: '/synthetic-project',
      NODE_OPTIONS: '--synthetic',
      LD_PRELOAD: '/synthetic-preload',
      GIT_CONFIG_GLOBAL: '/synthetic-gitconfig',
      GIT_CONFIG_NOSYSTEM: '0',
      HTTPS_PROXY: 'https://synthetic-secret.invalid',
      NODE_V8_COVERAGE: '/synthetic-coverage',
    };
    for (const [key, value] of Object.entries(parent)) vi.stubEnv(key, value);
    const signerEnvironment = {
      AIDLC_RELEASE_REPOSITORY: 'example/approved',
      AIDLC_RELEASE_WORKFLOW: 'example/approved/.github/workflows/release.yml',
    };
    const f = await setup({ signerEnvironment });
    signerEnvironment.AIDLC_RELEASE_REPOSITORY = 'different/after-construction';
    const report = await f.run();
    const expected = {
      PATH: `${join(report.attemptRoot, 'machine/bin')}${delimiter}${f.options.hostPath}`,
      HOME: join(report.attemptRoot, 'home'),
      TMPDIR: join(report.attemptRoot, 'tmp'),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      AIDLC_INSTALL_ROOT: join(report.attemptRoot, 'machine/data'),
      AIDLC_BIN_DIR: join(report.attemptRoot, 'machine/bin'),
      AIDLC_OFFLINE: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      AIDLC_RELEASE_REPOSITORY: 'example/approved',
      AIDLC_RELEASE_WORKFLOW: 'example/approved/.github/workflows/release.yml',
    };
    for (const [command] of f.commandRunner.mock.calls) {
      expect(command.env).toEqual(expected);
      expect(Object.isFrozen(command.env)).toBe(true);
    }
    expect((await lstat(expected.HOME)).mode & 0o777).toBe(0o700);
    expect((await lstat(expected.TMPDIR)).mode & 0o777).toBe(0o700);
    expect(
      JSON.stringify(await jsonFile(join(evidenceDirectory(report), 'summary.json'))),
    ).not.toContain('synthetic-aws-secret');
  });

  it('reauthorizes and isolates machine roots and HOME for each attempt', async () => {
    const f = await setup();
    const first = await f.run();
    const second = await f.run();
    expect(f.loadForExecution).toHaveBeenCalledTimes(2);
    expect(first.attemptRoot).not.toBe(second.attemptRoot);
    expect(f.commandRunner.mock.calls[0][0].env.HOME).not.toBe(
      f.commandRunner.mock.calls[18][0].env.HOME,
    );
    expect(await jsonFile(join(evidenceDirectory(first), 'summary.json'))).toEqual(first);
  });

  it.each(['install', 'version'])(
    '%s process failure blocks all harnesses',
    async (failedStage) => {
      const f = await setup({
        onCommand: (_command, { stage, result }) =>
          stage === failedStage
            ? { ...result, exitCode: 4, stderr: 'Synthetic native refusal' }
            : undefined,
      });
      const report = await f.run();
      expect(report.status).toBe('failed');
      expect(identities(f).map(({ stage }) => stage)).toEqual(
        failedStage === 'install' ? ['install'] : ['install', 'version'],
      );
      expect(report.harnesses.every(({ status }) => status === 'not-run')).toBe(true);
      expect(f.inspectInitialization).not.toHaveBeenCalled();
      expect((await recordedCommand(report, report.commands.at(-1))).process.stderr).toBe(
        'Synthetic native refusal',
      );
    },
  );

  it.each([
    ['install', '{invalid'],
    ['install', envelope({ version: '2.8.0' })],
    ['version', { schemaVersion: 1, binaryVersion: VERSION, runtimeVersion: '2.8.0' }],
    ['version', envelope({ version: VERSION })],
  ])('invalid %s success output blocks all harnesses', async (failedStage, value) => {
    const f = await setup({
      onCommand: (_command, { stage }) => (stage === failedStage ? output(value) : undefined),
    });
    const report = await f.run();
    expect(report.status).toBe('failed');
    expect(identities(f).every(({ harness }) => harness === undefined)).toBe(true);
  });

  it.each(HARNESSES.flatMap((harness) => ['pin', 'configure'].map((stage) => [harness, stage])))(
    '%s %s failure skips dependent commands but continues other harnesses',
    async (failedHarness, failedStage) => {
      const f = await setup({
        onCommand: (_command, { stage, harness, result }) =>
          stage === failedStage && harness === failedHarness
            ? { ...result, exitCode: 1 }
            : undefined,
      });
      const report = await f.run();
      expect(report.status).toBe('failed');
      expect(report.harnesses.map(({ harness, status }) => [harness, status])).toEqual(
        HARNESSES.map((harness) => [harness, harness === failedHarness ? 'failed' : 'passed']),
      );
      expect(
        identities(f)
          .filter(({ harness }) => harness === failedHarness)
          .map(({ stage }) => stage),
      ).toEqual(failedStage === 'pin' ? ['git', 'pin'] : ['git', 'pin', 'configure']);
      expect(
        f.inspectInitialization.mock.calls.some(([args]) => args.harness === failedHarness),
      ).toBe(false);
    },
  );

  it('rejects mismatched configuration evidence despite a zero process exit', async () => {
    const f = await setup({
      onCommand: (_command, { stage, harness, value }) =>
        stage === 'configure' && harness === 'claude'
          ? output({ ...value, data: { ...value.data, distribution: 'codex' } })
          : undefined,
    });
    const report = await f.run();
    expect(report.status).toBe('failed');
    expect(
      identities(f).some(({ stage, harness }) => stage === 'doctor' && harness === 'claude'),
    ).toBe(false);
    expect(report.harnesses.slice(1).every(({ status }) => status === 'passed')).toBe(true);
  });
});

describe('synthetic probe stopping conditions', () => {
  it.each(['authorization', 'command', 'inspection'])(
    'rejects a concurrent run during %s before reauthorizing or spawning',
    async (boundary) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      const f = await setup({
        onCommand: async (_command, { stage }) => {
          if (boundary === 'command' && stage === 'install') await wait();
        },
      });
      if (boundary === 'authorization') {
        f.loadForExecution.mockImplementationOnce(async () => {
          await wait();
          return f.loaded;
        });
      } else if (boundary === 'inspection') {
        f.inspectInitialization.mockImplementationOnce(async () => {
          await wait();
          return syntheticInspection();
        });
      }
      const first = f.run();
      let report;
      try {
        await entered.promise;
        const commandCount = f.commandRunner.mock.calls.length;
        await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_busy' });
        expect(f.loadForExecution).toHaveBeenCalledTimes(1);
        expect(f.commandRunner).toHaveBeenCalledTimes(commandCount);
      } finally {
        release.resolve();
        report = await first;
      }
      expect(report.status).toBe('passed');
      expect((await f.run()).status).toBe('passed');
      expect(f.loadForExecution).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['incomplete cleanup', { cleanupComplete: false }],
    ['missing cleanup evidence', { cleanupComplete: undefined }],
    ['runner throws', null],
  ])('halts every later command and poisons instance reuse on %s', async (_label, changes) => {
    const f = await setup({
      onCommand: (_command, { stage, harness, result }) => {
        if (stage !== 'pin' || harness !== 'claude') return undefined;
        if (changes === null) throw new Error('Synthetic private runner failure');
        return { ...result, ...changes };
      },
    });
    const report = await f.run();
    expect(report).toMatchObject({ status: 'failed', haltReason: 'cleanup-incomplete' });
    expect(identities(f).map(({ stage }) => stage)).toEqual(['install', 'version', 'git', 'pin']);
    expect(report.harnesses.slice(1).every(({ status }) => status === 'not-run')).toBe(true);
    const saved = await recordedCommand(report, report.commands.at(-1));
    expect(saved.cleanupComplete).toBe(false);
    if (changes === null) {
      expect(saved.process.spawnError).toBe('RUNNER_FAILED');
      expect(JSON.stringify(saved)).not.toContain('Synthetic private runner failure');
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_runtime_unhealthy' });
      expect(f.loadForExecution).toHaveBeenCalledTimes(1);
      expect(f.commandRunner).toHaveBeenCalledTimes(4);
    }
    expect(await readdir(f.options.probeRoot)).toEqual([basename(report.attemptRoot)]);
  });

  it('releases the run lock after authorization rejects without poisoning the instance', async () => {
    const f = await setup();
    f.loadForExecution.mockRejectedValueOnce(new Error('Synthetic authorization failure'));
    await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_authorization' });
    expect(f.commandRunner).not.toHaveBeenCalled();
    expect((await f.run()).status).toBe('passed');
    expect(f.loadForExecution).toHaveBeenCalledTimes(2);
  });

  it('permits a fresh authorized attempt after a fully cleaned-up command failure', async () => {
    const f = await setup();
    f.commandRunner.mockResolvedValueOnce(output('', { exitCode: 1 }));
    expect((await f.run()).status).toBe('failed');
    expect((await f.run()).status).toBe('passed');
    expect(f.loadForExecution).toHaveBeenCalledTimes(2);
    expect(f.commandRunner).toHaveBeenCalledTimes(19);
  });

  it('retains the unhealthy boundary when incomplete cleanup also prevents storing evidence', async () => {
    const f = await setup({
      onCommand: async (command, { stage, result }) => {
        if (stage !== 'install') return undefined;
        await put(
          join(command.cwd, 'evidence/01-machine-install.json'),
          'Synthetic conflicting evidence\n',
        );
        return { ...result, cleanupComplete: false };
      },
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_storage' });
    await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_runtime_unhealthy' });
    expect(f.loadForExecution).toHaveBeenCalledTimes(1);
    expect(f.commandRunner).toHaveBeenCalledTimes(1);
  });

  it('halts after an abort during a command, even if the mock returns success', async () => {
    const controller = new AbortController();
    const f = await setup({
      onCommand: (_command, { stage }) => {
        if (stage === 'version') controller.abort();
      },
    });
    const report = await f.run({ signal: controller.signal });
    expect(report).toMatchObject({ status: 'failed', haltReason: 'aborted' });
    expect(f.commandRunner).toHaveBeenCalledTimes(2);
    expect(
      f.commandRunner.mock.calls.every(([command]) => command.signal === controller.signal),
    ).toBe(true);
  });

  it('halts on the exact deadline after command cleanup', async () => {
    const f = await setup({
      probeTimeoutMs: 100,
      onCommand: (_command, { stage, clock }) => {
        if (stage === 'version') clock.value += 100;
      },
    });
    const report = await f.run();
    expect(report).toMatchObject({ status: 'failed', haltReason: 'deadline' });
    expect(f.commandRunner).toHaveBeenCalledTimes(2);
  });

  it('limits each command by the remaining overall budget', async () => {
    const f = await setup({
      commandTimeoutMs: 80,
      probeTimeoutMs: 150,
      onCommand: (_command, { stage, clock }) => {
        if (['install', 'version'].includes(stage)) clock.value += 50;
      },
    });
    expect((await f.run()).status).toBe('passed');
    expect(f.commandRunner.mock.calls.map(([command]) => command.timeoutMs)).toEqual([
      80,
      80,
      ...Array(16).fill(50),
    ]);
  });

  it.each(['abort', 'deadline'])(
    'does not pass after %s during the final filesystem inspection',
    async (reason) => {
      const controller = new AbortController();
      const f = await setup({ probeTimeoutMs: 100 });
      f.inspectInitialization.mockImplementation(async ({ harness }) => {
        if (harness === HARNESSES.at(-1)) {
          if (reason === 'abort') controller.abort();
          else f.clock.value += 100;
        }
        return syntheticInspection();
      });
      const report = await f.run({ signal: controller.signal });
      expect(report.status).toBe('failed');
      expect(report.haltReason).toBe(reason === 'abort' ? 'aborted' : 'deadline');
      expect(report.harnesses.at(-1).status).not.toBe('passed');
    },
  );

  it.each([
    ['timeout', { timedOut: true }],
    ['output limit', { outputLimitExceeded: true }],
    ['signal', { signal: 'SIGKILL' }],
    ['spawn error', { spawnError: 'ENOENT' }],
  ])(
    'a cleaned-up %s still fails that harness without qualifying an incomplete set',
    async (_label, changes) => {
      const f = await setup({
        onCommand: (_command, { stage, harness, result }) =>
          stage === 'configure' && harness === 'claude' ? { ...result, ...changes } : undefined,
      });
      const report = await f.run();
      expect(report.status).toBe('failed');
      expect(report.harnesses[0].status).toBe('failed');
      expect(report.harnesses.slice(1).every(({ status }) => status === 'passed')).toBe(true);
    },
  );
});

describe('native doctor evidence validation', () => {
  it('preserves advisory warnings and configuration findings without inventing approval', async () => {
    const warning = {
      pass: false,
      severity: 'warn',
      label: 'Synthetic trust warning',
      fix: 'Manual action remains',
    };
    const outstanding = [
      { section: 'trust', id: 'synthetic-trust', message: 'Needs human review' },
    ];
    const f = await setup({
      onCommand: (_command, { stage, value }) => {
        if (stage === 'doctor')
          return output(doctorOutput([{ pass: true, label: 'Synthetic pass' }, warning]));
        if (stage === 'configure')
          return output({ ...value, data: { ...value.data, outstandingActions: outstanding } });
      },
    });
    const report = await f.run();
    expect(report.status).toBe('passed');
    for (const command of report.commands.filter(({ stage }) => stage === 'doctor')) {
      expect(command.details).toMatchObject({
        passed: 1,
        warnings: 1,
        failed: 0,
        checks: expect.arrayContaining([warning]),
      });
      const saved = await recordedCommand(report, command);
      expect(JSON.parse(saved.process.stdout).data.checks).toContainEqual(warning);
    }
    for (const command of report.commands.filter(({ stage }) => stage === 'configure')) {
      expect(command.details.outstandingActions).toEqual(outstanding);
    }
    expect(report.humanInteraction).toBe('not-tested');
  });

  it('preserves doctor failures and cannot pass their harness', async () => {
    const f = await setup({
      onCommand: (_command, { stage, harness }) =>
        stage === 'doctor' && harness === 'claude'
          ? output(doctorOutput([{ pass: false, label: 'Synthetic failed check' }]), {
              exitCode: 1,
            })
          : undefined,
    });
    const report = await f.run();
    const doctor = report.commands.find(
      ({ stage, harness }) => stage === 'doctor' && harness === 'claude',
    );
    expect(doctor.details).toMatchObject({ failed: 1, passed: 0, warnings: 0, nativeCode: 1 });
    expect(report.status).toBe('failed');
    expect(report.harnesses[0].status).toBe('failed');
    expect(report.harnesses.slice(1).every(({ status }) => status === 'passed')).toBe(true);
  });

  it.each([
    ['invalid JSON', () => 'not-json'],
    [
      'empty checks',
      (value) => ({ ...value, data: { passed: 0, warnings: 0, failed: 0, checks: [] } }),
    ],
    ['wrong passed count', (value) => ({ ...value, data: { ...value.data, passed: 0 } })],
    ['negative warning count', (value) => ({ ...value, data: { ...value.data, warnings: -1 } })],
    ['fractional count', (value) => ({ ...value, data: { ...value.data, failed: 0.5 } })],
    ['string count', (value) => ({ ...value, data: { ...value.data, passed: '1' } })],
    [
      'invalid check',
      (value) => ({
        ...value,
        data: { ...value.data, checks: [{ pass: 'true', label: 'Synthetic' }] },
      }),
    ],
    ['contradictory native status', (value) => ({ ...value, ok: false })],
    ['status inconsistent with check counts', (value) => ({ ...value, status: 'warning' })],
    ['unsupported native code', (value) => ({ ...value, ok: false, code: 99 })],
  ])('rejects %s even when the process exits zero', async (_label, change) => {
    const f = await setup({
      onCommand: (_command, { stage, harness, value }) =>
        stage === 'doctor' && harness === 'claude' ? output(change(value)) : undefined,
    });
    const report = await f.run();
    expect(report.status).toBe('failed');
    expect(report.harnesses[0].status).toBe('failed');
    const doctor = report.commands.find(
      ({ stage, harness }) => stage === 'doctor' && harness === 'claude',
    );
    expect(doctor.status).toBe('failed');
    expect(doctor).not.toHaveProperty('details');
  });
});

describe('synthetic probe finalization boundaries', () => {
  it('persists and returns failure when the final timestamp crosses the budget', async () => {
    const startedAt = Date.parse('2026-09-18T12:00:00Z');
    let finalInspectionComplete = false;
    let finalClockReads = 0;
    const f = await setup({
      probeTimeoutMs: 100,
      now: () => {
        if (!finalInspectionComplete) return startedAt;
        finalClockReads += 1;
        // Last inspection passes inside the budget; the next clock read is
        // already too late to finalize the overall report as passed.
        return startedAt + (finalClockReads === 1 ? 99 : 101);
      },
    });
    f.inspectInitialization.mockImplementation(async ({ harness }) => {
      if (harness === HARNESSES.at(-1)) finalInspectionComplete = true;
      return syntheticInspection();
    });
    const report = await f.run();
    expect(finalClockReads).toBeGreaterThanOrEqual(2);
    expect(f.commandRunner).toHaveBeenCalledTimes(18);
    expect(report).toMatchObject({ status: 'failed', haltReason: 'deadline' });
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(startedAt + 101);
    expect(await jsonFile(join(evidenceDirectory(report), 'summary.json'))).toEqual(report);
  });

  it.each(['abort', 'deadline'])(
    'persists and returns failure on %s while the final summary write is pending',
    async (reason) => {
      const controller = new AbortController();
      const summaryWritten = Promise.withResolvers();
      const releaseWrite = Promise.withResolvers();
      const f = await setup({ probeTimeoutMs: 100 });
      let intercepted = false;
      filesystemHooks.afterWrite = async (_path, content) => {
        if (intercepted || typeof content !== 'string') return;
        let value;
        try {
          value = JSON.parse(content);
        } catch {
          return;
        }
        if (
          value.qualification !== 'initialization-only' ||
          !Array.isArray(value.commands) ||
          !Array.isArray(value.harnesses)
        )
          return;
        // The real filesystem write has completed. Its promise remains
        // pending so this exercises the awaited finalization boundary.
        intercepted = true;
        summaryWritten.resolve();
        await releaseWrite.promise;
      };
      const running = f.run({ signal: controller.signal });
      let report;
      try {
        await Promise.race([
          summaryWritten.promise,
          running.then(() => {
            throw new Error('Expected to intercept a real summary write before completion');
          }),
        ]);
        expect(f.commandRunner).toHaveBeenCalledTimes(18);
        if (reason === 'abort') controller.abort();
        else f.clock.value += 100;
      } finally {
        releaseWrite.resolve();
        report = await running;
      }
      expect(intercepted).toBe(true);
      expect(report).toMatchObject({
        status: 'failed',
        haltReason: reason === 'abort' ? 'aborted' : 'deadline',
      });
      const summaryPath = join(evidenceDirectory(report), 'summary.json');
      expect(await jsonFile(summaryPath)).toEqual(report);
      expect((await lstat(summaryPath)).mode & 0o777).toBe(0o600);
    },
  );
});

describe('protected authorization, storage and filesystem evidence', () => {
  it.each([
    [
      'missing trust',
      (loaded) => {
        delete loaded.trust;
      },
    ],
    [
      'denied trust',
      (loaded) => {
        loaded.trust.allowed = false;
      },
    ],
    [
      'foreign policy',
      (loaded) => {
        loaded.trust.policy = 'untrusted-policy';
      },
    ],
    [
      'wrong trust package',
      (loaded) => {
        loaded.trust.packageId = MATERIALIZATION_ID;
      },
    ],
    [
      'wrong trust materialization',
      (loaded) => {
        loaded.trust.materializationId = PACKAGE_ID;
      },
    ],
    [
      'wrong package target',
      (loaded) => {
        loaded.package.target = 'linux-x64';
      },
    ],
    [
      'missing package pin',
      (loaded) => {
        delete loaded.package.packageId;
      },
    ],
    [
      'relative release directory',
      (loaded) => {
        loaded.directory = 'relative';
      },
    ],
    [
      'different binary path',
      (loaded) => {
        loaded.binaryPath = join(root, 'different-binary');
      },
    ],
    [
      'malformed version',
      (loaded) => {
        loaded.package.version = 'v2.9.0';
      },
    ],
    [
      'newline in version',
      (loaded) => {
        loaded.package.version = `${VERSION}\n`;
      },
    ],
    [
      'newline in package digest',
      (loaded) => {
        loaded.package.packageId += '\n';
        loaded.trust.packageId = loaded.package.packageId;
      },
    ],
  ])('rejects %s before any subprocess', async (_label, change) => {
    const f = await setup();
    change(f.loaded);
    await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_authorization' });
    expect(f.commandRunner).not.toHaveBeenCalled();
    await expect(lstat(f.options.probeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cannot substitute caller trust for fresh authorization', async () => {
    const f = await setup();
    f.loadForExecution.mockRejectedValue(new Error('Synthetic private authorization detail'));
    await expect(
      f.run({ resolution: { ...f.resolution, trust: f.loaded.trust } }),
    ).rejects.toMatchObject({
      code: 'native_probe_authorization',
      message: 'Native initialization package authorization failed',
    });
    expect(f.commandRunner).not.toHaveBeenCalled();
  });

  it.each([
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'win32', arch: 'arm64' },
  ])('rejects unsupported host $platform/$arch before authorization', async (host) => {
    const f = await setup({ host });
    await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_platform' });
    expect(f.loadForExecution).not.toHaveBeenCalled();
    expect(f.commandRunner).not.toHaveBeenCalled();
  });

  it('does not authorize or spawn for a pre-aborted request', async () => {
    const f = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(f.run({ signal: controller.signal })).rejects.toMatchObject({
      code: 'native_probe_invalid',
    });
    expect(f.loadForExecution).not.toHaveBeenCalled();
    expect(f.commandRunner).not.toHaveBeenCalled();
  });

  it.each(['GH_TOKEN', 'AIDLC_GH_BIN', 'HOME', 'AWS_PROFILE'])(
    'rejects signer environment key %s instead of forwarding it',
    async (key) => {
      await expect(
        setup({ signerEnvironment: { [key]: 'synthetic-unapproved-value' } }),
      ).rejects.toMatchObject({
        code: 'native_probe_invalid',
      });
    },
  );

  it.each(['public directory', 'symlink'])('rejects a %s as the evidence root', async (kind) => {
    const f = await setup();
    if (kind === 'public directory') {
      await mkdir(f.options.probeRoot, { mode: 0o700 });
      await chmod(f.options.probeRoot, 0o755);
    } else {
      const target = join(root, 'other-private-root');
      await mkdir(target, { mode: 0o700 });
      await symlink(target, f.options.probeRoot);
    }
    await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_storage' });
    expect(f.commandRunner).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing summary evidence record', async () => {
    const f = await setup();
    let summaryPath;
    f.inspectInitialization.mockImplementation(async ({ projectDirectory }) => {
      summaryPath = join(dirname(dirname(projectDirectory)), 'evidence/summary.json');
      await put(summaryPath, 'Synthetic pre-existing evidence\n');
      return syntheticInspection();
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_storage' });
    expect(await readFile(summaryPath, 'utf8')).toBe('Synthetic pre-existing evidence\n');
  });

  it('uses the real inspector against synthetic on-disk initialization for all four harnesses', async () => {
    const f = await setup({ realInspection: true });
    const report = await f.run();
    expect(report.status).toBe('passed');
    for (const harness of report.harnesses) {
      expect(harness.filesystem.ok).toBe(true);
      expect(harness.filesystem.checks.every(({ status }) => status === 'passed')).toBe(true);
      expect(await readFile(join(harness.projectDirectory, '.aidlc-version'), 'utf8')).toBe(
        `${VERSION}\n`,
      );
      expect(
        await jsonFile(join(evidenceDirectory(report), `${harness.harness}-filesystem.json`)),
      ).toEqual(harness.filesystem);
    }
    expect(report.workflowExecution).toBe('not-tested');
  });

  it('real inspection rejects a mismatched project pin while preserving the other harness results', async () => {
    const f = await setup({
      realInspection: true,
      onCommand: async (_command, { stage, harness, project }) => {
        if (stage === 'doctor' && harness === 'claude') {
          await put(join(project, '.aidlc-version'), '2.8.0\n');
        }
      },
    });
    const report = await f.run();
    expect(report.status).toBe('failed');
    expect(report.harnesses[0].filesystem.checks).toContainEqual({
      id: 'version-pin',
      status: 'failed',
      message: expect.any(String),
    });
    expect(report.harnesses.slice(1).every(({ status }) => status === 'passed')).toBe(true);
  });

  it('an inspector error fails that harness and is stored without its private exception', async () => {
    const f = await setup();
    f.inspectInitialization.mockRejectedValueOnce(new Error('Synthetic private inspector token'));
    const report = await f.run();
    expect(report.status).toBe('failed');
    const saved = await jsonFile(join(evidenceDirectory(report), 'claude-filesystem.json'));
    expect(saved.ok).toBe(false);
    expect(JSON.stringify(saved)).not.toContain('private inspector token');
    expect(report.harnesses.slice(1).every(({ status }) => status === 'passed')).toBe(true);
  });
});

describe('synthetic signer environment from trusted package loading', () => {
  const repository = 'selected-owner/native-workflows';
  const issuer = 'https://token.actions.githubusercontent.com';
  const reusableWorkflow = 'build-owner/reusable/.github/workflows/publish.yaml';
  const source = (provider = 'github', version = VERSION) => ({
    provider,
    repository,
    release: `v${version}`,
    commit: 'c'.repeat(40),
  });
  // These are trusted loader test doubles, not cryptographic verification.
  const verifiedSignature = (subject = reusableWorkflow) => ({
    status: 'verified',
    signer: { issuer, subject },
  });
  const expectSignerEnvironment = (f, expected) => {
    expect(f.commandRunner).toHaveBeenCalledTimes(18);
    for (const [command] of f.commandRunner.mock.calls) {
      expect(
        Object.fromEntries(
          Object.entries(command.env).filter(([key]) => key.startsWith('AIDLC_RELEASE_')),
        ),
      ).toEqual(expected);
    }
  };

  it.each([
    `${repository}/.github/workflows/custom-release.yml`,
    `github.com/${repository}/.github/workflows/custom-release.yml`,
    reusableWorkflow,
    `github.com/${reusableWorkflow}`,
  ])('derives the selected repository and verified workflow %s', async (subject) => {
    const f = await setup();
    f.loaded.package.source = source();
    f.loaded.trust.signature = verifiedSignature(subject);
    const report = await f.run();
    expect(report.status).toBe('passed');
    expectSignerEnvironment(f, {
      AIDLC_RELEASE_REPOSITORY: repository,
      AIDLC_RELEASE_WORKFLOW: subject.replace(/^github\.com\//, ''),
    });
  });

  it.each([
    [VERSION, 'release.yml'],
    ['2.9.0-preview.20260918.1', 'preview-release.yml'],
  ])('uses the source default for an absent signature on %s', async (version, workflow) => {
    const f = await setup({
      onCommand: (_command, { stage, value }) => {
        if (stage === 'version')
          return output({ ...value, binaryVersion: version, runtimeVersion: version });
        if (['install', 'pin', 'configure'].includes(stage))
          return output({ ...value, data: { ...value.data, version } });
      },
    });
    f.loaded.package.source = source('github', version);
    f.loaded.package.version = version;
    f.loaded.trust.signature = { status: 'absent' };
    const report = await f.run();
    expect(report.status).toBe('passed');
    expectSignerEnvironment(f, {
      AIDLC_RELEASE_REPOSITORY: repository,
      AIDLC_RELEASE_WORKFLOW: `${repository}/.github/workflows/${workflow}`,
    });
  });

  it.each([
    ['missing signature', undefined],
    ['failed signature', { status: 'failed' }],
    ['missing verified signer', { status: 'verified' }],
    ['null verified signer', { status: 'verified', signer: null }],
    ['missing issuer', { status: 'verified', signer: { subject: reusableWorkflow } }],
    [
      'foreign issuer',
      { status: 'verified', signer: { issuer: 'https://gitlab.com', subject: reusableWorkflow } },
    ],
    [
      'issuer prefix lookalike',
      {
        status: 'verified',
        signer: {
          issuer: `${issuer}.untrusted.invalid`,
          subject: reusableWorkflow,
        },
      },
    ],
    [
      'issuer with trailing slash',
      { status: 'verified', signer: { issuer: `${issuer}/`, subject: reusableWorkflow } },
    ],
    ['missing subject', { status: 'verified', signer: { issuer } }],
    ['non-string subject', verifiedSignature({ workflow: reusableWorkflow })],
    ['URL-shaped subject', verifiedSignature(`https://github.com/${reusableWorkflow}`)],
    ['subject with a git ref', verifiedSignature(`${reusableWorkflow}@refs/heads/main`)],
    ['subject with query data', verifiedSignature(`${reusableWorkflow}?token=synthetic`)],
    ['subject with traversal', verifiedSignature('owner/../.github/workflows/release.yml')],
    ['subject outside workflows', verifiedSignature('owner/repo/scripts/release.yml')],
    ['subject with newline', verifiedSignature(`${reusableWorkflow}\n`)],
  ])('denies %s before any command or evidence directory creation', async (_label, signature) => {
    const f = await setup();
    f.loaded.package.source = source();
    f.loaded.trust.signature = signature;
    await expect(f.run()).rejects.toMatchObject({
      code: 'native_probe_authorization',
      message: 'Native initialization package authorization failed',
    });
    expect(f.loadForExecution).toHaveBeenCalledTimes(1);
    expect(f.commandRunner).not.toHaveBeenCalled();
    expect(f.inspectInitialization).not.toHaveBeenCalled();
    await expect(lstat(f.options.probeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(
    ['verified', 'absent'].flatMap((status) => [
      [status, 'repository', { AIDLC_RELEASE_REPOSITORY: 'different-owner/native-workflows' }],
      [
        status,
        'workflow',
        { AIDLC_RELEASE_WORKFLOW: 'different-owner/repo/.github/workflows/release.yml' },
      ],
    ]),
  )('denies a conflicting host %s signature %s override', async (status, _field, configured) => {
    const f = await setup({ signerEnvironment: configured });
    f.loaded.package.source = source();
    f.loaded.trust.signature = status === 'verified' ? verifiedSignature() : { status };
    await expect(f.run()).rejects.toMatchObject({ code: 'native_probe_authorization' });
    expect(f.commandRunner).not.toHaveBeenCalled();
    expect(f.inspectInitialization).not.toHaveBeenCalled();
    await expect(lstat(f.options.probeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['', 'github.com/'])(
    'accepts matching host values and normalizes workflow prefix "%s"',
    async (prefix) => {
      const f = await setup({
        signerEnvironment: {
          AIDLC_RELEASE_REPOSITORY: repository,
          AIDLC_RELEASE_WORKFLOW: `${prefix}${reusableWorkflow}`,
        },
      });
      f.loaded.package.source = source();
      f.loaded.trust.signature = verifiedSignature(`github.com/${reusableWorkflow}`);
      expect((await f.run()).status).toBe('passed');
      expectSignerEnvironment(f, {
        AIDLC_RELEASE_REPOSITORY: repository,
        AIDLC_RELEASE_WORKFLOW: reusableWorkflow,
      });
    },
  );

  it.each(
    ['gitlab', 'bitbucket'].flatMap((provider) =>
      ['verified', 'absent'].map((status) => [provider, status]),
    ),
  )('does not infer GitHub environment for %s with a %s signature', async (provider, status) => {
    const f = await setup();
    f.loaded.package.source = source(provider);
    f.loaded.trust.signature = status === 'verified' ? verifiedSignature() : { status };
    expect((await f.run()).status).toBe('passed');
    expectSignerEnvironment(f, {});
  });

  it('preserves explicit host configuration for the earlier source-less loader fixture', async () => {
    const configured = {
      AIDLC_RELEASE_REPOSITORY: 'explicit-owner/approved',
      AIDLC_RELEASE_WORKFLOW: 'github.com/explicit-owner/approved/.github/workflows/publish.yml',
    };
    const f = await setup({ signerEnvironment: configured });
    expect(f.loaded.package).not.toHaveProperty('source');
    expect((await f.run()).status).toBe('passed');
    expectSignerEnvironment(f, configured);
  });
});
