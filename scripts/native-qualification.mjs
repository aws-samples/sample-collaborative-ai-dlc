// One finite offline acceptance entrypoint. No provider/model credentials or
// deployed resources are required. Installed components are an explicit tier;
// omission is printed as NOT RUN, never reported as live qualification.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  qualificationOptions,
  installedDockerArgs,
  installedStatus,
} from './native-qualification-options.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = qualificationOptions(process.argv.slice(2));
const run = (label, command, arguments_, cwd = root) => {
  console.log(`\nNative qualification: ${label}`);
  const result = spawnSync(command, arguments_, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: '--no-experimental-webstorage',
      VITEST_MAX_WORKERS: '2',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (!options.installedOnly) {
  const backend = [
    'lambda/native-runtime-control/test/checkpoint-journey.test.js',
    'lambda/native-runtime-control/test/execution-serial-worker.test.js',
    'lambda/native-runtime-control/test/execution-worker.test.js',
    'lambda/native-runtime-control/test/execution-recovery.test.js',
    'lambda/native-runtime-control/test/execution-recovery-worker.test.js',
    'lambda/native-runtime-control/test/recovery-loop.test.js',
    'lambda/native-runtime-control/test/execution-status-retry.test.js',
    'lambda/native-runtime-control/test/execution-legacy-protocol.test.js',
    'lambda/native-runtime-control/test/execution-image-policy.test.js',
    'lambda/native-runtime-control/test/revision-history.test.js',
    'lambda/native-runtime-control/test/activity-store.test.js',
    'lambda/native-runtime-control/test/execution-diagnostics.test.js',
    'lambda/agentcore/test/native-executor.test.js',
    'lambda/agentcore/test/native-activity.test.js',
    'lambda/agentcore/test/native-executor-output.test.js',
    'lambda/agentcore/test/native-pending-question.test.js',
    'lambda/agentcore/test/native-session-recovery-files.test.js',
    'lambda/agentcore/test/native-opencode-recovery-command.test.js',
    'lambda/agentcore/test/native-kiro-acp-turn.test.js',
    'lambda/agentcore/test/native-kiro-acp-client.test.js',
    'lambda/agentcore/test/native-command-runner.test.js',
    'lambda/agentcore/test/native-initialization-evidence.test.js',
    'lambda/native-runtime-control/test/execution-credentials.test.js',
    'lambda/shared/test/native-interaction.test.js',
    'lambda/shared/test/native-publication.test.js',
    'lambda/shared/test/native-pending-input.test.js',
    'lambda/shared/test/native-recovery-checkpoint.test.js',
    'lambda/shared/test/native-execution-fence.test.js',
  ];
  run(
    'production-composed journeys and boundary failures (scripted harness output)',
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.native-foundation.config.js',
      '--maxWorkers=2',
      ...backend,
    ],
  );
  run(
    'rendered forms, collaboration/reconnect, immutable history and legacy API',
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--maxWorkers=2',
      'src/pages/NativeIntentPage.interaction.test.tsx',
      'src/pages/NativeIntentPage.execution.test.tsx',
      'src/components/QuestionEditor.native.test.tsx',
      'src/components/intent/NativeHistoryView.test.tsx',
      'src/services/nativeIntents.interaction.test.ts',
      'src/services/nativeHistory.test.ts',
      'src/lib/nativePendingInput.test.ts',
      'src/components/layout/AppShell.native-collaboration.test.tsx',
      'src/contexts/adapters/nativeActivity.test.tsx',
    ],
    resolve(root, 'frontend'),
  );
  run(
    'real native reply WebSocket identity, two-member edits, expiry and reconnect',
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.native-foundation.config.js',
      '--maxWorkers=1',
      'lambda/yjs-server/test/service.test.js',
      '-t',
      'isolates native answer revisions',
    ],
  );
  run('architecture', process.execPath, ['scripts/native-architecture.mjs']);
  run('architecture regression', process.execPath, [
    '--test',
    'scripts/test/native-architecture.test.mjs',
  ]);
  run('deployment wiring', 'python3', [
    '-B',
    '-m',
    'unittest',
    'discover',
    '-s',
    'terraform/modules/compute/native-runs/tests',
    '-p',
    'test_*.py',
  ]);
}
if (options.image) {
  const results = [];
  for (const cli of options.clis) {
    const statuses = [];
    for (const baseline of cli === 'claude' ? [true, false] : [false]) {
      console.log(
        `Installed ${cli}: ${
          baseline
            ? 'four-turn terminal/cwd/subagent baseline'
            : cli === 'kiro'
              ? 'real package initialization and v2 authentication boundary'
              : 'production-composed journey and failures'
        }`,
      );
      const name = `native-qualification-${randomUUID()}`;
      try {
        const result = spawnSync(
          'docker',
          installedDockerArgs({ ...options, root, cli, baseline, name }),
          { cwd: root, stdio: 'inherit', timeout: 10 * 60_000 },
        );
        statuses.push(result.status);
      } finally {
        // A timed-out Docker client does not itself stop its container. Only
        // remove the disposable container whose random name this run owns.
        spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore', timeout: 10_000 });
      }
    }
    const status = installedStatus(statuses);
    console.log(`Installed ${cli}: ${status}`);
    results.push(status);
  }
  const status = results.includes('FAIL')
    ? 'FAIL'
    : results.includes('BLOCKED')
      ? 'BLOCKED'
      : 'PASS';
  console.log(
    `Installed matrix: ${status}; image=${options.image}; candidate source mounted from checkout.`,
  );
  if (status !== 'PASS') process.exitCode = status === 'BLOCKED' ? 2 : 1;
} else console.log('Installed CLI/workflow tier: NOT RUN (supply --image and --assets).');
console.log('Live model compliance, deployed IAM/runtime and browser latency: NOT QUALIFIED.');
