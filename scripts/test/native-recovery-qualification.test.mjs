import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  parseQualificationArgs,
  projectWorkspaceReport,
  readBootstrapResponse,
  readCommandResponse,
  runOperator,
  validateResources,
  validateStop,
} from '../native-recovery-qualification.mjs';
import {
  barrierSource,
  barrierCommand,
  runWorkspaceOperation,
  workspaceCommand,
} from '../lib/native-recovery-qualification.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const identity = {
  projectId: '11111111-1111-4111-8111-111111111111',
  executionId: '22222222-2222-4222-8222-222222222222',
  bindingId: '33333333-3333-4333-8333-333333333333',
  attemptId: '44444444-4444-4444-8444-444444444444',
  runtimeSessionId: '55555555-5555-4555-8555-555555555555',
  epoch: 1,
};
const nonce = '66666666-6666-4666-8666-666666666666';
const recoveryId = '77777777-7777-4777-8777-777777777777';
const configurationSha256 = 'c'.repeat(64);
const markerSha256 = '9'.repeat(64);
const packageId = `sha256:${'d'.repeat(64)}`;
const options = (action = 'stop') => ({
  action,
  profile: 'qualification-operator',
  account: '123456789012',
  region: 'us-east-1',
  table: 'native-runs-dev',
  ...identity,
  writerGeneration: 1,
  nonce,
});
const args = (action = 'stop') => [
  '--action',
  action,
  '--profile',
  'qualification-operator',
  '--expected-account',
  '123456789012',
  '--region',
  'us-east-1',
  '--table',
  'native-runs-dev',
  '--project-id',
  identity.projectId,
  '--intent-id',
  identity.executionId,
  '--attempt-id',
  identity.attemptId,
  '--writer-generation',
  '1',
  '--nonce',
  nonce,
];
const operation = (action = 'inspect', requireBarrier = true) => ({
  action,
  identity,
  nonce,
  writerGeneration: 1,
  configurationSha256,
  packageId,
  requireBarrier,
});
const stateFixture = (status = 'RUNNING') => {
  const runtimeArn =
    'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/native_fixture-AbCd1234';
  const endpoint = `exec_${sha(identity.attemptId).slice(0, 32)}`;
  const preparation = {
    fileSystemId: 'fs-0123456789abcdef0',
    accessPointArn:
      'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0',
    rootDirectory: `/runs/${'a'.repeat(64)}`,
  };
  return {
    runtimeConfigurationSha256: configurationSha256,
    row: {
      scope: { projectId: identity.projectId, executionId: identity.executionId },
      ...identity,
      status,
      writerGeneration: 1,
      turnSequence: 2,
      startedAt: Date.now() - 1000,
      configurationSha256: 'b'.repeat(64),
      configuration: {
        accountId: '123456789012',
        harness: 'claude',
        recoveryMode: 'efs-workspace-v1',
        packageId,
        image: {
          digest: `sha256:${'a'.repeat(64)}`,
          uri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/native@sha256:${'a'.repeat(64)}`,
        },
      },
      preparation,
      target: {
        runtimeArn,
        runtimeVersion: '2',
        endpoint,
        endpointArn: `${runtimeArn}/runtime-endpoint/${endpoint}`,
        imageDigest: `sha256:${'a'.repeat(64)}`,
      },
      cancelRequested: false,
      ...(status === 'RECOVERY_REQUIRED'
        ? {
            recovery: { id: recoveryId, canRecover: true, reason: 'SESSION_LOST' },
            stopConfirmation: {
              runtimeSessionId: identity.runtimeSessionId,
              writerGeneration: 1,
              confirmedAt: Date.now(),
            },
          }
        : {}),
    },
    binding: {
      ...preparation,
      bindingId: identity.bindingId,
      target: { agentRuntimeArn: runtimeArn },
      mountPath: '/mnt/native',
      executionRoleArn: 'arn:aws:iam::123456789012:role/native-runs/native_fixture',
    },
  };
};

const remoteReport = (input = operation()) => ({
  schemaVersion: 1,
  action: input.action,
  nonce: input.nonce,
  ok: true,
  rootInode: '100',
  projectInode: '200',
  machineInode: '300',
  workspaceSha256: 'a'.repeat(64),
  configurationSha256,
  ...(input.action === 'inspect'
    ? {
        markerSha256: input.markerSha256 ?? markerSha256,
        markerEvidence: input.requireBarrier ? 'live' : 'retained',
        changedFiles: [{ pathSha256: 'f'.repeat(64), sha256: 'e'.repeat(64), bytes: 12 }],
        dependencies: { symlinkCount: 2, hardlinkedTargets: 0, sha256: 'a'.repeat(64) },
        ...(input.requireBarrier
          ? {
              barrier: {
                pid: 12,
                ppid: 11,
                claudePid: 10,
                startTicks: '123',
                deadline: Date.now() + 100_000,
                observedAt: Date.now(),
              },
            }
          : {}),
      }
    : {}),
  ...(input.action !== 'inspect' ? { quarantined: true } : {}),
  ...(input.action === 'wrong-project' ? { replacementInode: '400' } : {}),
});
async function* events(...values) {
  yield* values;
}
const response = (value, overrides = {}) => ({
  $metadata: { httpStatusCode: 200 },
  statusCode: 200,
  runtimeSessionId: identity.runtimeSessionId,
  stream: events(
    { chunk: { contentStart: {} } },
    { chunk: { contentDelta: { stdout: JSON.stringify(value) + '\n' } } },
    { chunk: { contentStop: { status: 'COMPLETED', exitCode: value.ok ? 0 : 1 } } },
  ),
  ...overrides,
});
const stopResponse = () => ({
  $metadata: { httpStatusCode: 200 },
  statusCode: 200,
  runtimeSessionId: identity.runtimeSessionId,
});
const bootstrapResponse = (overrides = {}) => ({
  ...stopResponse(),
  response: events(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        ...identity,
        writerGeneration: 1,
        status: 'stopped_needs_review',
        code: 'native_execution_existing_owner',
        ...overrides,
      }),
    ),
  ),
});

function operatorFixture(status = 'RUNNING') {
  let state = stateFixture(status);
  const calls = [];
  const ports = {
    account: async () => '123456789012',
    readState: async () => structuredClone(state),
    verifyResources: async () => {},
    command: async (row, input) => {
      calls.push({ kind: 'command', row, input });
      return response(remoteReport(input));
    },
    bootstrap: async (row) => {
      calls.push({ kind: 'bootstrap', row });
      return bootstrapResponse();
    },
    stop: async (row, token) => {
      calls.push({ kind: 'stop', row, token });
      return stopResponse();
    },
  };
  return {
    ports,
    calls,
    state: () => state,
    replace: (next) => {
      state = next;
    },
  };
}

test('requires explicit profile, account, region, scope, attempt, generation and nonce', () => {
  assert.equal(parseQualificationArgs(args()).profile, 'qualification-operator');
  for (const flag of [
    '--profile',
    '--expected-account',
    '--region',
    '--table',
    '--project-id',
    '--intent-id',
    '--attempt-id',
    '--writer-generation',
    '--nonce',
  ]) {
    const values = args();
    values.splice(values.indexOf(flag), 2);
    assert.throws(() => parseQualificationArgs(values), { code: 'invalid_arguments' }, flag);
  }
  for (const [flag, value] of [
    ['--profile', '$(touch /tmp/no)'],
    ['--writer-generation', '1.5'],
    ['--intent-id', '../other-run'],
    ['--action', 'shell'],
    ['--nonce', "a'; printenv"],
  ]) {
    const values = args();
    values[values.indexOf(flag) + 1] = value;
    assert.throws(() => parseQualificationArgs(values), { code: 'invalid_arguments' });
  }
  const values = args();
  values[values.indexOf('--profile') + 1] = 'solution-read';
  assert.throws(() => parseQualificationArgs(values), { code: 'read_only_profile' });
  assert.throws(() => parseQualificationArgs([...args(), '--command', 'id']));
  assert.throws(() => parseQualificationArgs([...args(), '--root', '/somewhere']));
  assert.throws(
    () => parseQualificationArgs([...args('inspect'), '--marker-sha256', 'not-a-hash']),
    { code: 'invalid_arguments' },
  );
  assert.equal(
    parseQualificationArgs([...args('inspect'), '--marker-sha256', markerSha256]).markerSha256,
    markerSha256,
  );
});

test('barrier command generation is local and contains only the fixed source and validated nonce', async () => {
  const local = parseQualificationArgs(['--action', 'barrier-command', '--nonce', nonce]);
  const command = await runOperator(
    local,
    new Proxy({}, { get: () => assert.fail('AWS port used') }),
  );
  assert.equal(command, barrierCommand(nonce));
  assert.ok(command.includes('qualificationBarrier'));
  assert.ok(command.includes(nonce));
  assert.throws(() => barrierCommand("'; env; '"), { code: 'invalid_arguments' });
  // Parse the complete generated remote source without running it.
  const input = operation('wrong-project', false);
  const runtimeCommand = workspaceCommand(input);
  const prefix = "node --input-type=module -e '";
  const source = runtimeCommand.slice(prefix.length, -1).replaceAll("'\\''", "'");
  const child = spawn(process.execPath, ['--input-type=module', '--check'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(source);
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
});

test('only the derived execution target is stopped, after fresh ownership checks and barrier evidence', async () => {
  const f = operatorFixture();
  const result = await runOperator(options(), f.ports);
  assert.equal(result.ok, true);
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['command', 'stop'],
  );
  assert.equal(f.calls[1].row.target.endpoint, `exec_${sha(identity.attemptId).slice(0, 32)}`);
  assert.equal(f.calls[1].row.runtimeSessionId, identity.runtimeSessionId);
  assert.match(f.calls[1].token, SHA256);
  assert.equal(result.stop.confirmed, true);
  assert.equal(f.calls[0].input.requireBarrier, true);
});
const SHA256 = /^[a-f0-9]{64}$/;

test('wrong identity, cancelled state, scope or generation prevents every runtime operation', async () => {
  for (const mutate of [
    (row) => {
      row.attemptId = nonce;
    },
    (row) => {
      row.scope.executionId = nonce;
    },
    (row) => {
      row.writerGeneration = 2;
    },
    (row) => {
      row.cancelRequested = true;
    },
    (row) => {
      row.target.endpoint = 'DEFAULT';
    },
    (row) => {
      row.configuration.recoveryMode = 'exact';
    },
    (row) => {
      row.status = 'STOPPED';
    },
  ]) {
    const f = operatorFixture();
    mutate(f.state().row);
    const result = await runOperator(options(), f.ports);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'authority_mismatch');
    assert.deepEqual(f.calls, []);
  }
  const f = operatorFixture();
  f.ports.account = async () => '999999999999';
  assert.equal((await runOperator(options(), f.ports)).code, 'account_mismatch');
  assert.deepEqual(f.calls, []);
});

test('authority changes during resource verification or after inspection prevent the stop', async () => {
  for (const point of ['verification', 'inspection']) {
    const f = operatorFixture();
    if (point === 'verification')
      f.ports.verifyResources = async () => {
        f.state().row.cancelRequested = true;
      };
    else {
      const original = f.ports.command;
      f.ports.command = async (...values) => {
        const result = await original(...values);
        f.state().row.writerGeneration++;
        return result;
      };
    }
    assert.equal((await runOperator(options(), f.ports)).ok, false);
    assert.equal(f.calls.filter((call) => call.kind === 'stop').length, 0);
  }
});

test('waiting-boundary stops are refused even when a projection status claims completion', async () => {
  const f = operatorFixture('AWAITING_USER');
  f.state().row.projectionStatus = 'complete';
  f.state().row.publication = { id: 'a'.repeat(64), sequence: 2 };
  f.state().row.interaction = { id: 'b'.repeat(64) };
  const result = await runOperator(options(), f.ports);
  assert.equal(result.ok, false);
  assert.deepEqual(f.calls, []);
  f.state().row.projectionStatus = 'pending';
  f.calls.length = 0;
  assert.equal((await runOperator(options(), f.ports)).ok, false);
  assert.deepEqual(f.calls, []);
});

test('published awaiting-user inspection requires the original marker hash and never bootstraps or stops', async () => {
  const f = operatorFixture('AWAITING_USER');
  f.state().row.publication = { id: 'a'.repeat(64), sequence: 2 };
  // The public API may report completion from a different projection owner.
  // A stale raw-row projection flag cannot disqualify the admitted publication.
  f.state().row.projectionStatus = 'pending';
  const retainedOptions = { ...options('inspect'), markerSha256 };
  const result = await runOperator(retainedOptions, f.ports);
  assert.equal(result.ok, true);
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['command'],
  );
  assert.equal(f.calls[0].input.requireBarrier, false);
  assert.equal(f.calls[0].input.markerSha256, markerSha256);
  assert.equal(result.workspace.markerEvidence, 'retained');
  assert.equal(result.workspace.markerSha256, markerSha256);
  assert.equal(result.workspace.barrier, undefined);
  f.calls.length = 0;
  assert.equal((await runOperator(options('inspect'), f.ports)).code, 'invalid_arguments');
  assert.deepEqual(f.calls, []);
  f.state().row.publication.sequence = 1;
  assert.equal((await runOperator(retainedOptions, f.ports)).code, 'authority_mismatch');
  assert.deepEqual(f.calls, []);
  delete f.state().row.publication;
  assert.equal((await runOperator(retainedOptions, f.ports)).code, 'authority_mismatch');
  assert.deepEqual(f.calls, []);
});

test('HTTP, service status and exact session acknowledgement must all confirm stop', () => {
  validateStop(stopResponse(), identity.runtimeSessionId);
  for (const value of [
    undefined,
    { ...stopResponse(), $metadata: { httpStatusCode: 202 } },
    { ...stopResponse(), statusCode: 202 },
    { ...stopResponse(), runtimeSessionId: nonce },
    { ...stopResponse(), runtimeSessionId: undefined },
  ])
    assert.throws(() => validateStop(value, identity.runtimeSessionId), {
      code: 'stop_unconfirmed',
    });
});

test('live resource guards require the pinned image, execution endpoint and actual EFS ownership', () => {
  const state = stateFixture();
  const { row, binding } = state;
  const resources = () => ({
    actual: {
      agentRuntimeArn: row.target.runtimeArn,
      agentRuntimeVersion: row.target.runtimeVersion,
      status: 'READY',
      roleArn: binding.executionRoleArn,
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: row.configuration.image.uri },
      },
      filesystemConfigurations: [
        {
          efsAccessPoint: { accessPointArn: binding.accessPointArn, mountPath: '/mnt/native' },
        },
      ],
      environmentVariables: {
        NATIVE_RUNTIME_MODE: 'isolated',
        NATIVE_RUNTIME_PROJECT_ID: identity.projectId,
        NATIVE_RUNTIME_EXECUTION_ID: identity.executionId,
        NATIVE_RUNTIME_BINDING_ID: identity.bindingId,
        NATIVE_EXECUTION_ATTEMPT_ID: identity.attemptId,
        NATIVE_EXECUTION_RUNTIME_SESSION_ID: identity.runtimeSessionId,
        NATIVE_EXECUTION_EPOCH: '1',
        NATIVE_EXECUTION_IMAGE_DIGEST: row.configuration.image.digest,
        DO_NOT_RETURN: 'PRIVATE_MATERIAL',
      },
    },
    endpoint: {
      status: 'READY',
      name: row.target.endpoint,
      agentRuntimeArn: row.target.runtimeArn,
      agentRuntimeEndpointArn: row.target.endpointArn,
      liveVersion: row.target.runtimeVersion,
      targetVersion: row.target.runtimeVersion,
    },
    accessPoints: {
      AccessPoints: [
        {
          AccessPointArn: binding.accessPointArn,
          OwnerId: options().account,
          FileSystemId: binding.fileSystemId,
          LifeCycleState: 'available',
          RootDirectory: {
            Path: binding.rootDirectory,
            CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '700' },
          },
          PosixUser: { Uid: 1000, Gid: 1000 },
        },
      ],
    },
  });
  assert.equal(validateResources(state, options(), resources()), undefined);
  for (const change of [
    (value) => {
      value.actual.agentRuntimeArtifact.containerConfiguration.containerUri += '-different';
    },
    (value) => {
      value.actual.environmentVariables.NATIVE_EXECUTION_RUNTIME_SESSION_ID = nonce;
    },
    (value) => {
      value.actual.filesystemConfigurations[0].efsAccessPoint.accessPointArn += '-different';
    },
    (value) => {
      value.endpoint.liveVersion = '3';
    },
    (value) => {
      value.endpoint.name = 'DEFAULT';
    },
    (value) => {
      value.accessPoints.AccessPoints[0].RootDirectory.Path = '/runs/another';
    },
    (value) => {
      value.accessPoints.AccessPoints[0].RootDirectory.CreationInfo.Permissions = '777';
    },
    (value) => {
      value.accessPoints.AccessPoints[0].OwnerId = '999999999999';
    },
    (value) => {
      value.accessPoints.AccessPoints[0].PosixUser.Uid = 0;
    },
    (value) => {
      value.accessPoints.AccessPoints = [];
    },
  ]) {
    const value = resources();
    change(value);
    assert.throws(() => validateResources(state, options(), value), { code: 'resource_mismatch' });
  }
});

test('negative operations require the current confirmed stop and retain no automatic continuation path', async () => {
  for (const mutate of [
    (row) => {
      row.status = 'RUNNING';
    },
    (row) => {
      row.recovery.canRecover = false;
    },
    (row) => {
      row.stopConfirmation.writerGeneration = 2;
    },
    (row) => {
      row.stopConfirmation.runtimeSessionId = nonce;
    },
    (row) => {
      delete row.stopConfirmation;
    },
  ]) {
    const f = operatorFixture('RECOVERY_REQUIRED');
    mutate(f.state().row);
    const result = await runOperator(options('missing-project'), f.ports);
    assert.equal(result.ok, false);
    assert.deepEqual(f.calls, []);
  }
  const tokens = [];
  for (let retry = 0; retry < 2; retry++) {
    const f = operatorFixture('RECOVERY_REQUIRED');
    const result = await runOperator(options('wrong-project'), f.ports);
    assert.equal(result.ok, true);
    assert.deepEqual(
      f.calls.map((call) => call.kind),
      ['bootstrap', 'command', 'stop'],
    );
    assert.equal(result.diagnosticStop.confirmed, true);
    tokens.push(result.diagnosticStop.clientToken);
  }
  assert.notEqual(
    tokens[0],
    tokens[1],
    'a restarted diagnostic VM must never reuse an old stop token',
  );
});

test('even an ambiguous bootstrap response is followed by scoped diagnostic cleanup', async () => {
  const f = operatorFixture('RECOVERY_REQUIRED');
  f.ports.bootstrap = async (row) => {
    f.calls.push({ kind: 'bootstrap', row });
    return { ...bootstrapResponse(), runtimeSessionId: nonce };
  };
  const result = await runOperator(options('missing-project'), f.ports);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bootstrap_unconfirmed');
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['bootstrap', 'stop'],
  );
  assert.equal(result.diagnosticStop.confirmed, true);
});

test('a changed writer after bootstrap blocks mutation and avoids stopping a replacement writer', async () => {
  const f = operatorFixture('RECOVERY_REQUIRED');
  const original = f.ports.bootstrap;
  f.ports.bootstrap = async (...values) => {
    const result = await original(...values);
    f.state().row.writerGeneration = 2;
    return result;
  };
  const result = await runOperator(options('missing-project'), f.ports);
  assert.equal(result.ok, false);
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['bootstrap'],
  );
  assert.equal(result.diagnosticStop.confirmed, false);
});

test('failure to stop the diagnostic VM prevents a successful negative-case report', async () => {
  const f = operatorFixture('RECOVERY_REQUIRED');
  f.ports.stop = async () => ({ ...stopResponse(), statusCode: 202 });
  const result = await runOperator(options('wrong-project'), f.ports);
  assert.equal(result.ok, false);
  assert.equal(result.workspace.quarantined, true);
  assert.equal(result.diagnosticStop.confirmed, false);
  assert.equal(result.code, 'stop_unconfirmed');
});

test('runtime report projection strips unknown metadata and never returns raw runtime output', async () => {
  const input = operation();
  const value = remoteReport(input);
  value.credentials = 'DO_NOT_RETURN_PRIVATE_MATERIAL';
  value.changedFiles[0].content = 'DO_NOT_RETURN_PRIVATE_MATERIAL';
  value.barrier.command = 'DO_NOT_RETURN_PRIVATE_MATERIAL';
  const safe = await readCommandResponse(response(value), input);
  assert.equal(JSON.stringify(safe).includes('DO_NOT_RETURN'), false);
  for (const invalid of [
    { ...value, nonce: recoveryId },
    { ...value, configurationSha256: 'wrong' },
    {
      ...value,
      changedFiles: [{ pathSha256: 'private-file-name', sha256: 'e'.repeat(64), bytes: 0 }],
    },
    { ...value, dependencies: { ...value.dependencies, symlinkCount: 0 } },
    { ...value, barrier: { ...value.barrier, deadline: Date.now() - 1 } },
    { ...value, markerSha256: 'missing' },
    { ...value, markerEvidence: 'retained' },
  ])
    assert.throws(() => projectWorkspaceReport(invalid, input), {
      code: 'runtime_response_invalid',
    });
  const broken = response(value, {
    stream: events({ chunk: { contentDelta: { stderr: 'DO_NOT_RETURN_PRIVATE_MATERIAL' } } }),
  });
  await assert.rejects(readCommandResponse(broken, input), (error) => {
    assert.equal(error.code, 'runtime_command_failed');
    assert.equal(String(error).includes('DO_NOT_RETURN'), false);
    return true;
  });
  const f = operatorFixture();
  f.ports.command = async () => {
    throw new Error('DO_NOT_RETURN_PRIVATE_MATERIAL');
  };
  assert.equal(
    JSON.stringify(await runOperator(options(), f.ports)).includes('DO_NOT_RETURN'),
    false,
  );
});

test('retained reports require the pinned marker bytes, allow clean files and never expose a live proof', () => {
  const input = { ...operation('inspect', false), markerSha256 };
  const value = {
    ...remoteReport(input),
    changedFiles: [],
    barrier: { pid: 42, secret: 'DO_NOT_RETURN_PRIVATE_MATERIAL' },
  };
  const result = projectWorkspaceReport(value, input);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.markerSha256, markerSha256);
  assert.equal(result.markerEvidence, 'retained');
  assert.equal(result.barrier, undefined);
  assert.equal(JSON.stringify(result).includes('DO_NOT_RETURN'), false);
  for (const changed of [{ markerSha256: '8'.repeat(64) }, { markerEvidence: 'live' }])
    assert.throws(() => projectWorkspaceReport({ ...value, ...changed }, input), {
      code: 'runtime_response_invalid',
    });
});

test('runtime command acknowledgement, stream completion and output size are mandatory', async () => {
  const input = operation();
  const value = remoteReport(input);
  for (const changed of [
    { $metadata: { httpStatusCode: 202 } },
    { statusCode: 202 },
    { runtimeSessionId: nonce },
    { stream: undefined },
    { stream: events({ unexpected: 'PRIVATE_MATERIAL' }) },
    { stream: events({ chunk: { contentDelta: { stdout: JSON.stringify(value) } } }) },
    { stream: events({ chunk: { contentStop: { status: 'TIMED_OUT', exitCode: 0 } } }) },
    { stream: events({ chunk: { contentDelta: { stdout: 'PRIVATE_MATERIAL'.repeat(8000) } } }) },
  ]) {
    await assert.rejects(readCommandResponse(response(value, changed), input), (error) => {
      assert.ok(
        ['runtime_response_invalid', 'runtime_command_failed', 'runtime_output_limit'].includes(
          error.code,
        ),
      );
      assert.equal(String(error).includes('PRIVATE_MATERIAL'), false);
      return true;
    });
  }
  assert.throws(() => workspaceCommand({ ...input, unknown: 'x'.repeat(70_000) }), {
    code: 'invalid_arguments',
  });
});

test('bootstrap only accepts a cold observation for the exact owner, never a running harness', async () => {
  const row = stateFixture('RECOVERY_REQUIRED').row;
  await readBootstrapResponse(bootstrapResponse(), row);
  await readBootstrapResponse(
    bootstrapResponse({ status: 'publication_ready', recovered: true }),
    row,
  );
  for (const changed of [
    { status: 'running' },
    { status: 'publication_ready', recovered: false },
    { recovered: false },
    { attemptId: nonce },
    { writerGeneration: 2 },
  ])
    await assert.rejects(readBootstrapResponse(bootstrapResponse(changed), row), {
      code: 'bootstrap_unconfirmed',
    });
});

async function filesystemFixture(t, withBarrier = false) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'native-recovery-qualification-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const control = join(root, '.native-control');
  const owner = join(control, 'first-turn');
  const procRoot = join(root, 'proc');
  for (const path of [project, join(root, 'machine'), control, owner, procRoot])
    await fs.mkdir(path, { mode: 0o700 });
  await fs.mkdir(join(project, 'src'));
  await fs.writeFile(join(project, 'src/game.js'), 'export const paused = false;\n');
  const git = promisify(execFile);
  await git('git', ['init', '--quiet', project]);
  await git('git', ['-C', project, 'add', 'src/game.js']);
  await git('git', [
    '-C',
    project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'initial',
  ]);
  await fs.writeFile(join(project, 'src/game.js'), 'export const paused = true;\n');
  await fs.mkdir(join(project, 'node_modules/.bin'), { recursive: true });
  await fs.mkdir(join(project, 'node_modules/fixture'));
  await fs.writeFile(join(project, 'node_modules/fixture/bin.js'), 'fixture dependency\n');
  await fs.symlink('../fixture/bin.js', join(project, 'node_modules/.bin/fixture'));
  const nodes = {};
  for (const [name, path] of [
    ['root', root],
    ['project', project],
    ['machine', join(root, 'machine')],
  ])
    nodes[name] = { ino: String((await fs.lstat(path, { bigint: true })).ino) };
  const workspace = { schemaVersion: 1, identity, configurationSha256, packageId, nodes };
  await fs.writeFile(join(control, 'workspace.json'), JSON.stringify(workspace), { mode: 0o600 });
  await fs.writeFile(
    join(owner, 'owner.json'),
    JSON.stringify({
      schemaVersion: 1,
      identity,
      configurationSha256,
      writerGeneration: 1,
    }),
    { mode: 0o600 },
  );
  const fixture = { root, project, control, owner, procRoot, workspace };
  if (withBarrier) {
    // NFS and Linux /proc descriptions are simulated; file contents, Git
    // differences, links, renames, fsync and child liveness are real. This is
    // regression evidence, not an installed Claude/Linux/EFS qualification.
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    t.after(async () => {
      child.kill('SIGTERM');
      await exited;
    });
    const pid = child.pid;
    const ppid = process.pid;
    const startedAt = Date.now();
    const marker = {
      schemaVersion: 1,
      nonce,
      pid,
      ppid,
      startTicks: '12345',
      startedAt,
      deadline: startedAt + 150_000,
    };
    await fs.mkdir(join(project, '.ne02-qualification'), { mode: 0o700 });
    await fs.writeFile(
      join(project, '.ne02-qualification', nonce + '.json'),
      JSON.stringify(marker),
      { mode: 0o600 },
    );
    for (const [id, parent, argv] of [
      [pid, ppid, [process.execPath, '--input-type=module', '-e', barrierSource(nonce)]],
      [ppid, 1, ['/usr/local/bin/claude', '--print']],
    ]) {
      const dir = join(procRoot, String(id));
      await fs.mkdir(dir);
      const fields = ['S', String(parent), ...Array(17).fill('0'), '12345'];
      await fs.writeFile(join(dir, 'stat'), `${id} (fixture) ${fields.join(' ')}\n`);
      await fs.writeFile(join(dir, 'cmdline'), argv.join('\0') + '\0');
      await fs.symlink(project, join(dir, 'cwd'));
    }
    Object.assign(fixture, { child, exited, marker });
  }
  fixture.ports = { root, procRoot, inspectMount: async () => {} };
  return fixture;
}

test('active process inspection verifies real file hashes and dependency links without exposing names or bytes', async (t) => {
  const f = await filesystemFixture(t, true);
  const result = await runWorkspaceOperation(operation(), f.ports);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.barrier.pid, f.child.pid);
  assert.equal(result.markerEvidence, 'live');
  assert.equal(
    result.markerSha256,
    sha(await fs.readFile(join(f.project, '.ne02-qualification', nonce + '.json'))),
  );
  assert.deepEqual(result.changedFiles, [
    {
      pathSha256: sha('src/game.js'),
      sha256: sha('export const paused = true;\n'),
      bytes: Buffer.byteLength('export const paused = true;\n'),
    },
  ]);
  assert.equal(result.dependencies.symlinkCount, 1);
  assert.equal(result.dependencies.hardlinkedTargets, 0);
  assert.equal(JSON.stringify(result).includes('src/game.js'), false);
  assert.equal(JSON.stringify(result).includes('paused = true'), false);
  await fs.link(
    join(f.project, 'node_modules/fixture/bin.js'),
    join(f.project, 'node_modules/fixture/retained-link.js'),
  );
  const linked = await runWorkspaceOperation(operation(), f.ports);
  assert.equal(linked.ok, true);
  assert.equal(linked.dependencies.hardlinkedTargets, 1);
  assert.equal(linked.markerSha256, result.markerSha256);
  assert.notEqual(linked.dependencies.sha256, result.dependencies.sha256);
  f.child.kill('SIGTERM');
  await f.exited;
  const dead = await runWorkspaceOperation(operation(), f.ports);
  assert.equal(dead.ok, false);
  assert.equal(dead.code, 'barrier_not_active');
});

test('wrong process command, reused PID start time and expired marker cannot prove an active tool', async (t) => {
  const f = await filesystemFixture(t, true);
  const markerPath = join(f.project, '.ne02-qualification', nonce + '.json');
  for (const change of [
    { startTicks: 'another-process' },
    { deadline: Date.now() - 1 },
    { nonce: recoveryId },
  ]) {
    await fs.writeFile(markerPath, JSON.stringify({ ...f.marker, ...change }));
    assert.equal((await runWorkspaceOperation(operation(), f.ports)).ok, false);
  }
  await fs.writeFile(markerPath, JSON.stringify(f.marker));
  await fs.writeFile(join(f.procRoot, String(f.child.pid), 'cmdline'), 'node\0-e\0unrelated\0');
  assert.equal((await runWorkspaceOperation(operation(), f.ports)).code, 'barrier_invalid');
});

test('marker bytes and dependency link identities survive process loss and a fresh writer without a live-PID claim', async (t) => {
  const f = await filesystemFixture(t, true);
  const before = await runWorkspaceOperation(operation(), f.ports);
  assert.equal(before.ok, true);
  f.child.kill('SIGTERM');
  await f.exited;
  await fs.rm(f.procRoot, { recursive: true });
  await fs.mkdir(f.procRoot);
  const nextOwner = join(f.control, 'writer-2');
  await fs.mkdir(nextOwner, { mode: 0o700 });
  await fs.writeFile(
    join(nextOwner, 'owner.json'),
    JSON.stringify({
      schemaVersion: 1,
      identity,
      configurationSha256,
      writerGeneration: 2,
    }),
    { mode: 0o600 },
  );
  const retained = {
    ...operation('inspect', false),
    writerGeneration: 2,
    markerSha256: before.markerSha256,
  };
  const after = await runWorkspaceOperation(retained, f.ports);
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(after.markerEvidence, 'retained');
  assert.equal(after.barrier, undefined);
  assert.equal(after.markerSha256, before.markerSha256);
  assert.deepEqual(after.dependencies, before.dependencies);
  assert.deepEqual(after.changedFiles, before.changedFiles);
  const active = await runWorkspaceOperation({ ...retained, requireBarrier: true }, f.ports);
  assert.equal(active.ok, false);
  assert.equal(active.code, 'barrier_not_active');
  const git = promisify(execFile);
  await git('git', ['-C', f.project, 'add', 'src/game.js']);
  await git('git', [
    '-C',
    f.project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'completed implementation',
  ]);
  const committed = await runWorkspaceOperation(retained, f.ports);
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.deepEqual(committed.changedFiles, []);
  assert.equal(committed.markerSha256, before.markerSha256);
  assert.deepEqual(committed.dependencies, before.dependencies);
});

test('retained inspection rejects a missing or byte-tampered marker and a different workspace scope', async (t) => {
  const f = await filesystemFixture(t, true);
  const first = await runWorkspaceOperation(operation(), f.ports);
  assert.equal(first.ok, true);
  f.child.kill('SIGTERM');
  await f.exited;
  const markerPath = join(f.project, '.ne02-qualification', nonce + '.json');
  const original = await fs.readFile(markerPath);
  const retained = { ...operation('inspect', false), markerSha256: first.markerSha256 };
  for (const bytes of [
    Buffer.concat([original, Buffer.from('\n')]),
    Buffer.from(JSON.stringify({ ...f.marker, pid: f.marker.pid + 1 })),
    Buffer.from(JSON.stringify({ ...f.marker, nonce: recoveryId })),
  ]) {
    await fs.writeFile(markerPath, bytes);
    const result = await runWorkspaceOperation(retained, f.ports);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'barrier_invalid');
  }
  await fs.rm(markerPath);
  assert.equal((await runWorkspaceOperation(retained, f.ports)).code, 'barrier_invalid');
  await fs.writeFile(markerPath, original, { mode: 0o600 });
  f.workspace.identity = { ...identity, executionId: recoveryId };
  await fs.writeFile(join(f.control, 'workspace.json'), JSON.stringify(f.workspace));
  const wrongScope = await runWorkspaceOperation(retained, f.ports);
  assert.equal(wrongScope.ok, false);
  assert.equal(wrongScope.code, 'workspace_invalid');
});
for (const action of ['missing-project', 'wrong-project']) {
  test(`${action} quarantines the exact project inode and preserves all original data and control records`, async (t) => {
    const f = await filesystemFixture(t);
    const before = await fs.readFile(join(f.control, 'workspace.json'));
    const owner = await fs.readFile(join(f.owner, 'owner.json'));
    const result = await runWorkspaceOperation(operation(action, false), f.ports);
    assert.equal(result.ok, true, JSON.stringify(result));
    const retained = join(f.root, '.ne02-quarantine-' + nonce, 'project');
    assert.equal(
      String((await fs.lstat(retained, { bigint: true })).ino),
      f.workspace.nodes.project.ino,
    );
    assert.equal(
      await fs.readFile(join(retained, 'src/game.js'), 'utf8'),
      'export const paused = true;\n',
    );
    assert.equal(
      await fs.readlink(join(retained, 'node_modules/.bin/fixture')),
      '../fixture/bin.js',
    );
    assert.deepEqual(await fs.readFile(join(f.control, 'workspace.json')), before);
    assert.deepEqual(await fs.readFile(join(f.owner, 'owner.json')), owner);
    if (action === 'missing-project') await assert.rejects(fs.lstat(f.project), { code: 'ENOENT' });
    else {
      assert.notEqual(
        String((await fs.lstat(f.project, { bigint: true })).ino),
        f.workspace.nodes.project.ino,
      );
      assert.deepEqual(await fs.readdir(f.project), []);
      assert.equal((await fs.lstat(f.project)).mode & 0o777, 0o700);
    }
  });
}

test('wrong workspace binding, an existing quarantine, next writer or symlink blocks mutation', async (t) => {
  for (const change of ['identity', 'quarantine', 'next-writer', 'project-link']) {
    const f = await filesystemFixture(t);
    if (change === 'identity') {
      f.workspace.identity = { ...identity, executionId: nonce };
      await fs.writeFile(join(f.control, 'workspace.json'), JSON.stringify(f.workspace));
    } else if (change === 'quarantine') {
      await fs.mkdir(join(f.root, '.ne02-quarantine-' + nonce), { mode: 0o700 });
      await fs.writeFile(join(f.root, '.ne02-quarantine-' + nonce, 'keep'), 'original');
    } else if (change === 'next-writer')
      await fs.mkdir(join(f.control, 'writer-2'), { mode: 0o700 });
    else {
      await fs.rename(f.project, join(f.root, 'retained-project'));
      await fs.symlink(join(f.root, 'retained-project'), f.project);
    }
    const result = await runWorkspaceOperation(operation('wrong-project', false), f.ports);
    assert.equal(result.ok, false, change);
    assert.equal(result.quarantined, false, change);
    assert.equal(
      await fs.readFile(join(f.project, 'src/game.js'), 'utf8'),
      'export const paused = true;\n',
    );
    if (change === 'quarantine')
      assert.equal(
        await fs.readFile(join(f.root, '.ne02-quarantine-' + nonce, 'keep'), 'utf8'),
        'original',
      );
  }
});

test('a writer appearing during quarantine preparation blocks the rename', async (t) => {
  const f = await filesystemFixture(t);
  const ports = {
    ...f.ports,
    fs: {
      ...fs,
      mkdir: async (path, mkdirOptions) => {
        await fs.mkdir(path, mkdirOptions);
        if (path === join(f.root, '.ne02-quarantine-' + nonce))
          await fs.mkdir(join(f.control, 'writer-2'), { mode: 0o700 });
      },
    },
  };
  const result = await runWorkspaceOperation(operation('missing-project', false), ports);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'next_writer_exists');
  assert.equal(result.quarantined, false);
  assert.equal(
    await fs.readFile(join(f.project, 'src/game.js'), 'utf8'),
    'export const paused = true;\n',
  );
});

test('an active Claude process blocks a negative filesystem fault', async (t) => {
  const f = await filesystemFixture(t, true);
  const result = await runWorkspaceOperation(operation('wrong-project', false), f.ports);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'active_harness');
  assert.equal(result.quarantined, false);
  assert.ok((await fs.lstat(f.project)).isDirectory());
});

test('failure after rename reports retained quarantine and never deletes or restores through a collision', async (t) => {
  const f = await filesystemFixture(t);
  const outsider = join(f.root, 'unrelated');
  await fs.mkdir(outsider);
  await fs.writeFile(join(outsider, 'keep'), 'untouched');
  const result = await runWorkspaceOperation(operation('wrong-project', false), {
    ...f.ports,
    fs: {
      ...fs,
      rename: async (...values) => {
        await fs.rename(...values);
        await fs.symlink(outsider, f.project);
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.quarantined, true);
  assert.equal(await fs.readFile(join(outsider, 'keep'), 'utf8'), 'untouched');
  assert.equal(
    await fs.readFile(join(f.root, '.ne02-quarantine-' + nonce, 'project/src/game.js'), 'utf8'),
    'export const paused = true;\n',
  );
  assert.ok((await fs.lstat(f.project)).isSymbolicLink());
});
