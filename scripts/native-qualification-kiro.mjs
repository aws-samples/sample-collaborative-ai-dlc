// Installed v2 boundary evidence, not a provider emulator or a workflow pass.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNativeInitializationProbe } from '../lambda/agentcore/native/initialization-probe.js';
import { runNativeCommand } from '../lambda/agentcore/native/command-runner.js';
import { createKiroAcpClient } from '../lambda/agentcore/native/kiro-acp-client.js';
import { createKiroAcpTurn } from '../lambda/agentcore/native/kiro-acp-turn.js';
import { kiroPromptHash } from '../lambda/agentcore/native/kiro-prompt.js';

export async function qualifyKiro({ base, pkg, report }) {
  // Same fixture admission boundary as the composed journeys. The real
  // installer still verifies the public release signature and exact bytes.
  const packageId = `sha256:${'a'.repeat(64)}`;
  const materializationId = `sha256:${'b'.repeat(64)}`;
  const probe = createNativeInitializationProbe({
    probeRoot: join(base, 'initialization'),
    gitBinary: '/usr/bin/git',
    hostPath: `${pkg.tools}:/opt/kiro/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin`,
    loadForExecution: async () => ({
      ...pkg,
      package: { version: pkg.version, target: 'linux-arm64', packageId },
      materializationId,
      trust: { allowed: true, policy: 'owner-selected-source-v1', packageId, materializationId },
    }),
  });
  const initialized = await probe.run();
  const kiro = initialized.harnesses.find((item) => item.harness === 'kiro');
  assert.equal(initialized.status, 'passed', 'Real package initialization/doctor must pass');
  assert.equal(kiro.status, 'passed');
  report({
    probe: 'kiro-workflow-initialization',
    status: 'PASS',
    owner: 'production initialization probe with fixture admission',
    commands: initialized.commands.length,
    generatedAgent: true,
    doctorPassed: true,
    modelTurns: 0,
  });
  for (const authentication of ['missing', 'inert-key']) {
    const home = join(base, `kiro-${authentication}`);
    await fs.mkdir(home, { mode: 0o700 });
    const started = performance.now();
    const result = await runNativeCommand({
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), '--probe'],
      cwd: kiro.projectDirectory,
      env: {
        HOME: home,
        KIRO_HOME: join(home, '.kiro'),
        XDG_DATA_HOME: join(home, '.data'),
        XDG_RUNTIME_DIR: home,
        PATH: `${join(initialized.attemptRoot, 'machine/bin')}:/opt/kiro/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin`,
        ...(authentication === 'inert-key'
          ? {
              KIRO_API_KEY: ['ksk', 'offline', 'qualification', 'not', 'a', 'credential'].join('_'),
            }
          : {}),
        KIRO_NO_AUTO_UPDATE: '1',
        KIRO_DISABLE_TELEMETRY: '1',
        KIRO_LOG_LEVEL: 'info',
        KIRO_CHAT_LOG_FILE: join(home, 'kiro.log'),
      },
      timeoutMs: 15_000,
    });
    assert.equal(result.cleanupComplete, true, 'Real Kiro descendants must be reaped');
    assert.equal(result.timedOut, false, 'Probe must retain its exact boundary before cleanup');
    assert.equal(result.exitCode, 2, 'Boundary probe must not claim a completed model turn');
    const evidence = JSON.parse(result.stdout);
    report({
      probe: 'installed-v2-provider',
      authentication,
      ...evidence,
      elapsedMs: Math.round(performance.now() - started),
      cleanupComplete: result.cleanupComplete,
    });
    assert.equal(evidence.protocolPhase, 'initialize');
    assert.equal(evidence.sessionCreated, false);
    assert.deepEqual(evidence.requests, ['initialize']);
    assert.equal(evidence.initializeAcknowledged, false);
    if (authentication === 'inert-key') {
      assert.equal(evidence.stoppedAt, 'managed-auth-service');
      assert.ok(evidence.deniedManagedAuthConnections > 0);
    } else assert.equal(evidence.notLoggedIn, true, 'Missing credential rejection observed');
  }
  return {
    status: 'BLOCKED',
    boundary:
      'Kiro 2.29.1 v2 needs managed API-key authentication before ACP initialize. No supported deterministic local provider/authentication input is available; no session, prompt, typed workflow or recovery pass is claimed.',
  };
}

async function probeInstalledAcp() {
  const started = performance.now();
  const requests = [];
  let initializeAcknowledged = false;
  let deniedConnections = 0;
  let deniedManagedAuthConnections = 0;
  let stoppedAt = null;
  let client;
  // Observation only: reject CONNECT before TLS, never relay bytes or act as
  // Kiro's service. The enclosing Docker container also has --network none.
  const proxy = http.createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(403, { Connection: 'close' }).end();
  });
  proxy.on('connect', (request, socket) => {
    deniedConnections++;
    if (request.url === 'management.us-east-1.kiro.dev:443') {
      deniedManagedAuthConnections++;
      stoppedAt = 'managed-auth-service';
    } else if (deniedConnections >= 16) stoppedAt = 'connection-limit';
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    socket.destroySoon();
    if (stoppedAt) client?.dispose();
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const child = spawn(
    '/usr/local/bin/kiro-cli',
    ['acp', '--agent-engine', 'v2', '--agent', 'aidlc', '--trust-all-tools'],
    {
      cwd: process.cwd(),
      env: { ...process.env, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let notLoggedIn = false;
  child.stderr.on('data', (bytes) => {
    if (/not logged in/i.test(bytes.toString())) notLoggedIn = true;
  });
  const prompt = 'Present fixture question.';
  const turn = createKiroAcpTurn({
    project: process.cwd(),
    prompt,
    production: true,
    expectedUserPromptSha256: kiroPromptHash(prompt),
    userPromptSource: 'literal',
  });
  client = createKiroAcpClient({
    input: child.stdout,
    output: child.stdin,
    onUpdate: turn.onUpdate,
    onPermission: turn.onPermission,
  });
  const deadline = setTimeout(() => {
    stoppedAt = 'deadline';
    client.dispose();
  }, 10_000);
  const result = await turn.execute({
    async request(method, params, options) {
      requests.push(method);
      const value = await client.request(method, params, options);
      if (method === 'initialize') initializeAcknowledged = true;
      return value;
    },
  });
  clearTimeout(deadline);
  client.dispose();
  const log = await fs.open(process.env.KIRO_CHAT_LOG_FILE).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (log) {
    try {
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
      const { bytesRead } = await log.read(buffer, 0, buffer.length, 0);
      assert.ok((await log.stat()).size < buffer.length, 'Bounded local diagnostic log');
      notLoggedIn ||= /not logged in/i.test(buffer.subarray(0, bytesRead).toString());
    } finally {
      await log.close();
    }
  }
  const evidence = {
    stoppedAt,
    protocolPhase: result.protocolPhase,
    transportFailure: result.transportFailure,
    sessionCreated: result.sessionId !== null,
    initializeAcknowledged,
    requests,
    notLoggedIn,
    deniedConnections,
    deniedManagedAuthConnections,
    elapsedMs: Math.round(performance.now() - started),
  };
  proxy.close();
  // The outer production command owner terminates and reaps the installed CLI
  // and every descendant. A successful probe is deliberately exit 2, not 0.
  await new Promise((done) => process.stdout.write(`${JSON.stringify(evidence)}\n`, done));
  process.exit(result.ok ? 1 : 2);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv[2], '--probe');
  await probeInstalledAcp();
}
