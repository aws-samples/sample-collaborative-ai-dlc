import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const e2eScript = join(root, 'scripts/agent-e2e-testing.sh');
const proxyVariableNames = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'FTP_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'ftp_proxy',
  'no_proxy',
  'all_proxy',
];

const runHarness = (proxyEnv) => {
  const fixture = mkdtempSync(join(tmpdir(), 'aidlc-e2e-proxy-'));
  const bin = join(fixture, 'bin');
  const dockerLog = join(fixture, 'docker.log');
  mkdirSync(bin);

  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
first="\${1:-}"
second="\${2:-}"
{
  printf '%s' "$first"
  shift || true
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >> "$DOCKER_LOG"
if [[ "$first" == "logs" && "$second" == *"-gremlin-"* ]]; then
  printf 'Channel started at port 8182\\n'
fi
`,
  );
  chmodSync(docker, 0o755);

  const node = join(bin, 'node');
  writeFileSync(node, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(node, 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DOCKER_LOG: dockerLog,
    E2E_CLIS: 'kiro',
    E2E_OUTPUT_DIR: join(fixture, 'output'),
    KIRO_API_KEY: 'test-key',
    TMPDIR: fixture,
  };
  for (const name of proxyVariableNames) delete env[name];
  Object.assign(env, proxyEnv);

  const result = spawnSync('bash', [e2eScript], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(dockerLog, 'utf8');
};

test('E2E harness forwards proxy names without putting values in Docker arguments', () => {
  const log = runHarness({
    HTTP_PROXY: 'http://proxy.example.com:8080',
    no_proxy: 'localhost,127.0.0.1',
  });

  assert.match(log, /^buildx\tbuild\t--build-arg\tHTTP_PROXY\t--build-arg\tno_proxy\t/m);
  assert.match(log, /\t--env\tHTTP_PROXY(?:\t|\n)/);
  assert.match(log, /\t--env\tno_proxy(?:\t|\n)/);
  assert.doesNotMatch(log, /proxy\.example\.com|localhost,127\.0\.0\.1/);
});

test('E2E harness adds no proxy arguments without proxy variables', () => {
  const log = runHarness({});
  assert.doesNotMatch(log, /--build-arg/);
  assert.doesNotMatch(log, /\t--env\t(?:HTTP_PROXY|no_proxy)(?:\t|\n)/);
});
