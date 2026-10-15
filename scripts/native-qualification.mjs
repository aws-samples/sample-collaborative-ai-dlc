// One finite offline acceptance entrypoint. No provider/model credentials or
// deployed resources are required. Installed components are an explicit tier;
// omission is printed as NOT RUN, never reported as live qualification.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const options = {};
while (args.length) {
  const key = args.shift();
  if (!['--image', '--assets'].includes(key) || !args.length || options[key])
    throw new Error('Use --image <digest URI> --assets <verified AI-DLC 2.11.0 release directory>');
  options[key] = args.shift();
}
if (Boolean(options['--image']) !== Boolean(options['--assets']))
  throw new Error('Installed tier requires both --image and --assets');
if (options['--image'] && !/@sha256:[a-f0-9]{64}$/.test(options['--image']))
  throw new Error('An immutable image digest is required');
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
  'lambda/agentcore/test/native-executor-output.test.js',
  'lambda/agentcore/test/native-pending-question.test.js',
  'lambda/agentcore/test/native-session-recovery-files.test.js',
  'lambda/agentcore/test/native-kiro-acp-turn.test.js',
  'lambda/shared/test/native-interaction.test.js',
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
if (options['--image']) {
  run(
    'actual installed Claude and attested AI-DLC 2.11.0; inert loopback provider, no network',
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--user',
      'node',
      '--tmpfs',
      '/tmp:rw,exec,mode=1777,size=1g',
      '--mount',
      `type=bind,src=${root},dst=/fixture,readonly`,
      '--mount',
      `type=bind,src=${resolve(options['--assets'])},dst=/assets,readonly`,
      '-e',
      'NATIVE_QUALIFICATION_PACKAGE=/assets',
      '--entrypoint',
      'node',
      options['--image'],
      '/fixture/scripts/native-claude-recovery-smoke.mjs',
    ],
  );
} else console.log('Installed CLI/workflow tier: NOT RUN (supply --image and --assets).');
console.log(
  'Offline native acceptance passed. Live model compliance, deployed IAM/runtime and browser latency: NOT QUALIFIED.',
);
