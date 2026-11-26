import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  CAPACITY_BYTES,
  COMMAND_TIMEOUT_SECONDS,
  OUTPUT_LIMIT_BYTES,
  fixedProbeCommand,
  fixedProbeSource,
  requireNfsMount,
  runNativeEfsProbe,
  writeAndVerifyCapacity,
} from '../lib/native-efs-probe.mjs';
import {
  invokeInSession,
  parseProbeArgs,
  readProbeResponse,
  runOperator,
} from '../native-efs-probe.mjs';

const runtimeArn =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/collaborative_ai_dlc_agentcore_dev-Ab12Cd34Ef';
const args = [
  '--profile',
  'test-profile',
  '--expected-account',
  '123456789012',
  '--runtime-arn',
  runtimeArn,
];
const sessionId = 'aidlc-native-efs-probe-33333333-3333-4333-8333-333333333333';
const mountinfo = (root = '/mnt/native') =>
  `51 30 0:45 / ${root} rw,relatime - nfs4 127.0.0.1:/ rw,vers=4.1\n`;
const temporary = async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-efs-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
// Only the mount declaration is simulated; file/link/rename/sync/readback
// operations below use a real, tiny local fixture. This does not qualify NFS.
const simulatedNfs = (root, overrides = {}) => ({
  ...fs,
  lstat: async (...statArgs) => {
    const stat = await fs.lstat(...statArgs);
    stat.dev = typeof stat.dev === 'bigint' ? 45n : 45;
    return stat;
  },
  statfs: async () => ({ type: 0x6969 }),
  readFile: (path, ...rest) =>
    path === '/proc/self/mountinfo' ? Promise.resolve(mountinfo(root)) : fs.readFile(path, ...rest),
  ...overrides,
});
async function* stream(events) {
  for (const event of events) yield event;
}
const reportFixture = () => ({
  schemaVersion: 1,
  type: 'result',
  ok: true,
  root: '/mnt/native',
  probeDirectory: '/mnt/native/.aidlc-efs-probe-ABC123',
  cleanup: 'removed',
  mount: { filesystem: 'nfs4', mountId: 51, statfsType: 0x6969 },
  checks: {
    hardlink: { passed: true, nlink: 2, inode: '123', device: '45' },
    symlink: { passed: true },
    rename: { passed: true, directorySynced: true },
    executable: { passed: true, mode: '0700' },
    capacity: {
      passed: true,
      bytesWritten: CAPACITY_BYTES,
      bytesRead: CAPACITY_BYTES,
      allocatedBytes: CAPACITY_BYTES,
      synced: true,
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'a'.repeat(64),
    },
  },
});
const commandResponse = (
  report = reportFixture(),
  stop = { exitCode: 0, status: 'COMPLETED' },
) => ({
  statusCode: 200,
  runtimeSessionId: sessionId,
  stream: stream([
    { chunk: { contentStart: {} } },
    {
      chunk: {
        contentDelta: {
          stdout: `${JSON.stringify({
            schemaVersion: 1,
            type: 'started',
            root: '/mnt/native',
            probeDirectory: report.probeDirectory,
          })}\n${JSON.stringify(report)}\n`,
        },
      },
    },
    { chunk: { contentStop: stop } },
  ]),
});

test('requires the exact writable NFS mount and matching statfs, not an NFS directory elsewhere', () => {
  assert.equal(requireNfsMount(mountinfo(), { type: 0x6969 }, 45n).filesystem, 'nfs4');
  for (const [text, type] of [
    [mountinfo('/mnt/workspace'), 0x6969],
    [mountinfo().replace('nfs4', 'ext4'), 0x6969],
    [mountinfo(), 0xef53],
    [mountinfo().replace('rw,relatime', 'ro,relatime'), 0x6969],
    [mountinfo().replace('rw,vers', 'ro,vers'), 0x6969],
    [mountinfo() + mountinfo(), 0x6969],
    ['malformed line\n', 0x6969],
  ]) {
    assert.throws(() => requireNfsMount(text, { type }, 45n), { code: 'not_writable_nfs_mount' });
  }
});

test('selects the actual NFS device from AgentCore backing-overlay and EFS mount entries', () => {
  const backing =
    '579 554 0:22 /mnt/native /mnt/native rw,noatime - overlay overlayfs:/overlay/root rw\n';
  const efs = '521 579 0:51 / /mnt/native rw,relatime - nfs4 127.0.0.1:/ rw,vers=4.1\n';
  for (const text of [backing + efs, efs + backing]) {
    const result = requireNfsMount(text, { type: 0x6969 }, 51n);
    assert.equal(result.mountId, 521);
    assert.equal(result.device, '0:51');
    // A hidden NFS entry cannot qualify the visible overlay, even with a
    // misleading/mismatched statfs value.
    assert.throws(() => requireNfsMount(text, { type: 0x6969 }, 22n), {
      code: 'not_writable_nfs_mount',
    });
    assert.throws(() => requireNfsMount(text, { type: 0x6969 }, 52n), {
      code: 'not_writable_nfs_mount',
    });
  }
});

test('rejects invalid device identities and preserves Linux device bits above 32 bits', () => {
  for (const device of [
    undefined,
    null,
    '45',
    -1,
    45.5,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    1n << 64n,
  ]) {
    assert.throws(() => requireNfsMount(mountinfo(), { type: 0x6969 }, device), {
      code: 'not_writable_nfs_mount',
    });
  }
  // Linux makedev(0x12345, 0x6789a), including the extended major/minor fields.
  const device = 0x120006783459an;
  const text = mountinfo().replace('0:45', '74565:424090');
  assert.equal(requireNfsMount(text, { type: 0x6969 }, device).device, '74565:424090');
});

test('mount refusal occurs before creating or touching a probe directory', async (t) => {
  const root = await temporary(t);
  let created = false;
  const report = await runNativeEfsProbe({
    root,
    bytes: 8192,
    fs: simulatedNfs(root, {
      statfs: async () => ({ type: 0xef53 }),
      mkdtemp: async () => {
        created = true;
        throw new Error('Must not create');
      },
    }),
  });
  assert.equal(created, false);
  assert.equal(report.ok, false);
  assert.deepEqual(report.failure, { stage: 'mount', code: 'not_writable_nfs_mount' });
  assert.equal(report.cleanup, 'not-created');
  assert.deepEqual(await fs.readdir(root), []);
});

test('a symlinked mount is refused before any write', async (t) => {
  const root = await temporary(t);
  const actual = join(root, 'actual');
  await fs.mkdir(actual);
  const alias = join(root, 'alias');
  await fs.symlink(actual, alias);
  const report = await runNativeEfsProbe({ root: alias, bytes: 8192, fs: simulatedNfs(alias) });
  assert.equal(report.failure.code, 'unsafe_directory');
  assert.deepEqual(await fs.readdir(actual), []);
});

test('real small-file primitives, full write/sync/readback, and cleanup leave neighboring data alone', async (t) => {
  const root = await temporary(t);
  await fs.writeFile(join(root, 'neighbor'), 'must remain');
  const report = await runNativeEfsProbe({ root, bytes: 16 * 1024, fs: simulatedNfs(root) });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.checks.hardlink.nlink, 2);
  assert.equal(report.checks.rename.directorySynced, true);
  assert.equal(report.checks.executable.mode, '0700');
  assert.equal(report.checks.capacity.bytesRead, 16 * 1024);
  assert.equal(report.checks.capacity.expectedSha256, report.checks.capacity.actualSha256);
  assert.equal(report.cleanup, 'removed');
  assert.deepEqual(await fs.readdir(root), ['neighbor']);
  assert.equal(await fs.readFile(join(root, 'neighbor'), 'utf8'), 'must remain');
});

test('preserves high-bit EFS inode IDs returned as signed bigint values', async (t) => {
  const root = await temporary(t);
  const io = simulatedNfs(root);
  const inspect = io.lstat;
  io.lstat = async (path, ...statArgs) => {
    const stat = await inspect(path, ...statArgs);
    if (path.endsWith('/original') || path.endsWith('/hardlink')) stat.ino = -6810624069263734785n;
    return stat;
  };
  const report = await runNativeEfsProbe({ root, bytes: 4096, fs: io });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.checks.hardlink.inode, '11636120004445816831');
  assert.equal(report.cleanup, 'removed');
});

test('partial writes and reads still verify every byte', async (t) => {
  const root = await temporary(t);
  const smallIo = {
    ...fs,
    open: async (...openArgs) => {
      const handle = await fs.open(...openArgs);
      return {
        stat: (...a) => handle.stat(...a),
        sync: () => handle.sync(),
        close: () => handle.close(),
        write: (buffer, offset, length, position) =>
          handle.write(buffer, offset, Math.min(37, length), position),
        read: (buffer, offset, length, position) =>
          handle.read(buffer, offset, Math.min(43, length), position),
      };
    },
  };
  const result = await writeAndVerifyCapacity({
    path: join(root, 'data'),
    bytes: 4097,
    fs: smallIo,
  });
  assert.equal(result.bytesWritten, 4097);
  assert.equal(result.bytesRead, 4097);
  assert.equal(result.expectedSha256, result.actualSha256);
});

for (const corruption of ['changed-byte', 'early-eof']) {
  test(`readback detects ${corruption} and removes its bulk file`, async (t) => {
    const root = await temporary(t);
    const io = simulatedNfs(root, {
      open: async (path, flags, ...rest) => {
        const handle = await fs.open(path, flags, ...rest);
        if (!path.endsWith('/capacity.bin') || typeof flags !== 'number') return handle;
        return {
          stat: (...a) => handle.stat(...a),
          close: () => handle.close(),
          read: async (...a) => {
            if (corruption === 'early-eof') return { bytesRead: 0 };
            const result = await handle.read(...a);
            a[0][0] ^= 1;
            return result;
          },
        };
      },
    });
    const report = await runNativeEfsProbe({ root, bytes: 8192, fs: io });
    assert.equal(report.ok, false);
    assert.equal(
      report.failure.code,
      corruption === 'early-eof' ? 'short_read' : 'readback_mismatch',
    );
    assert.equal(report.cleanup, 'removed');
    assert.deepEqual(await fs.readdir(root), []);
  });
}

test('deadline stops before capacity work and still cleans only the synthetic directory', async (t) => {
  const root = await temporary(t);
  let clock = 0;
  const report = await runNativeEfsProbe({
    root,
    bytes: 8192,
    fs: simulatedNfs(root),
    now: () => clock,
    timeoutMs: 10,
    onStart: () => {
      clock = 20;
    },
    execute: async () => assert.fail('Expired probe must not execute'),
  });
  assert.equal(report.failure.code, 'deadline_exceeded');
  assert.equal(report.cleanup, 'removed');
  assert.deepEqual(await fs.readdir(root), []);
});

test('operation failures are sanitized; cleanup failure cannot be reported as success', async (t) => {
  const root = await temporary(t);
  const report = await runNativeEfsProbe({
    root,
    bytes: 8192,
    fs: simulatedNfs(root, {
      rm: async () => {
        throw new Error('PRIVATE cleanup detail');
      },
    }),
    execute: async () => {
      throw Object.assign(new Error('PRIVATE credential detail'), { code: 'EACCES' });
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.cleanup, 'unconfirmed');
  assert.deepEqual(report.failure, { stage: 'executable', code: 'EACCES' });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

test('fixed remote command survives POSIX quoting without a heredoc; generated module parses', async (t) => {
  const root = await temporary(t);
  await fs.writeFile(
    join(root, 'node'),
    '#!/bin/sh\n[ "$#" -eq 3 ] || exit 1\n[ "$1" = "--input-type=module" ] || exit 1\n[ "$2" = "-e" ] || exit 1\nprintf "%s" "$3"\n',
    { mode: 0o700 },
  );
  const result = await promisify(execFile)('/bin/sh', ['-c', fixedProbeCommand()], {
    env: { PATH: root },
    maxBuffer: 128 * 1024,
  });
  assert.equal(result.stdout, fixedProbeSource());
  assert.equal(
    spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: fixedProbeSource(),
      encoding: 'utf8',
    }).status,
    0,
  );
  assert.equal(CAPACITY_BYTES, 1_082_130_432);
});

test('CLI accepts only explicit matching dev targets and no command/path/size inputs', () => {
  assert.equal(parseProbeArgs(args).arn, runtimeArn);
  for (const bad of [
    [...args, '--path', '/tmp'],
    [...args, '--command', 'anything'],
    [...args, '--bytes', '1'],
    args.map((a) => a.replace('_agentcore_dev-', '_agentcore_prod-')),
    args.map((a) => a.replace(':bedrock-agentcore:', ':lambda:')),
    [...args, '--region', 'eu-central-1'],
    args.map((a) => (a === '123456789012' ? '999999999999' : a)),
    args.map((a) => (a === runtimeArn ? `${a}\n` : a)),
  ])
    assert.throws(() => parseProbeArgs(bad));
});

test('account mismatch prevents every runtime invocation', async () => {
  let invoked = false;
  await assert.rejects(
    runOperator(args, {
      lookupIdentity: async () => '999999999999',
      invoke: async () => {
        invoked = true;
      },
    }),
    { code: 'account_mismatch' },
  );
  assert.equal(invoked, false);
});

test('fresh session is bootstrapped by fixed credential-free status before the fixed command', async () => {
  const requests = [];
  const client = {
    send: async (command) => {
      requests.push(command);
      return requests.length === 1
        ? {
            statusCode: 200,
            response: stream([Buffer.from('{"ok":false,"reason":"probe_not_found"}')]),
          }
        : commandResponse();
    },
  };
  const result = await invokeInSession(client, parseProbeArgs(args), sessionId);
  assert.equal(result.ok, true);
  assert.equal(requests[0].constructor.name, 'InvokeAgentRuntimeCommand');
  assert.deepEqual(JSON.parse(requests[0].input.payload), {
    command: 'native-interaction-probe',
    action: 'status',
    requestedCli: 'codex',
    probeId: '33333333-3333-4333-8333-333333333333',
    executionId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(requests[1].constructor.name, 'InvokeAgentRuntimeCommandCommand');
  assert.equal(requests[1].input.runtimeSessionId, sessionId);
  assert.deepEqual(requests[1].input.body, {
    command: fixedProbeCommand(),
    timeout: COMMAND_TIMEOUT_SECONDS,
  });
});

test('disabled/unexpected bootstrap does not run the filesystem command', async () => {
  let calls = 0;
  const client = {
    send: async () => {
      calls += 1;
      return {
        statusCode: 200,
        response: stream(['{"ok":false,"reason":"native_probe_disabled"}']),
      };
    },
  };
  await assert.rejects(invokeInSession(client, parseProbeArgs(args), sessionId), {
    code: 'runtime_bootstrap_failed',
  });
  assert.equal(calls, 1);
});

test('stream validates byte proof and exit status and discards unknown/private fields', async () => {
  const report = reportFixture();
  report.credentials = 'PRIVATE token';
  report.checks.capacity.extra = 'PRIVATE actor';
  const parsed = await readProbeResponse(commandResponse(report), sessionId);
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE|credentials|extra/);
  report.checks.capacity.bytesRead -= 1;
  await assert.rejects(readProbeResponse(commandResponse(report), sessionId), {
    code: 'invalid_probe_report',
  });
  await assert.rejects(
    readProbeResponse(
      commandResponse(reportFixture(), {
        exitCode: 1,
        status: 'COMPLETED',
      }),
      sessionId,
    ),
    { code: 'runtime_exit_mismatch' },
  );
});

test('success requires present, finite safe-integer allocation evidence covering every byte', async () => {
  for (const allocatedBytes of [
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    true,
    String(CAPACITY_BYTES),
    CAPACITY_BYTES - 1,
    CAPACITY_BYTES + 0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const report = reportFixture();
    if (allocatedBytes === undefined) delete report.checks.capacity.allocatedBytes;
    else report.checks.capacity.allocatedBytes = allocatedBytes;
    await assert.rejects(
      readProbeResponse(commandResponse(report), sessionId),
      {
        code: 'invalid_probe_report',
      },
      `Must reject allocatedBytes=${String(allocatedBytes)}`,
    );
  }
});

test('truncated, timed-out, oversized and exception streams never qualify', async () => {
  for (const [events, code] of [
    [[{ chunk: { contentStart: {} } }], 'runtime_command_incomplete'],
    [[{ chunk: { contentStop: { exitCode: 1, status: 'TIMED_OUT' } } }], 'runtime_command_timeout'],
    [
      [{ chunk: { contentDelta: { stderr: 'x'.repeat(OUTPUT_LIMIT_BYTES + 1) } } }],
      'runtime_output_limit',
    ],
    [[{ accessDeniedException: { message: 'PRIVATE' } }], 'runtime_command_failed'],
  ]) {
    await assert.rejects(
      readProbeResponse(
        {
          statusCode: 200,
          runtimeSessionId: sessionId,
          stream: stream(events),
        },
        sessionId,
      ),
      { code },
    );
  }
});

test('operator stores private sanitized failure evidence with an owned leftover path', async (t) => {
  const result = await runOperator(args, {
    lookupIdentity: async () => '123456789012',
    invoke: async () => {
      throw Object.assign(new Error('PRIVATE AWS metadata'), {
        code: 'operator_timeout',
        probeDirectory: '/mnt/native/.aidlc-efs-probe-ABC123',
      });
    },
  });
  t.after(() => fs.rm(dirname(result.evidenceFile), { recursive: true, force: true }));
  assert.equal(result.ok, false);
  assert.equal(result.cleanup, 'unconfirmed');
  assert.equal(result.probeDirectory, '/mnt/native/.aidlc-efs-probe-ABC123');
  assert.equal((await fs.stat(result.evidenceFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(result.evidenceFile, 'utf8'), /PRIVATE/);
});
