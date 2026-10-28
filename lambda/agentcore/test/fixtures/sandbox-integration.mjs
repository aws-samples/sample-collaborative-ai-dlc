// Mounted in a disposable test container; excluded from production images.
// The same workload runs with enabled=false and enabled=true.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { captureChild, runChild } from '../../cli/spawn.js';
import { DEFAULT_SANDBOX_CONFIG, withSandbox } from '../../sandbox/launcher.js';

const script = fileURLToPath(import.meta.url);
const attempt = async (operation) => {
  try {
    await operation();
    return true;
  } catch (error) {
    // A missing binary or unrelated exception is not evidence of a policy denial.
    if (!['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(error.code)) throw error;
    return false;
  }
};

const workload = async ([workspace, readPath, writePath, port]) => {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const output = join(workspace, 'allowed.txt');
  await writeFile(output, 'allowed write');
  const workspaceWrite = (await readFile(output, 'utf8')) === 'allowed write';
  const protectedRead = await attempt(() => readFile(readPath, 'utf8'));
  const protectedWrite = await attempt(() => writeFile(writePath, 'child wrote this'));
  const directConnection = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: Number(port), timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
  const destination = `http://127.0.0.1:${port}/fixture`;
  const proxy = process.env.HTTP_PROXY ? new URL(process.env.HTTP_PROXY) : null;
  const httpStatus = await new Promise((resolve, reject) => {
    const options = proxy
      ? {
          hostname: proxy.hostname,
          port: proxy.port,
          path: destination,
          headers: {
            'Proxy-Authorization': `Basic ${Buffer.from(
              `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
            ).toString('base64')}`,
          },
        }
      : { hostname: '127.0.0.1', port, path: '/fixture' };
    const req = request({ ...options, timeout: 3000 }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.once('timeout', () => req.destroy(new Error('fixture HTTP request timed out')));
    req.once('error', reject);
    req.end();
  });
  assert.ok([200, 403].includes(httpStatus), `unexpected HTTP status: ${httpStatus}`);
  console.log(
    JSON.stringify({
      workspaceWrite,
      protectedRead,
      protectedWrite,
      directConnection,
      httpRequest: httpStatus === 200,
      stdin,
    }),
  );
};

const runCase = async (enabled, helper) => {
  assert.equal(DEFAULT_SANDBOX_CONFIG.enabled, false, 'shipping default must remain disabled');
  const manifest = new URL('../package.json', import.meta.resolve('@anthropic-ai/sandbox-runtime'));
  const srtVersion = JSON.parse(await readFile(manifest, 'utf8')).version;
  const root = await mkdtemp(join(tmpdir(), 'srt-integration-'));
  const workspace = join(root, 'workspace');
  const protectedDirectory = join(root, 'protected');
  const readDirectory = join(protectedDirectory, 'read');
  let destinationRequests = 0;
  const server = createServer((req, res) => {
    destinationRequests++;
    res.end('fixture response');
  });
  try {
    await Promise.all([mkdir(workspace), mkdir(readDirectory, { recursive: true })]);
    const readPath = join(readDirectory, 'read.txt');
    const writePath = join(protectedDirectory, 'write.txt');
    await Promise.all([writeFile(readPath, 'read fixture'), writeFile(writePath, 'write fixture')]);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith('aidlc-srt-'));
    const events = [];
    let stdout = '';
    const options = {
      command: process.execPath,
      args: [script, '--workload', workspace, readPath, writePath, String(port)],
      cwd: workspace,
      env: {},
      promptViaStdin: true,
      prompt: 'sandbox integration input',
      captureStderr: true,
      captureStderrTail: 4096,
      timeoutMs: 10_000,
      onStdout: (chunk) => {
        stdout += chunk;
      },
    };
    const result = await withSandbox(
      {
        enabled,
        settings: {
          network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
          filesystem: {
            allowWrite: [workspace],
            denyRead: [readDirectory],
            denyWrite: [writePath],
          },
        },
        observeFileWrites: true,
        onEvent: (event) => events.push(event),
      },
      () => (helper === 'capture' ? captureChild(options) : runChild(options)),
    );
    assert.equal(result.exitCode, 0, result.stderr ?? result.stderrTail);
    const checks = JSON.parse(helper === 'capture' ? result.stdout : stdout);
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith('aidlc-srt-'));
    const scratchCleaned = after.every((name) => before.includes(name));
    const report = {
      enabled,
      helper,
      srtVersion,
      ...checks,
      protectedFileUnchanged: (await readFile(writePath, 'utf8')) === 'write fixture',
      destinationRequests,
      scratchCleaned,
      networkDenialLogged: events.some(
        (event) =>
          event.type === 'sandbox.denied' && event.host === '127.0.0.1' && event.port === port,
      ),
    };
    assert.deepEqual(report, {
      enabled,
      helper,
      srtVersion: '0.0.79',
      workspaceWrite: true,
      protectedRead: !enabled,
      protectedWrite: !enabled,
      directConnection: !enabled,
      httpRequest: !enabled,
      stdin: 'sandbox integration input',
      protectedFileUnchanged: enabled,
      destinationRequests: enabled ? 0 : 1,
      scratchCleaned: true,
      networkDenialLogged: enabled,
    });
    console.log(`SRT_TEST_RESULT=${JSON.stringify(report)}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
};

if (process.argv[2] === '--workload') await workload(process.argv.slice(3));
else {
  assert.ok(['false', 'true'].includes(process.argv[2]), 'expected enabled=false or true');
  assert.ok(['capture', 'stream'].includes(process.argv[3]), 'expected capture or stream helper');
  await runCase(process.argv[2] === 'true', process.argv[3]);
}
