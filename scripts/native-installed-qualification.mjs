// Runs only inside the matrix's disposable, network-disabled container.
// Real CLI/package/executor/controller; in-memory AWS ports, inert model replies.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createNativeExecutor,
  nativeExecutionInvocation,
} from '../lambda/agentcore/native/executor.js';
import { createNativeExecutionPorts } from '../lambda/agentcore/native/execution-prepare.js';
import { snapshotNativeExecutionFiles } from '../lambda/agentcore/native/execution-files.js';
import { runNativeCommand } from '../lambda/agentcore/native/command-runner.js';
import { createNativeTurnOutput } from '../lambda/agentcore/native/turn-output.js';
import {
  captureNativeSessionRecovery,
  restoreNativeSessionRecovery,
  NATIVE_RECOVERY_HARNESS_VERSIONS,
} from '../lambda/agentcore/native/session-recovery-files.js';
import { createNativePublications } from '../lambda/shared/native-publication.js';
import { createNativeInteractions } from '../lambda/shared/native-interaction.js';
import { createNativeRecoveryCheckpoints } from '../lambda/shared/native-recovery-checkpoint.js';
import { createNativeExecutionFence } from '../lambda/shared/native-execution-fence.js';
import { nativeAnswerText } from '../lambda/shared/native-pending-input.js';
import { createNativeExecutionSupervisor } from '../lambda/native-runtime-control/execution-worker.js';
import { createNativeExecutionApi } from '../lambda/native-runtime-control/execution-api.js';
import { executionIdentity } from '../lambda/native-runtime-control/execution-runtime.js';
import { executionFixture } from '../lambda/native-runtime-control/test/execution-fixtures.js';
import { memoryNativeObjects } from '../lambda/native-runtime-control/test/memory-objects.js';
import { ACTOR } from '../lambda/native-runtime-control/test/fixtures.js';
import {
  prepareQualificationPackage,
  prepareQualificationOpenCodeCache,
  verifyQualificationOpenCodeDependencies,
} from './native-qualification-package.mjs';
import {
  qualificationProvider,
  localProviderInvocation,
} from './native-qualification-provider.mjs';

const harness = process.argv[2];
assert.ok(Object.hasOwn(NATIVE_RECOVERY_HARNESS_VERSIONS, harness), 'Select an installed CLI');
const base = await fs.mkdtemp('/tmp/native-installed-');
const root = join(base, 'runtime');
const homeRoot = join(base, 'homes');
const project = join(root, 'project');
const report = (value) => console.log(JSON.stringify({ harness, ...value }));
let historyProbes = 0;
let dependencyEnv = {};
const binary = {
  claude: '/usr/local/bin/claude',
  codex: '/usr/local/bin/codex',
  opencode: '/opt/opencode/bin/opencode',
  kiro: '/opt/kiro/bin/kiro-cli',
}[harness];
const model = {
  claude: 'claude-sonnet-4-6',
  codex: 'fixture-test',
  opencode: 'fixture/test',
  kiro: null,
}[harness];

async function codexHistory({ directory, env, provider, sessionId, forkId, createFork }) {
  historyProbes++;
  const started = performance.now();
  const providerRequests = provider.result().requests.length;
  const result = await runNativeCommand({
    command: process.execPath,
    args: [join(import.meta.dirname, 'native-qualification-codex.mjs')],
    cwd: directory,
    env,
    stdin: JSON.stringify({ project: directory, url: provider.url, sessionId, forkId, createFork }),
    timeoutMs: 30_000,
  });
  assert.equal(result.cleanupComplete, true);
  const evidence = result.stdout ? JSON.parse(result.stdout) : {};
  if (result.exitCode !== 0 || evidence.error)
    throw Object.assign(new Error('Installed Codex pagination/fork helper'), {
      code: evidence.error ?? 'native_qualification_codex_paging_failed',
      operator: evidence.check ?? 'no-report',
    });
  assert.equal(
    provider.result().requests.length,
    providerRequests,
    'Pagination/fork makes no provider call',
  );
  report({
    probe: 'codex-history-inspection',
    operation: createFork ? 'fork-and-page' : 'resume-and-page',
    elapsedMs: Math.round(performance.now() - started),
    rpcRequests: evidence.requests,
    providerRequests: 0,
  });
  return evidence;
}

async function codexLayout(home, directory) {
  const sessionRoot = join(home, '.codex/sessions');
  const layout = [];
  for (const path of await fs.readdir(sessionRoot, { recursive: true })) {
    if (!path.endsWith('.jsonl')) continue;
    const rows = (await fs.readFile(join(sessionRoot, path), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    const meta = rows[0].payload;
    layout.push({
      id: meta.id,
      sessionId: meta.session_id,
      parent: meta.parent_thread_id ?? meta.forked_from_id,
      historyMode: meta.history_mode,
      historyBase: meta.history_base,
      filenameMatches: path.endsWith(`-${meta.id}.jsonl`),
      cwdMatches: meta.cwd === directory,
      firstOrdinal: rows[0].ordinal,
      lastOrdinal: rows.at(-1).ordinal,
      records: rows.length,
    });
  }
  report({ probe: 'codex-layout', layout });
}

async function protocolJourney(provider, directory, home) {
  let nativeSessionId;
  let restored = false;
  const env = {
    ...dependencyEnv,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    XDG_DATA_HOME: join(home, '.data'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    PATH: '/opt/opencode/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin',
  };
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(join(home, '.codex'), { recursive: true, mode: 0o700 });
  for (let turn = 1; turn <= 3; turn++) {
    provider.begin({
      turn,
      command: turn === 2 ? 'mkdir -p nested && cd nested && pwd' : null,
      expectedAnswer: turn > 1 ? `Fixture answer ${turn - 1}.` : null,
      expectedHistory:
        harness === 'codex' && turn === 3
          ? ['Fixture question 1?', 'Fixture question 2?', 'Fixture answer 1.']
          : [],
    });
    const output = createNativeTurnOutput({ harness, nativeSessionId });
    const input = localProviderInvocation(
      harness,
      {
        ...nativeExecutionInvocation({
          harness,
          model,
          project: directory,
          nativeSessionId,
          prompt: turn === 1 ? 'Present fixture question.' : `Fixture answer ${turn - 1}.`,
        }),
        env,
      },
      provider.url,
    );
    const started = performance.now();
    const result = await runNativeCommand({
      ...input,
      cwd: directory,
      timeoutMs: 30_000,
      onStdoutChunk: (chunk) => output.write(chunk),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupComplete, true);
    const completed = output.finish();
    nativeSessionId ??= completed.nativeSessionId;
    assert.equal(completed.nativeSessionId, nativeSessionId);
    assert.deepEqual(completed.messages, [{ type: 'text', text: `Fixture question ${turn}?` }]);
    const observations = provider.result();
    assert.equal(observations.toolSent, turn === 2);
    assert.equal(
      observations.requests.filter((sample) => sample.primary).length,
      turn === 2 ? 2 : 1,
    );
    report({
      probe: 'installed-session',
      tier: 'CLI without workflow package',
      turn,
      elapsedMs: Math.round(performance.now() - started),
      ...observations,
    });
    if (turn !== 2) continue;
    const paging =
      harness === 'codex'
        ? await codexHistory({
            directory,
            env,
            provider,
            sessionId: nativeSessionId,
            createFork: true,
          })
        : null;
    if (paging) await codexLayout(home, directory);
    const checkpoint = await captureNativeSessionRecovery({
      project: directory,
      home,
      harness,
      nativeSessionId,
    });
    const restoreStarted = performance.now();
    for (const target of [directory, home])
      for (const entry of await fs.readdir(target))
        await fs.rm(join(target, entry), { recursive: true, force: true });
    if (paging) {
      const rootRollout = checkpoint.files.find(
        (file) => file.scope === 'home' && file.path.endsWith(`-${nativeSessionId}.jsonl`),
      );
      assert.ok(rootRollout);
      await assert.rejects(
        restoreNativeSessionRecovery({
          project: directory,
          home,
          harness,
          nativeSessionId,
          ...checkpoint,
          files: checkpoint.files.filter((file) => file !== rootRollout),
        }),
        { code: 'native_recovery_session_missing' },
      );
      const rows = rootRollout.content.toString('utf8').trim().split('\n').map(JSON.parse);
      rows.splice(1, 1); // A missing ordinal inside the actual installed history.
      const content = Buffer.from(`${rows.map((value) => JSON.stringify(value)).join('\n')}\n`);
      await assert.rejects(
        restoreNativeSessionRecovery({
          project: directory,
          home,
          harness,
          nativeSessionId,
          ...checkpoint,
          files: checkpoint.files.map((file) =>
            file === rootRollout
              ? {
                  ...file,
                  content,
                  bytes: content.length,
                  sha256: createHash('sha256').update(content).digest('hex'),
                }
              : file,
          ),
        }),
        { code: 'native_recovery_session_invalid' },
      );
      assert.deepEqual(await fs.readdir(home), [], 'Rejected history writes nothing');
      report({
        probe: 'codex-history-corruption',
        status: 'PASS',
        missingParentRejected: true,
        missingOrdinalRejected: true,
        tier: 'production recovery with mutated installed capture',
      });
    }
    try {
      await restoreNativeSessionRecovery({
        project: directory,
        home,
        harness,
        nativeSessionId,
        ...checkpoint,
      });
    } catch (error) {
      if (harness === 'opencode') {
        const exported = await runNativeCommand({
          command: binary,
          args: ['export', nativeSessionId, '--pure'],
          cwd: directory,
          env,
          timeoutMs: 10000,
        });
        const actual = JSON.parse(exported.stdout);
        const expected = JSON.parse(checkpoint.files.find((file) => file.scope === 'home').content);
        report({
          probe: 'restore-comparison',
          sameSession: actual.info?.id === nativeSessionId,
          sameDirectory: actual.info?.directory === directory,
          equalMessages: isDeepStrictEqual(actual.messages, expected.messages),
          identicalSerialization:
            JSON.stringify(actual.messages) === JSON.stringify(expected.messages),
        });
      }
      throw error;
    }
    if (paging) {
      const restoredPaging = await codexHistory({
        directory,
        env,
        provider,
        sessionId: nativeSessionId,
        forkId: paging.forkId,
      });
      assert.deepEqual(
        restoredPaging.root,
        paging.root,
        'Exact root pages after rebuilding SQLite',
      );
      assert.deepEqual(
        restoredPaging.inherited,
        paging.inherited,
        'Exact inherited pages after rebuilding SQLite',
      );
      report({
        probe: 'codex-history-pages',
        status: 'PASS',
        rootPages: paging.root.pages,
        inheritedPages: paging.inherited.pages,
        rebuiltWithoutSQLite: true,
      });
    }
    restored = true;
    report({
      probe: 'installed-session-restore',
      status: 'PASS',
      files: checkpoint.files.length,
      bytes: checkpoint.files.reduce((n, file) => n + file.bytes, 0),
      elapsedMs: Math.round(performance.now() - restoreStarted),
    });
  }
  report({ probe: 'installed-session-continuation', status: 'PASS', turns: 3, restored });
}

let provider;
let runtime;
let row;
let lifecycleFailed = false;
let protocolFailed = false;
let phase = 'version';
try {
  const versionHome = join(base, 'version-home');
  await fs.mkdir(versionHome);
  const version = await runNativeCommand({
    command: binary,
    args: ['--version'],
    cwd: base,
    env: {
      HOME: versionHome,
      XDG_DATA_HOME: `${versionHome}/.data`,
      PATH: '/usr/local/bin:/usr/bin:/bin',
    },
    timeoutMs: 10_000,
  });
  assert.equal(version.exitCode, 0, 'Installed CLI version command');
  assert.equal(
    version.stdout.match(/(?:^|\s)(\d+\.\d+\.\d+)(?=\s|$)/)?.[1],
    NATIVE_RECOVERY_HARNESS_VERSIONS[harness],
    'Pinned installed version',
  );
  report({
    probe: 'version',
    version: NATIVE_RECOVERY_HARNESS_VERSIONS[harness],
    node: process.version,
  });
  phase = 'package-assets';
  await fs.mkdir(root, { mode: 0o700 });
  const pkg = await prepareQualificationPackage(root, process.env.NATIVE_QUALIFICATION_PACKAGE);
  if (harness === 'opencode') {
    const started = performance.now();
    dependencyEnv = await prepareQualificationOpenCodeCache(
      root,
      process.env.NATIVE_QUALIFICATION_OPENCODE_CACHE,
    );
    report({
      probe: 'opencode-cache',
      elapsedMs: Math.round(performance.now() - started),
      verifiedArtifacts: 32,
    });
  }
  if (harness === 'kiro') {
    // Do not use undocumented KIRO_MOCK_CHAT_RESPONSE/test-engine switches or
    // substitute an ACP peer for the installed CLI's authenticated v2 provider.
    phase = 'kiro-provider';
    const input = nativeExecutionInvocation({
      harness,
      model,
      project: base,
      prompt: 'Present fixture question.',
    });
    const result = await runNativeCommand({
      ...input,
      cwd: base,
      env: {
        HOME: versionHome,
        KIRO_HOME: `${versionHome}/.kiro`,
        XDG_DATA_HOME: `${versionHome}/.data`,
        PATH: '/opt/kiro/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin',
        KIRO_API_KEY: 'fixture-no-provider',
        KIRO_NO_AUTO_UPDATE: '1',
        KIRO_DISABLE_TELEMETRY: '1',
      },
      timeoutMs: 15_000,
    });
    assert.equal(result.cleanupComplete, true);
    const frames = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
    const terminal = frames.at(-1);
    assert.ok(
      result.timedOut || terminal?.ok === false,
      'Inert authentication cannot complete a Kiro model turn',
    );
    report({
      status: 'BLOCKED',
      probe: 'installed-v2-provider',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      protocolPhase: terminal?.protocolPhase ?? 'no-terminal-report',
      protocolFailure: terminal?.protocolFailure,
      transportFailure: terminal?.transportFailure,
      rpcErrorCode: terminal?.rpcErrorCode,
      cleanupComplete: true,
      boundary:
        'No supported deterministic local v2 provider configuration established; bounded inert-key ACP invocation produced no completed turn. Internal mock/KAS engine switches do not qualify native v2.',
    });
    process.exitCode = 2;
  } else {
    provider = await qualificationProvider(harness);
    const failureProject = join(base, 'failure-project');
    const failureHome = join(base, 'failure-home');
    await fs.mkdir(failureProject);
    await fs.mkdir(join(failureHome, '.codex'), { recursive: true });
    const failureEnv = {
      ...dependencyEnv,
      HOME: failureHome,
      CODEX_HOME: join(failureHome, '.codex'),
      CLAUDE_CONFIG_DIR: join(failureHome, '.claude'),
      XDG_DATA_HOME: join(failureHome, '.data'),
      XDG_CONFIG_HOME: join(failureHome, '.config'),
      XDG_CACHE_HOME: join(failureHome, '.cache'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      PATH: '/opt/opencode/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin',
    };
    // Independent installed failure turns: no authority is granted to their
    // output. The existing composed suite checks durable failure persistence.
    for (const mode of ['failed', 'incomplete', 'cancel']) {
      phase = mode;
      const controller = new AbortController();
      let diagnostic;
      const output = createNativeTurnOutput({
        harness,
        onDiagnostic: (value) => {
          diagnostic ??= value;
        },
      });
      const marker = join(base, 'descendant.pid');
      const command =
        mode === 'cancel'
          ? `node -e 'require("fs").writeFileSync("${marker}",String(process.pid));setInterval(()=>{},1000)'`
          : null;
      provider.begin({ turn: 4, mode: mode === 'cancel' ? 'normal' : mode, command });
      const input = localProviderInvocation(
        harness,
        {
          ...nativeExecutionInvocation({
            harness,
            prompt: 'Run bounded failure fixture.',
            model,
            project: failureProject,
          }),
          env: failureEnv,
        },
        provider.url,
      );
      const pending = runNativeCommand({
        ...input,
        cwd: failureProject,
        timeoutMs: 15_000,
        signal: controller.signal,
        onStdoutChunk: (chunk) => output.write(chunk),
      });
      if (mode === 'cancel') {
        let pid;
        for (let n = 0; n < 100 && !pid; n++) {
          try {
            pid = Number(await fs.readFile(marker, 'utf8'));
          } catch {
            await delay(100);
          }
        }
        const topology = [];
        for (
          let ancestor = pid;
          ancestor > 1 && ancestor !== process.pid && topology.length < 16;
        ) {
          const stat = await fs.readFile(`/proc/${ancestor}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          topology.push({
            pid: ancestor,
            ppid: Number(fields[1]),
            group: Number(fields[2]),
            session: Number(fields[3]),
          });
          ancestor = Number(fields[1]);
        }
        assert.ok(
          new Set(topology.map((item) => item.group)).size > 1,
          'The installed tool actually runs outside its launcher process group',
        );
        controller.abort();
        const stopped = await pending;
        assert.ok(pid > 1, 'Installed tool actually launched a descendant');
        assert.equal(stopped.cleanupComplete, true);
        let descendantGone = false;
        let descendantState;
        for (let n = 0; n < 38; n++) {
          try {
            const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
            descendantState = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            descendantGone = true;
            break;
          }
          await delay(20);
        }
        if (!descendantGone) lifecycleFailed = true;
        assert.throws(() => output.finish(), 'cancelled stream must remain incomplete');
        report({
          probe: mode,
          status: descendantGone ? 'PASS' : 'FAIL',
          descendantGone,
          descendantState,
          runnerCleanupComplete: stopped.cleanupComplete,
          topology,
          diagnostic,
        });
      } else {
        const failed = await pending;
        assert.equal(failed.cleanupComplete, true);
        assert.throws(() => output.finish(), 'Invalid installed stream must not publish');
        const observations = provider.result();
        if (mode === 'incomplete') assert.equal(observations.incompleteSent, true);
        assert.ok(diagnostic, 'First rejection retained');
        report({
          probe: mode,
          status: 'PASS',
          exitCode: failed.exitCode,
          timedOut: failed.timedOut,
          requestCount: observations.requests.length,
          incompleteSent: observations.incompleteSent,
          diagnostic,
        });
      }
    }
    phase = 'installed-session';
    if (harness !== 'claude') {
      try {
        await protocolJourney(provider, join(base, 'session-project'), join(base, 'session-home'));
      } catch (error) {
        protocolFailed = true;
        report({
          probe: 'installed-session',
          status: 'FAIL',
          code: error.code ?? error.name,
          check: error.operator,
        });
      }
    }
    phase = 'composed-journey';
    const f = executionFixture({ harness, model });
    f.prepared.candidate.packagePin.version = pkg.version;
    await f.start();
    row = f.row();
    const storage = {
      bucket: f.configuration.publicationBucket,
      accountId: f.configuration.accountId,
      s3: memoryNativeObjects({
        bucket: f.configuration.publicationBucket,
        accountId: f.configuration.accountId,
      }).s3,
    };
    const publications = createNativePublications(storage);
    const interactions = createNativeInteractions(storage);
    const checkpoints = createNativeRecoveryCheckpoints(storage);
    const fence = createNativeExecutionFence(storage);
    const env = {
      NATIVE_RUNTIME_MODE: 'isolated',
      NATIVE_EXECUTION_ENABLED: 'true',
      NATIVE_RUNTIME_PROJECT_ID: row.scope.projectId,
      NATIVE_RUNTIME_EXECUTION_ID: row.scope.executionId,
      NATIVE_RUNTIME_BINDING_ID: row.bindingId,
      NATIVE_EXECUTION_ATTEMPT_ID: row.attemptId,
      NATIVE_EXECUTION_RUNTIME_SESSION_ID: row.runtimeSessionId,
      NATIVE_EXECUTION_EPOCH: '1',
      NATIVE_EXECUTION_IMAGE_DIGEST: f.configuration.image.digest,
      NATIVE_PUBLICATION_BUCKET: storage.bucket,
      NATIVE_RUNTIME_ACCOUNT_ID: storage.accountId,
    };
    let turns = 0;
    const priorHistoryProbes = historyProbes;
    let setups = 0;
    let workspaceScans = 0;
    let captured;
    let lastInput;
    let latestAnswer;
    let lostAck = false;
    let lostAdmissionAck = false;
    let paging;
    let coldRestored = false;
    const coldRecovery = ['codex', 'opencode'].includes(harness);
    const recoveryAcks = [];
    const controls = [];
    const observedStore = {
      ...f.store,
      async publish(input) {
        const result = await f.store.publish(input);
        if (turns === 2 && !lostAdmissionAck) {
          lostAdmissionAck = true;
          throw new Error('fixture admission acknowledgement lost');
        }
        return result;
      },
    };
    const createRuntime = () =>
      createNativeExecutor({
        env,
        root,
        homeRoot,
        ...createNativeExecutionPorts({ env, s3: storage.s3 }),
        inspectMount: async () => ({}), // No EFS claim; real tmpfs filesystem below.
        prepare: async () => ({
          package: { ...pkg, packageId: f.configuration.packageId },
          repositoryCommit: 'c'.repeat(40),
          authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'fixture-model-token' },
        }),
        prepareRecovery: async () => ({
          package: { ...pkg, packageId: f.configuration.packageId },
        }),
        restoreRecovery: async (input) => {
          phase = 'cold-restore';
          assert.equal(coldRestored, false, 'Recovery retry must not restore twice');
          const restored = await restoreNativeSessionRecovery(input);
          if (harness === 'opencode') {
            const lockRoot = join(input.home, '.local/state/opencode/locks');
            const locks = await fs.readdir(lockRoot).catch((error) => {
              if (error.code === 'ENOENT') return [];
              throw error;
            });
            const transientStates = (await fs.readdir(input.home)).filter((name) =>
              name.startsWith('.native-recovery-state-'),
            ).length;
            report({
              probe: 'recovery-locks',
              workflowLocks: locks.length,
              transientStateRemoved: transientStates === 0,
            });
            assert.equal(locks.length, 0, 'Metadata commands must not strand workflow locks');
            assert.equal(transientStates, 0, 'Transient recovery command state removed');
          }
          if (harness === 'codex') {
            const after = await codexHistory({
              directory: project,
              env: lastInput.env,
              provider,
              sessionId: input.nativeSessionId,
              forkId: paging.forkId,
            });
            assert.deepEqual(after.root, paging.root);
            assert.deepEqual(after.inherited, paging.inherited);
            report({
              probe: 'cold-restore-pages',
              status: 'PASS',
              beforeTurn: 3,
              verifiedFiles: input.files.length,
              rootPages: after.root.pages,
              inheritedPages: after.inherited.pages,
              rebuiltWithoutSQLite: true,
            });
          } else {
            assert.equal(input.metadata.schemaVersion, 2);
            assert.equal(input.metadata.binLinks.length, 7, 'Actual pinned npm bin links occurred');
            for (const link of input.metadata.binLinks) {
              assert.equal(await fs.readlink(join(project, link.path)), link.target);
              const stat = await fs.lstat(join(project, link.path), { bigint: true });
              assert.equal(stat.isSymbolicLink(), true);
              assert.equal(String(stat.mtimeNs), link.mtimeNs);
            }
            for (const file of input.files.filter((file) => file.scope === 'project'))
              assert.deepEqual(await fs.readFile(join(project, file.path)), file.content);
            report({
              probe: 'cold-restore-bin-links',
              status: 'PASS',
              beforeTurn: 3,
              verifiedFiles: input.files.length,
              exactLinks: input.metadata.binLinks.length,
            });
          }
          coldRestored = true;
          return restored;
        },
        snapshot: async (input) => {
          workspaceScans++;
          return snapshotNativeExecutionFiles(input);
        },
        captureRecovery: async (input) => {
          phase = 'checkpoint-capture';
          if (harness === 'codex' && turns === 2 && !paging)
            paging = await codexHistory({
              directory: project,
              env: lastInput.env,
              provider,
              sessionId: input.nativeSessionId,
              createFork: true,
            });
          const started = performance.now();
          captured = await captureNativeSessionRecovery(input);
          report({
            probe: 'capture',
            turn: turns,
            elapsedMs: Math.round(performance.now() - started),
            files: captured.files.length,
            bytes: captured.files.reduce((n, file) => n + file.bytes, 0),
          });
          return captured;
        },
        commandRunner: async (input) => {
          const invocation = {
            ...input,
            env: { ...input.env, ...dependencyEnv, PATH: `${pkg.tools}:${input.env.PATH}` },
          };
          if (input.timeoutMs !== null) {
            setups++;
            return runNativeCommand(invocation);
          }
          turns++;
          phase = `workflow-turn-${turns}`;
          const command =
            turns === 1
              ? harness === 'opencode'
                ? 'aidlc engine orchestrate next "Build a bounded qualification fixture"'
                : 'aidlc engine orchestrate next "Build a bounded qualification fixture" > .native-control/engine-ask.json && node -e \'const fs=require("fs");const ask=JSON.parse(fs.readFileSync(".native-control/engine-ask.json"));fs.writeFileSync(".native-control/pending-question.json",JSON.stringify({version:3,ask}))\''
              : turns === 2
                ? harness === 'opencode'
                  ? null
                  : 'mkdir -p nested && cd nested && pwd'
                : null;
          provider.begin({
            turn: turns,
            command,
            expectedAnswer: latestAnswer?.text,
            openCodeWorkflow:
              harness === 'opencode' && turns <= 2
                ? turns === 1
                  ? { questionPath: join(project, '.native-control/pending-question.json') }
                  : { writePath: join(project, 'nested/fixture.txt') }
                : undefined,
            expectedHistory:
              coldRecovery && turns === 3 ? ['Fixture question 1?', 'Fixture question 2?'] : [],
          });
          const started = performance.now();
          lastInput = localProviderInvocation(harness, invocation, provider.url);
          const result = await runNativeCommand({ ...lastInput, timeoutMs: 60_000 });
          assert.equal(result.cleanupComplete, true, 'Installed process descendants reaped');
          if (result.exitCode !== 0) {
            report({
              probe: 'command-failure',
              turn: turns,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              requests: provider.result().requests,
              stdoutBytes: Buffer.byteLength(result.stdout),
              stderrBytes: Buffer.byteLength(result.stderr),
            });
          }
          assert.equal(result.exitCode, 0, `Installed turn ${turns} exited unsuccessfully`);
          if (harness === 'opencode') {
            const packages = await verifyQualificationOpenCodeDependencies(
              project,
              lastInput.env.XDG_CONFIG_HOME,
            );
            report({
              probe: 'opencode-dependencies',
              status: 'PASS',
              lockedPackages: packages,
              installedBy: 'pinned CLI Arborist',
              offline: true,
            });
            const toolFrames = result.stdout
              .trim()
              .split('\n')
              .map(JSON.parse)
              .filter((frame) => frame.type === 'tool_use');
            report({
              probe: 'opencode-tool-outcomes',
              tools: toolFrames.map((frame) => ({
                status: frame.part?.state?.status,
                exit: frame.part?.state?.metadata?.exit,
                commandUnavailable: /command not found|aidlc: not found/.test(
                  frame.part?.state?.output ?? '',
                ),
                permissionRejected: /permission|denied/i.test(frame.part?.state?.error ?? ''),
              })),
            });
            assert.ok(
              toolFrames.every((frame) => frame.part?.state?.status === 'completed'),
              'Actual workflow tools must complete without a permission rejection',
            );
            if (turns === 1) {
              const pending = JSON.parse(
                await fs.readFile(join(project, '.native-control/pending-question.json'), 'utf8'),
              );
              assert.deepEqual(
                pending.ask,
                provider.engineAsk(),
                'Published offer came from the real engine',
              );
            } else if (turns === 2) {
              assert.equal(
                await fs.readFile(join(project, 'nested/fixture.txt'), 'utf8'),
                'fixture cwd witness',
              );
            }
            const links = [];
            for (const path of await fs.readdir(join(project, '.opencode/node_modules/.bin'))) {
              const link = join(project, '.opencode/node_modules/.bin', path);
              if ((await fs.lstat(link)).isSymbolicLink())
                links.push({
                  path: `.opencode/node_modules/.bin/${path}`,
                  target: await fs.readlink(link),
                });
            }
            report({ probe: 'opencode-dependency-links', links });
          }
          const observations = provider.result();
          assert.equal(observations.toolSent, turns <= 2, 'Required actual tool variant occurred');
          const primary = observations.requests.filter((sample) => sample.primary);
          assert.equal(
            primary.length,
            harness === 'opencode' && turns === 1 ? 3 : turns <= 2 ? 2 : 1,
            'No repeated primary queries',
          );
          report({
            probe: 'turn',
            turn: turns,
            elapsedMs: Math.round(performance.now() - started),
            ...observations,
            exitCode: result.exitCode,
            cleanupComplete: result.cleanupComplete,
          });
          return result;
        },
      });
    runtime = createRuntime();
    const supervisor = createNativeExecutionSupervisor({
      store: observedStore,
      preparationStore: f.preparationStore,
      now: f.now,
      upgrade: async ({ execution }) => ({ ready: true, target: f.target(execution) }),
      authorize: async () => {},
      credentials: async (execution) => ({
        ok: true,
        ...executionIdentity(execution),
        model: { provider: 'bedrock', value: 'fixture-model-token' },
        git: { username: 'fixture', password: 'fixture-git-token' },
        source: { branch: 'main', commit: 'c'.repeat(40) },
      }),
      invoke: async ({ payload }) => {
        controls.push(payload.command);
        const method = {
          'native-start': 'start',
          'native-continue': 'continue',
          'native-status': 'status',
          'native-recover': 'recover',
        }[payload.command];
        const result = await runtime[method](payload);
        if (payload.command === 'native-recover')
          recoveryAcks.push({
            writerGeneration: payload.writerGeneration,
            recoveryId: payload.recoveryId,
            checkpointId: payload.checkpoint.id,
            duplicate: result.duplicate === true,
          });
        if (payload.command === 'native-continue' && !lostAck) {
          lostAck = true;
          throw new Error('fixture runtime acknowledgement lost');
        }
        return result;
      },
      stop: async ({ execution, recoveryId }) => {
        assert.equal(coldRecovery, true);
        assert.ok(recoveryId);
        assert.equal((await fence.read(executionIdentity(execution))).state, 'FENCED');
        await runtime.settle();
        await fs.rm(homeRoot, { recursive: true, force: true });
        runtime = createRuntime();
        return { confirmed: true, runtimeSessionId: execution.runtimeSessionId };
      },
      publications,
      interactions,
      checkpoints,
      fence,
      project: async () => {},
    });
    const api = createNativeExecutionApi({
      enabled: true,
      store: f.store,
      publications,
      interactions,
      configure: async () => f.configuration,
      enqueue: async () => {},
      authorizeSource: async () => {},
    });
    const settle = async () => {
      for (let n = 0; n < 8; n++) {
        try {
          await supervisor(f.identity);
        } catch (error) {
          if (!/^fixture .* acknowledgement lost$/.test(error.message)) throw error;
          f.tick();
        }
        const result = await runtime.settle();
        if (['failed', 'stopped_needs_review'].includes(result?.status)) {
          report({
            probe: 'runtime-failure',
            code: result.code,
            outputDiagnostic: result.outputDiagnostic,
            initializationChecks: result.initializationChecks,
            recoveryFailureCode: result.recoveryFailureCode,
          });
          throw Object.assign(new Error(result.code), {
            code: result.recoveryFailureCode ?? result.code,
          });
        }
        if (f.row().status === 'AWAITING_USER') return result;
        assert.notEqual(f.row().status, 'FAILED');
      }
      throw new Error('Installed journey did not settle');
    };
    let previousQuestion;
    for (let turn = 1; turn <= 3; turn++) {
      const result = await settle();
      assert.equal(turns, turn);
      assert.equal(
        setups,
        coldRecovery && turn === 3 ? 5 : 3,
        'Only cold recovery rebuilds the two pinned machine projections',
      );
      assert.equal(workspaceScans, turn * 2, 'Exactly baseline and publication workspace scans');
      assert.equal(f.row().recoveryCheckpoint.sequence, turn);
      const question = await api.interaction(f.prepared, async () => {});
      assert.deepEqual(question.messages, [{ type: 'text', text: `Fixture question ${turn}?` }]);
      await checkpoints.read(executionIdentity(f.row()), f.row().recoveryCheckpoint, {
        verifyFiles: true,
      });
      report({
        probe: 'admitted',
        turn,
        timings: result.timings,
        setupProcesses: setups,
        cliProcesses: turns,
        historyInspectionProcesses: historyProbes - priorHistoryProbes,
        commandOwnerProcesses: setups + turns + historyProbes - priorHistoryProbes,
        workspaceScans,
      });
      if (turn === 1) {
        const ask =
          harness === 'opencode'
            ? provider.engineAsk()
            : JSON.parse(
                await fs.readFile(join(project, '.native-control/engine-ask.json'), 'utf8'),
              );
        assert.equal(ask.ask_type, 'compose-offer');
        assert.deepEqual(
          question.pendingInput.questions[0].options.map((o) => o.label),
          ['compose', ...ask.scope_commands.map((entry) => entry.scope)],
        );
        report({
          probe: 'workflow',
          version: pkg.version,
          typedAsk: ask.ask_type,
          options: question.pendingInput.questions[0].options.length,
          provenanceVerified: true,
        });
      }
      if (turn === 2) {
        const home = lastInput.env.HOME;
        const started = performance.now();
        // Preserve the admitted writer's directory identities. Replace all
        // contents from its verified waiting-point snapshot, never replay work.
        for (const directory of [project, home])
          for (const entry of await fs.readdir(directory))
            await fs.rm(join(directory, entry), { recursive: true, force: true });
        if (coldRecovery) {
          await fs.rm(homeRoot, { recursive: true, force: true });
          runtime = createRuntime();
          assert.equal((await runtime.status(executionIdentity(f.row()))).recovered, true);
        } else {
          await restoreNativeSessionRecovery({
            project,
            home,
            harness,
            nativeSessionId: f.row().publication.nativeSessionId,
            ...captured,
          });
          for (const file of captured.files) {
            if (harness === 'opencode' && file.scope === 'home') continue; // Real import/export verifies this below.
            assert.deepEqual(
              await fs.readFile(join(file.scope === 'home' ? home : project, file.path)),
              file.content,
            );
          }
          report({
            probe: 'exact-restore',
            beforeTurn: 3,
            elapsedMs: Math.round(performance.now() - started),
            verifiedFiles: captured.files.length,
          });
        }
      }
      if (turn === 3) break;
      const selection = question.pendingInput ? { answers: [{ selectedOptions: [1] }] } : null;
      latestAnswer = {
        requestId: randomUUID(),
        interactionId: question.id,
        contentSha256: question.contentSha256,
        text: selection
          ? nativeAnswerText(question.pendingInput, selection)
          : `Fixture answer ${turn}.`,
        ...(selection ? { selection } : {}),
      };
      const answer = await api.respond(f.prepared, ACTOR, latestAnswer, async () => {});
      assert.equal(
        (await api.respond(f.prepared, ACTOR, latestAnswer, async () => {})).response.id,
        answer.response.id,
      );
      await assert.rejects(
        api.respond(
          f.prepared,
          'other-member',
          { ...latestAnswer, requestId: randomUUID() },
          async () => {},
        ),
        { code: 'NATIVE_EXECUTION_CONFLICT' },
      );
      if (previousQuestion)
        await assert.rejects(
          api.respond(
            f.prepared,
            ACTOR,
            { ...latestAnswer, interactionId: previousQuestion.id },
            async () => {},
          ),
        );
      previousQuestion = question;
    }
    phase = 'authority-guards';
    assert.ok(lostAck && lostAdmissionAck);
    if (coldRecovery) {
      report({
        probe: 'cold-recovery-identity',
        coldRestored,
        writerGeneration: f.row().writerGeneration,
        sameAttempt: f.row().attemptId === row.attemptId,
        sameEpoch: f.row().epoch === row.epoch,
        recoveryRequests: controls.filter((c) => c === 'native-recover').length,
        continuationRequests: controls.filter((c) => c === 'native-continue').length,
      });
      assert.equal(coldRestored, true);
      assert.equal(f.row().writerGeneration, 2);
      assert.equal(f.row().attemptId, row.attemptId);
      assert.equal(f.row().epoch, row.epoch);
      assert.deepEqual(
        recoveryAcks.map((ack) => ack.duplicate),
        [false, true],
      );
      assert.deepEqual(recoveryAcks[1], { ...recoveryAcks[0], duplicate: true });
    }
    assert.equal(controls.filter((c) => c === 'native-continue').length, 2);
    await api.respond(f.prepared, ACTOR, latestAnswer, async () => {});
    await supervisor(f.identity);
    assert.equal(turns, 3, 'Duplicate answer/pointer never replays installed work');
    report({
      probe: 'authority',
      immutableAnswers: 2,
      lostRuntimeAck: true,
      lostAdmissionAck: true,
      duplicateReplayCount: 0,
      retainedQuestionUnanswered: true,
      writerGeneration: f.row().writerGeneration,
      coldRestored,
    });

    report({
      probe: 'journey',
      status: 'PASS',
      turns: 3,
      restoredBeforeTurn: 3,
      externalProviderCalls: 0,
    });
    report({ status: lifecycleFailed || protocolFailed ? 'FAIL' : 'PASS' });
    if (lifecycleFailed || protocolFailed) process.exitCode = 1;
  }
} catch (error) {
  report({ status: 'FAIL', phase, code: error.code ?? error.name, check: error.operator });
  process.exitCode = 1;
} finally {
  if (runtime?.isBusy()) await runtime.cancel(executionIdentity(row));
  await runtime?.settle();
  await provider?.close();
  await fs.rm(base, { recursive: true, force: true });
}
