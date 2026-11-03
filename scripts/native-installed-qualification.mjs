// Runs only inside the matrix's disposable, network-disabled container.
// Real CLI/package and EFS protocol; in-memory AWS ports and inert model replies.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeExecutionInvocation } from '../lambda/agentcore/native/executor.js';
import { runNativeCommand } from '../lambda/agentcore/native/command-runner.js';
import { createNativeTurnOutput } from '../lambda/agentcore/native/turn-output.js';
import {
  prepareQualificationPackage,
  prepareQualificationOpenCodeCache,
} from './native-qualification-package.mjs';
import {
  qualificationProvider,
  localProviderInvocation,
} from './native-qualification-provider.mjs';
import { qualifyKiro } from './native-qualification-kiro.mjs';
import {
  qualifyClaudeWorkspaceProtocol,
  qualifyWorkspaceTransport,
} from './native-workspace-protocol-qualification.mjs';

const harness = process.argv[2];
const versionArgument = {
  claude: 'CLAUDE_CODE_VERSION',
  codex: 'CODEX_VERSION',
  opencode: 'OPENCODE_VERSION',
  kiro: 'KIRO_CLI_VERSION',
};
assert.ok(Object.hasOwn(versionArgument, harness), 'Select an installed CLI');
const dockerfile = await fs.readFile(
  new URL('../lambda/agentcore/Dockerfile', import.meta.url),
  'utf8',
);
const expectedVersion = dockerfile.match(
  new RegExp(`^ARG ${versionArgument[harness]}=(.+)$`, 'm'),
)?.[1];
assert.ok(expectedVersion, 'Pinned runtime CLI version');
const base = await fs.mkdtemp('/tmp/native-installed-');
const root = join(base, 'runtime');
const report = (value) => console.log(JSON.stringify({ harness, ...value }));
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

let provider;
let lifecycleFailed = false;
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
    expectedVersion,
    'Pinned installed version',
  );
  report({
    probe: 'version',
    version: expectedVersion,
    node: process.version,
  });
  phase = 'login-shell-workflow-dispatch';
  const launcher = await runNativeCommand({
    command: '/bin/bash',
    args: ['-lc', 'command -v aidlc'],
    cwd: base,
    env: { HOME: versionHome, PATH: '/usr/bin:/bin' },
    timeoutMs: 10_000,
  });
  assert.equal(launcher.exitCode, 0, 'Workflow dispatcher survives login-shell PATH reset');
  assert.equal(launcher.stdout.trim(), '/usr/local/bin/aidlc');
  const unconfigured = await runNativeCommand({
    command: '/usr/local/bin/aidlc',
    args: ['--version'],
    cwd: base,
    env: { HOME: versionHome, PATH: '/usr/bin:/bin' },
    timeoutMs: 10_000,
  });
  assert.equal(unconfigured.exitCode, 127, 'No implicit installation or unpinned workflow');
  report({ probe: 'login-shell-workflow-dispatch', status: 'PASS', unconfiguredRejected: true });
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
    phase = 'kiro-provider';
    report(await qualifyKiro({ base, pkg, report }));
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
    await provider.close();
    provider = undefined;
    // Each EFS scenario owns its own attested installation within the bounded tmpfs.
    await fs.rm(base, { recursive: true, force: true });
    phase = 'upstream-workspace-resume';
    if (harness === 'claude') await qualifyClaudeWorkspaceProtocol({ composed: true });
    else await qualifyWorkspaceTransport(harness);
    report({ status: lifecycleFailed ? 'FAIL' : 'PASS' });
    if (lifecycleFailed) process.exitCode = 1;
  }
} catch (error) {
  report({ status: 'FAIL', phase, code: error.code ?? error.name, check: error.operator });
  process.exitCode = 1;
} finally {
  await provider?.close();
  await fs.rm(base, { recursive: true, force: true });
}
