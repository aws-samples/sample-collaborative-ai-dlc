import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { publicEcrPassword, publicEcrToken, stubPublicEcr } from './helpers/public-ecr.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const wrapper = join(root, 'scripts/with-public-ecr-auth.mjs');
const dockerfiles = ['lambda/agentcore/Dockerfile', 'lambda/yjs-server/Dockerfile'];
const fixture = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'public ecr auth '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ['bin', 'tmp', 'docker/contexts'])
    mkdirSync(join(directory, path), { recursive: true });
  for (const file of dockerfiles) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(join(root, file), join(directory, file));
  }
  writeFileSync(
    join(directory, 'docker/config.json'),
    JSON.stringify({
      auths: {
        'private.example.invalid': { auth: 'preserved' },
        'public.ecr.aws': { auth: 'expired' },
      },
      credsStore: 'must-not-be-called',
      credHelpers: {
        'public.ecr.aws': 'stale-helper',
        'private.example.invalid': 'preserved-helper',
      },
      proxies: { default: { httpProxy: 'http://proxy.example.invalid:3128' } },
    }),
  );
  writeFileSync(join(directory, 'docker/contexts/retained'), 'context');
  stubPublicEcr(join(directory, 'bin'));
  const env = {
    ...process.env,
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    DOCKER_CONFIG: join(directory, 'docker'),
    DOCKER_HOST: 'unix:///fixture/docker.sock',
    DOCKER_BUILDKIT: '1',
    AWS_REGION: 'eu-central-1',
    TMPDIR: join(directory, 'tmp'),
    ECR_TEST_LOG: join(directory, 'events'),
  };
  delete env.AIDLC_PUBLIC_ECR_AUTH_WRAPPED;
  const child = join(directory, 'builder.cjs');
  writeFileSync(
    child,
    `const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const directory = process.env.DOCKER_CONFIG;
const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json')));
assert.equal(config.auths['public.ecr.aws'].auth, '${publicEcrToken}');
assert.equal(config.credHelpers['public.ecr.aws'], '');
assert.equal(config.credsStore, 'must-not-be-called');
assert.equal(config.auths['private.example.invalid'].auth, 'preserved');
assert.equal(config.credHelpers['private.example.invalid'], 'preserved-helper');
assert.equal(config.proxies.default.httpProxy, 'http://proxy.example.invalid:3128');
assert.equal(fs.readFileSync(path.join(directory, 'contexts/retained'), 'utf8'), 'context');
assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
assert.equal(fs.statSync(path.join(directory, 'config.json')).mode & 0o777, 0o600);
assert.equal(process.env.DOCKER_HOST, 'unix:///fixture/docker.sock');
fs.appendFileSync(process.env.ECR_TEST_LOG, 'builder ' + directory + '\\n');
if (process.env.ECR_TEST_WAIT === '1') {
  const code = "const fs = require('node:fs'); process.on('SIGTERM', () => { fs.appendFileSync(process.argv[1], 'grandchild terminated\\\\n'); process.exit(0); }); fs.appendFileSync(process.argv[1], 'grandchild ready ' + process.pid + '\\\\n'); setInterval(() => {}, 1000);";
  require('node:child_process').spawn(process.execPath, ['-e', code, process.env.ECR_TEST_LOG], { stdio: 'inherit' });
}
else process.exit(Number(process.env.ECR_TEST_CHILD_EXIT || 0));
`,
  );
  return { directory, env, child };
};
const run = ({ directory, env, child }, extraEnv = {}) =>
  spawnSync(process.execPath, [wrapper, directory, '--', process.execPath, child], {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  });
const assertClean = ({ directory }, result) => {
  assert.deepEqual(readdirSync(join(directory, 'tmp')), []);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    new RegExp(`${publicEcrToken}|${publicEcrPassword}`),
  );
  assert.equal(
    JSON.parse(readFileSync(join(directory, 'docker/config.json'))).auths['public.ecr.aws'].auth,
    'expired',
  );
};

test('both pinned bases are checked with us-east-1 auth before the builder inherits isolated credentials', (t) => {
  const f = fixture(t);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const events = readFileSync(join(f.directory, 'events'), 'utf8').trim().split('\n');
  assert.equal(events[0], 'login');
  for (const [index, file] of dockerfiles.entries()) {
    const image = readFileSync(join(root, file), 'utf8').match(/^FROM (\S+)/m)[1];
    const [repository, digest] = image.replace('public.ecr.aws/', '').split('@');
    assert.equal(
      events[index + 1],
      `https://public.ecr.aws/v2/${repository.split(':')[0]}/manifests/${digest}`,
    );
  }
  assert.match(events[3], /^builder /);
  assertClean(f, result);
  // Negative control: the old path reaches the builder with stale credentials.
  const old = spawnSync(process.execPath, [f.child], { encoding: 'utf8', env: f.env });
  assert.notEqual(old.status, 0);
});

test('denied login and manifest failures stop before the deployment command and clean credentials', (t) => {
  for (const failure of [
    { ECR_TEST_LOGIN_FAIL: '1' },
    { ECR_TEST_HTTP_STATUS: '401' },
    { ECR_TEST_HTTP_STATUS: '429' },
    { ECR_TEST_HTTP_STATUS: '503' },
  ]) {
    const f = fixture(t);
    const result = run(f, failure);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Public ECR (login failed|manifest check failed)/);
    assert.doesNotMatch(readFileSync(join(f.directory, 'events'), 'utf8'), /builder/);
    assertClean(f, result);
  }
});

test('child failure preserves its exit status and removes temporary auth', (t) => {
  const f = fixture(t);
  const result = run(f, { ECR_TEST_CHILD_EXIT: '42' });
  assert.equal(result.status, 42);
  assertClean(f, result);
});

test('termination reaches the deployment subprocess tree and removes temporary auth', async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, [wrapper, f.directory, '--', process.execPath, f.child], {
    env: { ...f.env, ECR_TEST_WAIT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => (stderr += data));
  const exited = new Promise((resolveExit) => child.on('exit', resolveExit));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      existsSync(join(f.directory, 'events')) &&
      readFileSync(join(f.directory, 'events'), 'utf8').includes('grandchild ready ')
    )
      break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.match(readFileSync(join(f.directory, 'events'), 'utf8'), /grandchild ready /);
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (readFileSync(join(f.directory, 'events'), 'utf8').includes('grandchild terminated')) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.match(readFileSync(join(f.directory, 'events'), 'utf8'), /grandchild terminated/);
  assertClean(f, { stdout, stderr });
});

test('fresh Docker config works without a Docker CLI or credential helper', (t) => {
  const f = fixture(t);
  rmSync(join(f.directory, 'docker'), { recursive: true });
  writeFileSync(
    f.child,
    `const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.equal(JSON.parse(fs.readFileSync(process.env.DOCKER_CONFIG + '/config.json')).auths['public.ecr.aws'].auth, '${publicEcrToken}');`,
  );
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(f.directory, 'tmp')), []);
});

test('invalid Docker config and disabled BuildKit fail before credentials or apply', (t) => {
  for (const disabled of ['', '0', 'false', 'False', 'FALSE', 'f', 'F', 'invalid']) {
    const f = fixture(t);
    if (!disabled) writeFileSync(join(f.directory, 'docker/config.json'), '{invalid-private-data');
    const result = run(f, disabled ? { DOCKER_BUILDKIT: disabled } : {});
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /invalid-private-data/);
    assert.ok(!existsSync(join(f.directory, 'events')));
    assert.deepEqual(readdirSync(join(f.directory, 'tmp')), []);
  }
});

test('releases with no Public ECR bases retain their existing registry setup', (t) => {
  const f = fixture(t);
  for (const file of dockerfiles) writeFileSync(join(f.directory, file), 'FROM node:24-slim\n');
  writeFileSync(f.child, 'process.exit(0);\n');
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(join(f.directory, 'events')));
  assertClean(f, result);
});

test('v2.0.0 tag-only bases are checked without retargeting the release image', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.directory, dockerfiles[0]),
    'FROM public.ecr.aws/docker/library/node:24.15.0-slim\n',
  );
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(f.directory, 'events'), 'utf8'), /\/manifests\/24\.15\.0-slim\n/);
  assertClean(f, result);
});

test('active Terraform builders share config auth while refreshing private ECR provider credentials', () => {
  for (const file of ['compute/agentcore', 'realtime/yjs-server']) {
    const source = readFileSync(join(root, 'terraform/modules', file, 'main.tf'), 'utf8');
    assert.match(source, /address\s+= local\.ecr_registry_address/);
    assert.match(source, /username\s+= ""/);
    assert.match(source, /password\s+= ""/);
    assert.match(
      source,
      /config_file_content = jsonencode\(\{\s+credHelpers = \{ \(local\.ecr_registry_address\) = "ecr-login" \}/,
    );
    assert.doesNotMatch(source, /data\.aws_ecr_authorization_token/);
    const builders = [...source.matchAll(/module "[^"]+" \{([\s\S]*?)^\}/gm)].filter(
      ([, builder]) =>
        /source\s+= "terraform-aws-modules\/lambda\/aws\/\/modules\/docker-build"/.test(builder),
    );
    assert.equal(builders.length, file === 'compute/agentcore' ? 2 : 1);
    for (const [, builder] of builders) assert.match(builder, /builder\s+= "default"/);
  }
});
