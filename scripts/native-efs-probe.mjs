#!/usr/bin/env node
// Run only after the user has deployed /mnt/native. This diagnostic never
// deploys, starts a model, or accepts an arbitrary runtime command or path.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  CAPACITY_BYTES,
  COMMAND_TIMEOUT_SECONDS,
  NATIVE_MOUNT,
  OUTPUT_LIMIT_BYTES,
  fixedProbeCommand,
  fixedProbeSource,
  probeError,
} from './lib/native-efs-probe.mjs';

export const USAGE =
  'node scripts/native-efs-probe.mjs --profile NAME --expected-account 123456789012 ' +
  '--runtime-arn ARN [--region us-east-1]\n' +
  'Post-deployment only: fixed /mnt/native probe; writes, syncs, verifies and removes 1 GiB + 8 MiB.';

const valid = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

// Whitelist strings and field names; never preserve raw runtime/SDK output.
const fields = (input, names) =>
  Object.fromEntries(
    names
      .filter(
        (name) =>
          typeof input?.[name] === 'boolean' ||
          (typeof input?.[name] === 'number' && Number.isFinite(input[name]) && input[name] >= 0) ||
          (typeof input?.[name] === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(input[name])),
      )
      .map((name) => [name, input[name]]),
  );

export function parseProbeArgs(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      profile: { type: 'string' },
      region: { type: 'string', default: 'us-east-1' },
      'expected-account': { type: 'string' },
      'runtime-arn': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return { help: true };
  const { profile, region } = values;
  const account = values['expected-account'];
  const arn = values['runtime-arn'];
  if (
    !valid(/^[A-Za-z0-9][A-Za-z0-9_.@+=,:/-]*$/, profile) ||
    !valid(/^[a-z]{2}(?:-[a-z]+)+-\d+$/, region) ||
    !valid(/^\d{12}$/, account) ||
    !valid(
      /^arn:aws:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z][A-Za-z0-9_]*_agentcore_dev-[A-Za-z0-9]+$/,
      arn,
    )
  ) {
    throw probeError('invalid_arguments');
  }
  const parts = arn.split(':');
  if (parts[3] !== region || parts[4] !== account) throw probeError('runtime_target_mismatch');
  return { profile, region, account, arn };
}

function projectReport(value) {
  if (
    value?.schemaVersion !== 1 ||
    value.type !== 'result' ||
    value.root !== NATIVE_MOUNT ||
    typeof value.ok !== 'boolean' ||
    !['not-created', 'removed', 'unconfirmed'].includes(value.cleanup) ||
    (value.probeDirectory !== null && !probeDirectoryValid(value.probeDirectory))
  )
    throw probeError('invalid_probe_report');
  const checks = {};
  for (const name of ['hardlink', 'symlink', 'rename', 'executable', 'capacity']) {
    if (value.checks?.[name])
      checks[name] = fields(value.checks[name], [
        'passed',
        'inode',
        'device',
        'nlink',
        'directorySynced',
        'mode',
        'bytesWritten',
        'bytesRead',
        'allocatedBytes',
        'synced',
        'expectedSha256',
        'actualSha256',
      ]);
  }
  const report = {
    schemaVersion: 1,
    type: 'result',
    ok: value.ok,
    root: NATIVE_MOUNT,
    probeDirectory: value.probeDirectory,
    cleanup: value.cleanup,
    ...fields(value, ['durationMs']),
    checks,
  };
  if (value.mount) report.mount = fields(value.mount, ['filesystem', 'mountId', 'statfsType']);
  if (value.failure) {
    const stages = [
      'mount',
      'create',
      'hardlink',
      'symlink',
      'rename',
      'executable',
      'capacity',
      'cleanup',
    ];
    const codes = [
      'not_writable_nfs_mount',
      'unsafe_directory',
      'deadline_exceeded',
      'hardlink_mismatch',
      'symlink_mismatch',
      'rename_mismatch',
      'chmod_mismatch',
      'short_write',
      'short_read',
      'capacity_file_changed',
      'allocation_not_verified',
      'readback_mismatch',
      'cleanup_failed',
      'operation_failed',
      'EACCES',
      'EPERM',
      'ENOENT',
      'EEXIST',
      'ENOSPC',
      'EDQUOT',
      'EROFS',
      'EIO',
      'ENOTSUP',
      'EOPNOTSUPP',
      'ETIMEDOUT',
      'ESTALE',
      'EXDEV',
    ];
    report.failure = {
      stage: stages.includes(value.failure.stage) ? value.failure.stage : 'unknown',
      code: codes.includes(value.failure.code) ? value.failure.code : 'operation_failed',
    };
  }
  if (
    report.ok &&
    (report.cleanup !== 'removed' ||
      report.mount?.statfsType !== 0x6969 ||
      !['nfs', 'nfs4'].includes(report.mount?.filesystem) ||
      report.failure ||
      !['hardlink', 'symlink', 'rename', 'executable', 'capacity'].every(
        (name) => checks[name]?.passed === true,
      ) ||
      checks.hardlink.nlink !== 2 ||
      !/^\d+$/.test(checks.hardlink.inode || '') ||
      !/^\d+$/.test(checks.hardlink.device || '') ||
      checks.rename.directorySynced !== true ||
      checks.executable.mode !== '0700' ||
      checks.capacity.bytesWritten !== CAPACITY_BYTES ||
      checks.capacity.bytesRead !== CAPACITY_BYTES ||
      !Number.isSafeInteger(checks.capacity.allocatedBytes) ||
      checks.capacity.allocatedBytes < CAPACITY_BYTES ||
      checks.capacity.synced !== true ||
      !/^[a-f0-9]{64}$/.test(checks.capacity.expectedSha256 || '') ||
      checks.capacity.expectedSha256 !== checks.capacity.actualSha256)
  )
    throw probeError('invalid_probe_report');
  return report;
}

const probeDirectoryValid = (value) =>
  typeof value === 'string' &&
  /^\/mnt\/native\/\.aidlc-efs-probe-[A-Za-z0-9]{6}$/.exec(value)?.[0] === value;

export async function readProbeResponse(response, sessionId, onStarted = () => {}) {
  if (response.statusCode !== 200 || response.runtimeSessionId !== sessionId || !response.stream)
    throw probeError('invalid_runtime_response');
  let stdout = '';
  let bytes = 0;
  let stop;
  let started;
  for await (const event of response.stream) {
    if (!event.chunk) throw probeError('runtime_command_failed');
    const chunk = event.chunk;
    if (stop) throw probeError('invalid_runtime_response');
    for (const name of ['stdout', 'stderr']) {
      const text = chunk.contentDelta?.[name];
      if (text === undefined) continue;
      if (typeof text !== 'string') throw probeError('invalid_runtime_response');
      bytes += Buffer.byteLength(text);
      if (bytes > OUTPUT_LIMIT_BYTES) throw probeError('runtime_output_limit');
      if (name === 'stdout') stdout += text;
    }
    if (!started && stdout.includes('\n')) {
      try {
        const first = JSON.parse(stdout.slice(0, stdout.indexOf('\n')));
        if (first.type === 'started') {
          if (
            first.schemaVersion !== 1 ||
            first.root !== NATIVE_MOUNT ||
            !probeDirectoryValid(first.probeDirectory)
          )
            throw new Error('Invalid start');
          started = first.probeDirectory;
          onStarted(started);
        }
      } catch {
        throw probeError('invalid_probe_report');
      }
    }
    if (chunk.contentStop) stop = chunk.contentStop;
  }
  if (stop?.status === 'TIMED_OUT') throw probeError('runtime_command_timeout');
  if (stop?.status !== 'COMPLETED') throw probeError('runtime_command_incomplete');
  const lines = stdout.trim().split('\n');
  if (lines.length < 1 || lines.length > 2) throw probeError('invalid_probe_report');
  let report;
  try {
    report = projectReport(JSON.parse(lines.at(-1)));
  } catch {
    throw probeError('invalid_probe_report');
  }
  if (report.ok && (lines.length !== 2 || started !== report.probeDirectory))
    throw probeError('invalid_probe_report');
  if (stop.exitCode !== (report.ok ? 0 : 1)) throw probeError('runtime_exit_mismatch');
  return report;
}

export async function invokeInSession(client, options, sessionId, signal, onStarted) {
  const { InvokeAgentRuntimeCommand, InvokeAgentRuntimeCommandCommand } =
    await import('@aws-sdk/client-bedrock-agentcore');
  const probeId = sessionId.slice('aidlc-native-efs-probe-'.length);
  // The command API documents execution in a session, not session provisioning:
  // https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntimeCommand.html
  // Establish the fresh session through the normal invocation API first.
  // This fixed status command needs no model credentials and creates no project.
  const bootstrap = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: options.arn,
      runtimeSessionId: sessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: Buffer.from(
        JSON.stringify({
          command: 'native-interaction-probe',
          action: 'status',
          probeId,
          executionId: probeId,
          requestedCli: 'codex',
        }),
      ),
    }),
    { abortSignal: signal },
  );
  if (
    bootstrap.statusCode !== 200 ||
    !bootstrap.response ||
    (bootstrap.runtimeSessionId && bootstrap.runtimeSessionId !== sessionId)
  )
    throw probeError('runtime_bootstrap_failed');
  const chunks = [];
  let size = 0;
  for await (const chunk of bootstrap.response) {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array))
      throw probeError('runtime_bootstrap_failed');
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > OUTPUT_LIMIT_BYTES) throw probeError('runtime_output_limit');
    chunks.push(data);
  }
  let status;
  try {
    status = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw probeError('runtime_bootstrap_failed');
  }
  if (status.ok !== false || status.reason !== 'probe_not_found')
    throw probeError('runtime_bootstrap_failed');
  return readProbeResponse(
    await client.send(
      new InvokeAgentRuntimeCommandCommand({
        agentRuntimeArn: options.arn,
        runtimeSessionId: sessionId,
        body: { command: fixedProbeCommand(), timeout: COMMAND_TIMEOUT_SECONDS },
      }),
      { abortSignal: signal },
    ),
    sessionId,
    onStarted,
  );
}

async function lookupIdentity(options) {
  const result = await promisify(execFile)(
    'aws',
    [
      '--profile',
      options.profile,
      '--region',
      options.region,
      '--no-cli-pager',
      'sts',
      'get-caller-identity',
      '--output',
      'json',
    ],
    { env: { ...process.env, AWS_PAGER: '' }, timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(result.stdout).Account;
}

async function invoke(options, sessionId) {
  const { BedrockAgentCoreClient } = await import('@aws-sdk/client-bedrock-agentcore');
  const { fromIni } = await import('@aws-sdk/credential-providers');
  const client = new BedrockAgentCoreClient({
    region: options.region,
    credentials: fromIni({ profile: options.profile }),
    maxAttempts: 1,
  });
  const controller = new AbortController();
  let timer;
  let probeDirectory = null;
  try {
    return await Promise.race([
      invokeInSession(client, options, sessionId, controller.signal, (directory) => {
        probeDirectory = directory;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(probeError('operator_timeout'));
          },
          (COMMAND_TIMEOUT_SECONDS + 60) * 1000,
        );
      }),
    ]);
  } catch (error) {
    throw Object.assign(probeError(error.code), { probeDirectory });
  } finally {
    clearTimeout(timer);
    client.destroy();
  }
}

export async function runOperator(args, dependencies = {}) {
  const options = parseProbeArgs(args);
  if (options.help) return { help: USAGE };
  if ((await (dependencies.lookupIdentity || lookupIdentity)(options)) !== options.account)
    throw probeError('account_mismatch');
  const sessionId = `aidlc-native-efs-probe-${randomUUID()}`;
  const evidence = {
    schemaVersion: 1,
    experiment: 'native-efs-filesystem-v1',
    qualification: 'filesystem-primitives-and-capacity-only',
    runtimeArn: options.arn,
    runtimeSessionId: sessionId,
    region: options.region,
    sourceSha256: createHash('sha256').update(fixedProbeSource()).digest('hex'),
    requestedBytes: CAPACITY_BYTES,
    commandTimeoutSeconds: COMMAND_TIMEOUT_SECONDS,
    sessionBootstrap: 'credential-free-native-interaction-status',
    startedAt: new Date().toISOString(),
  };
  try {
    evidence.report = await (dependencies.invoke || invoke)(options, sessionId);
  } catch (error) {
    const known = new Set([
      'invalid_runtime_response',
      'runtime_command_failed',
      'runtime_output_limit',
      'runtime_command_timeout',
      'runtime_command_incomplete',
      'invalid_probe_report',
      'runtime_exit_mismatch',
      'operator_timeout',
      'runtime_bootstrap_failed',
    ]);
    evidence.report = {
      ok: false,
      cleanup: 'unconfirmed',
      probeDirectory: probeDirectoryValid(error.probeDirectory) ? error.probeDirectory : null,
      failure: { code: known.has(error.code) ? error.code : 'runtime_invocation_failed' },
    };
  }
  evidence.finishedAt = new Date().toISOString();
  const directory = await mkdtemp(join(tmpdir(), 'aidlc-native-efs-evidence-'));
  const evidenceFile = join(directory, 'result.json');
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { ok: evidence.report.ok, ...evidence.report, runtimeSessionId: sessionId, evidenceFile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOperator(process.argv.slice(2))
    .then((result) => {
      console.log(result.help || JSON.stringify(result, null, 2));
      if (!result.help && !result.ok) process.exitCode = 1;
    })
    .catch(() => {
      console.error(
        `Native EFS probe could not start. Check explicit arguments and AWS identity.\n${USAGE}`,
      );
      process.exitCode = 2;
    });
}
