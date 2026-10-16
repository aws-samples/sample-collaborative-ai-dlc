import { resolve } from 'node:path';

const CLIS = ['claude', 'codex', 'opencode', 'kiro'];
const usage =
  'Use [--image <immutable digest URI> --assets <attested release directory>] [--cli claude,codex,opencode,kiro|all] [--installed-only]';
export function qualificationOptions(argv) {
  const args = [...argv];
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (Object.hasOwn(options, key)) throw new Error(usage);
    if (key === '--installed-only') options[key] = true;
    else {
      if (
        !['--image', '--assets', '--cli'].includes(key) ||
        !args.length ||
        args[0].startsWith('--')
      )
        throw new Error(usage);
      options[key] = args.shift();
    }
  }
  if (
    Boolean(options['--image']) !== Boolean(options['--assets']) ||
    ((options['--cli'] || options['--installed-only']) && !options['--image'])
  )
    throw new Error('Selected installed tier requires both --image and --assets');
  if (options['--image'] && !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(options['--image']))
    throw new Error('An immutable image digest is required');
  const clis = options['--cli'] === 'all' ? [...CLIS] : (options['--cli'] ?? 'claude').split(',');
  if (new Set(clis).size !== clis.length || clis.some((cli) => !CLIS.includes(cli)))
    throw new Error(usage);
  return {
    image: options['--image'],
    assets: options['--assets'] ? resolve(options['--assets']) : null,
    clis,
    installedOnly: options['--installed-only'] === true,
  };
}

export function installedDockerArgs({ image, assets, root, cli, name, baseline = false }) {
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
    '--mount',
    `type=bind,src=${assets},dst=/assets,readonly`,
    '-e',
    'NATIVE_QUALIFICATION_PACKAGE=/assets',
    '--entrypoint',
    'node',
    image,
    baseline
      ? '/fixture/scripts/native-claude-recovery-smoke.mjs'
      : '/fixture/scripts/native-installed-qualification.mjs',
    ...(baseline ? [] : [cli]),
  ];
}

export const installedStatus = (results) =>
  results.some((status) => status !== 0 && status !== 2)
    ? 'FAIL'
    : results.includes(2)
      ? 'BLOCKED'
      : 'PASS';
