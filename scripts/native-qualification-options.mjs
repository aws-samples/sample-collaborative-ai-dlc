import { resolve } from 'node:path';

const CLIS = ['claude', 'codex', 'opencode', 'kiro'];
const usage =
  'Use [--image <immutable digest URI> --assets <attested release directory>] [--cli claude,codex,opencode,kiro|all] [--opencode-cache <prepared public npm cache>] [--linux-bindings <prepared Linux node_modules>] [--installed-only] [--packaged-image (also accepts local sha256 ID)]';
export function qualificationOptions(argv) {
  const args = [...argv];
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (Object.hasOwn(options, key)) throw new Error(usage);
    if (['--installed-only', '--packaged-image'].includes(key)) options[key] = true;
    else {
      if (
        !['--image', '--assets', '--cli', '--opencode-cache', '--linux-bindings'].includes(key) ||
        !args.length ||
        args[0].startsWith('--')
      )
        throw new Error(usage);
      options[key] = args.shift();
    }
  }
  if (
    Boolean(options['--image']) !== Boolean(options['--assets']) ||
    ((options['--cli'] ||
      options['--installed-only'] ||
      options['--packaged-image'] ||
      options['--opencode-cache'] ||
      options['--linux-bindings']) &&
      !options['--image'])
  )
    throw new Error('Selected installed tier requires both --image and --assets');
  if (
    options['--image'] &&
    !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(options['--image']) &&
    !(options['--packaged-image'] && /^sha256:[a-f0-9]{64}$/.test(options['--image']))
  )
    throw new Error('An immutable image digest is required');
  const clis = options['--cli'] === 'all' ? [...CLIS] : (options['--cli'] ?? 'claude').split(',');
  if (new Set(clis).size !== clis.length || clis.some((cli) => !CLIS.includes(cli)))
    throw new Error(usage);
  return {
    image: options['--image'],
    assets: options['--assets'] ? resolve(options['--assets']) : null,
    clis,
    installedOnly: options['--installed-only'] === true,
    packagedImage: options['--packaged-image'] === true,
    opencodeCache: options['--opencode-cache'] ? resolve(options['--opencode-cache']) : null,
    linuxBindings: options['--linux-bindings'] ? resolve(options['--linux-bindings']) : null,
  };
}

function offlineDockerArgs({ assets, root, name, packagedImage, dependenciesRoot }) {
  return [
    'run',
    '--rm',
    '--init',
    ...(name ? ['--name', name] : []),
    '--pull',
    'never',
    '--network',
    'none',
    '--read-only',
    '--user',
    'node',
    '--tmpfs',
    '/tmp:rw,exec,mode=1777,size=1g',
    '--mount',
    `type=bind,src=${root},dst=/fixture,readonly`,
    ...(packagedImage
      ? [
          '--mount',
          `type=bind,src=${dependenciesRoot}/node_modules,dst=/fixture/node_modules,readonly`,
        ]
      : []),
    '--mount',
    `type=bind,src=${assets},dst=/assets,readonly`,
    '-e',
    'NATIVE_QUALIFICATION_PACKAGE=/assets',
  ];
}

export function installedDockerArgs({
  image,
  assets,
  root,
  cli,
  name,
  baseline = false,
  opencodeCache,
  packagedImage,
  dependenciesRoot,
}) {
  return [
    ...offlineDockerArgs({ assets, root, name, packagedImage, dependenciesRoot }),
    ...(cli === 'opencode' && opencodeCache
      ? [
          '--mount',
          `type=bind,src=${opencodeCache},dst=/opencode-cache,readonly`,
          '-e',
          'NATIVE_QUALIFICATION_OPENCODE_CACHE=/opencode-cache',
        ]
      : []),
    '--entrypoint',
    'node',
    image,
    ...(packagedImage
      ? ['--import', '/fixture/scripts/native-qualification-packaged-audit.mjs']
      : []),
    baseline
      ? '/fixture/scripts/native-claude-recovery-smoke.mjs'
      : '/fixture/scripts/native-installed-qualification.mjs',
    ...(baseline ? [] : [cli]),
  ];
}

export function linuxDockerArgs({
  image,
  assets,
  root,
  name,
  linuxBindings,
  packagedImage,
  dependenciesRoot,
}) {
  return [
    ...offlineDockerArgs({ assets, root, name, packagedImage, dependenciesRoot }),
    '--mount',
    `type=bind,src=${linuxBindings},dst=/linux-node-modules,readonly`,
    '-e',
    'NODE_PATH=/linux-node-modules',
    '--workdir',
    '/fixture',
    '--entrypoint',
    'node',
    image,
    ...(packagedImage
      ? ['--import', '/fixture/scripts/native-qualification-packaged-audit.mjs']
      : []),
    '/fixture/node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.native-foundation.config.js',
    '--configLoader',
    'runner',
    '--maxWorkers=2',
    'lambda/agentcore/test/native-command-runner.test.js',
    'lambda/agentcore/test/native-execution-files.test.js',
    'lambda/agentcore/test/native-session-recovery-files.test.js',
    'lambda/agentcore/test/native-opencode-recovery-command.test.js',
    'lambda/shared/test/native-recovery-checkpoint.test.js',
    'lambda/shared/test/native-dependency-links.test.js',
  ];
}

export const installedStatus = (results) =>
  results.some((status) => status !== 0 && status !== 2)
    ? 'FAIL'
    : results.includes(2)
      ? 'BLOCKED'
      : 'PASS';
