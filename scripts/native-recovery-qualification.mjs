#!/usr/bin/env node
// Operator-only qualification of fresh dev intents. No deployment, authority
// writes, model invocation, answer replay, EFS deletion or arbitrary commands.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createNativeExecutionStore,
  nativeWriterGeneration,
} from '../lambda/native-runtime-control/execution-store.js';
import {
  executionIdentity,
  executionRuntimeConfiguration,
} from '../lambda/native-runtime-control/execution-runtime.js';
import {
  nativeRuntimeBindingKey,
  resolveNativeRuntimeBinding,
} from '../lambda/shared/native-runtime-binding.js';
import {
  barrierCommand,
  qualificationCode,
  qualificationError,
  workspaceCommand,
} from './lib/native-recovery-qualification.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const ACTIONS = ['barrier-command', 'inspect', 'stop', 'missing-project', 'wrong-project'];
const LIMIT = 64 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => {
  throw qualificationError(code);
};
const negative = (action) => ['missing-project', 'wrong-project'].includes(action);
const send = (client, command) =>
  client.send(command, { abortSignal: AbortSignal.timeout(45_000) });
const destination = (row) => ({
  agentRuntimeArn: row.target.runtimeArn,
  qualifier: row.target.endpoint,
  runtimeSessionId: row.runtimeSessionId,
});

export const USAGE = `node scripts/native-recovery-qualification.mjs --action ACTION --profile NAME \\
  --expected-account ACCOUNT --region REGION --table TABLE --project-id UUID \\
  --intent-id UUID --attempt-id UUID --writer-generation INTEGER --nonce UUID \\
  [--marker-sha256 SHA256]
Actions: inspect, stop, missing-project, wrong-project.
Requires explicit operator authorization. solution-read is not accepted.
Use dedicated qualification intents; do not confirm resume while a fault command is running.
No command deploys or changes the authority record. Quarantined original files are retained.

Prepare the bounded real-tool fixture locally:
  node scripts/native-recovery-qualification.mjs --action barrier-command --nonce UUID
Ask Claude to run the printed command as one foreground Bash tool (timeout 180000 ms),
from /mnt/native/project, after genuine unpublished implementation edits and dependency
installation. It waits for 150 seconds. stop verifies it is still an active Claude child.
Changed-file hashes must also be compared with the preceding publication; an uncommitted
change alone does not establish that the change was unpublished.

stop requires RUNNING with the live tool barrier. inspect also accepts a published
AWAITING_USER boundary when --marker-sha256 pins the original pre-stop marker bytes.
It then reports retained evidence without claiming that the old process is alive.
Ordinary inspect never bootstraps a session. Missing/wrong-project actions require
RECOVERY_REQUIRED and a current confirmed stop.
They bootstrap only native-status, quarantine project, and stop the diagnostic VM with
a fresh token. They preserve .native-control, machine, the EFS mount and durable history.`;

export function parseQualificationArgs(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: Object.fromEntries([
      ...[
        'action',
        'profile',
        'expected-account',
        'region',
        'table',
        'project-id',
        'intent-id',
        'attempt-id',
        'writer-generation',
        'nonce',
        'marker-sha256',
      ].map((name) => [name, { type: 'string' }]),
      ['help', { type: 'boolean' }],
    ]),
  });
  if (values.help) return { help: true };
  const options = {
    action: values.action,
    profile: values.profile,
    account: values['expected-account'],
    region: values.region,
    table: values.table,
    projectId: values['project-id'],
    executionId: values['intent-id'],
    attemptId: values['attempt-id'],
    writerGeneration: Number(values['writer-generation']),
    nonce: values.nonce,
    markerSha256: values['marker-sha256'],
  };
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  if (!ACTIONS.includes(options.action) || !UUID.test(options.nonce ?? ''))
    fail('invalid_arguments');
  if (options.markerSha256 !== undefined && !SHA.test(options.markerSha256))
    fail('invalid_arguments');
  if (options.action === 'barrier-command') return;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.@+=:-]{0,127}$/.test(options.profile ?? '') ||
    !/^\d{12}$/.test(options.account ?? '') ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(options.region ?? '') ||
    !/^[A-Za-z0-9_.-]{3,255}$/.test(options.table ?? '') ||
    ![options.projectId, options.executionId, options.attemptId].every((value) =>
      UUID.test(value ?? ''),
    ) ||
    !Number.isSafeInteger(options.writerGeneration) ||
    options.writerGeneration < 1
  )
    fail('invalid_arguments');
  if (options.profile.toLowerCase() === 'solution-read') fail('read_only_profile');
}

export function validateState(state, options) {
  const { row, binding } = state ?? {};
  if (
    !row ||
    row.scope?.projectId !== options.projectId ||
    row.scope?.executionId !== options.executionId ||
    row.attemptId !== options.attemptId ||
    row.epoch !== 1 ||
    nativeWriterGeneration(row) !== options.writerGeneration ||
    row.cancelRequested !== false ||
    row.configuration?.accountId !== options.account ||
    row.configuration?.harness !== 'claude' ||
    row.configuration?.recoveryMode !== 'efs-workspace-v1' ||
    !row.target ||
    binding?.bindingId !== row.bindingId ||
    binding?.target?.agentRuntimeArn !== row.target.runtimeArn ||
    binding?.fileSystemId !== row.preparation?.fileSystemId ||
    binding?.accessPointArn !== row.preparation?.accessPointArn ||
    binding?.rootDirectory !== row.preparation?.rootDirectory ||
    binding?.mountPath !== '/mnt/native' ||
    !row.target.runtimeArn.startsWith(
      `arn:aws:bedrock-agentcore:${options.region}:${options.account}:runtime/`,
    ) ||
    row.target.endpoint !== `exec_${hash(row.attemptId).slice(0, 32)}` ||
    row.target.imageDigest !== row.configuration.image.digest ||
    !SHA.test(state.runtimeConfigurationSha256 ?? '')
  )
    fail('authority_mismatch');
  if (negative(options.action)) {
    if (
      row.status !== 'RECOVERY_REQUIRED' ||
      row.recovery?.canRecover !== true ||
      !UUID.test(row.recovery?.id ?? '') ||
      row.stopConfirmation?.runtimeSessionId !== row.runtimeSessionId ||
      row.stopConfirmation?.writerGeneration !== options.writerGeneration ||
      !Number.isSafeInteger(row.stopConfirmation?.confirmedAt) ||
      row.stopConfirmation.confirmedAt < row.startedAt
    )
      fail('authority_mismatch');
  } else if (
    row.status !== 'RUNNING' &&
    !(
      options.action === 'inspect' &&
      row.status === 'AWAITING_USER' &&
      SHA.test(row.publication?.id ?? '') &&
      row.publication.sequence === (row.turnSequence ?? 1)
    )
  )
    fail('authority_mismatch');
  if (
    options.action === 'inspect' &&
    row.status === 'AWAITING_USER' &&
    !SHA.test(options.markerSha256 ?? '')
  )
    fail('invalid_arguments');
  return state;
}

const stateFingerprint = ({ row, binding, runtimeConfigurationSha256 }) =>
  hash(
    JSON.stringify({
      identity: executionIdentity(row),
      writerGeneration: nativeWriterGeneration(row),
      status: row.status,
      sequence: row.turnSequence ?? 1,
      configurationSha256: row.configurationSha256,
      runtimeConfigurationSha256,
      target: row.target,
      binding,
      recovery: row.recovery,
      stopConfirmation: row.stopConfirmation,
      publication: row.publication?.id ?? null,
    }),
  );

const pins = ({ row, binding }) => ({
  ...executionIdentity(row),
  writerGeneration: nativeWriterGeneration(row),
  status: row.status,
  runtimeArn: row.target.runtimeArn,
  runtimeVersion: row.target.runtimeVersion,
  endpoint: row.target.endpoint,
  imageDigest: row.configuration.image.digest,
  accessPointArn: binding.accessPointArn,
  fileSystemId: binding.fileSystemId,
  rootDirectory: binding.rootDirectory,
  publicationId: row.publication?.id ?? null,
  publicationSequence: row.publication?.sequence ?? null,
});

export function validateStop(response, sessionId) {
  if (
    response?.$metadata?.httpStatusCode !== 200 ||
    response.statusCode !== 200 ||
    response.runtimeSessionId !== sessionId
  )
    fail('stop_unconfirmed');
}

export function validateResources({ row, binding }, options, { actual, endpoint, accessPoints }) {
  const accessPoint = accessPoints?.AccessPoints?.[0];
  const expectedEnv = {
    NATIVE_RUNTIME_MODE: 'isolated',
    NATIVE_RUNTIME_PROJECT_ID: options.projectId,
    NATIVE_RUNTIME_EXECUTION_ID: options.executionId,
    NATIVE_RUNTIME_BINDING_ID: row.bindingId,
    NATIVE_EXECUTION_ATTEMPT_ID: row.attemptId,
    NATIVE_EXECUTION_RUNTIME_SESSION_ID: row.runtimeSessionId,
    NATIVE_EXECUTION_EPOCH: String(row.epoch),
    NATIVE_EXECUTION_IMAGE_DIGEST: row.configuration.image.digest,
  };
  if (
    actual?.agentRuntimeArn !== row.target.runtimeArn ||
    actual.agentRuntimeVersion !== row.target.runtimeVersion ||
    actual.status !== 'READY' ||
    actual.roleArn !== binding.executionRoleArn ||
    actual.agentRuntimeArtifact?.containerConfiguration?.containerUri !==
      row.configuration.image.uri ||
    Object.entries(expectedEnv).some(
      ([key, value]) => actual.environmentVariables?.[key] !== value,
    ) ||
    actual.filesystemConfigurations?.length !== 1 ||
    actual.filesystemConfigurations[0].efsAccessPoint?.accessPointArn !== binding.accessPointArn ||
    actual.filesystemConfigurations[0].efsAccessPoint?.mountPath !== '/mnt/native' ||
    endpoint?.status !== 'READY' ||
    endpoint.name !== row.target.endpoint ||
    endpoint.agentRuntimeArn !== row.target.runtimeArn ||
    endpoint.agentRuntimeEndpointArn !== row.target.endpointArn ||
    endpoint.liveVersion !== row.target.runtimeVersion ||
    (endpoint.targetVersion != null && endpoint.targetVersion !== row.target.runtimeVersion) ||
    accessPoints?.AccessPoints?.length !== 1 ||
    accessPoint.AccessPointArn !== binding.accessPointArn ||
    accessPoint.OwnerId !== options.account ||
    accessPoint.FileSystemId !== binding.fileSystemId ||
    accessPoint.LifeCycleState !== 'available' ||
    accessPoint.RootDirectory?.Path !== binding.rootDirectory ||
    accessPoint.RootDirectory?.CreationInfo?.OwnerUid !== 1000 ||
    accessPoint.RootDirectory?.CreationInfo?.OwnerGid !== 1000 ||
    accessPoint.RootDirectory?.CreationInfo?.Permissions !== '700' ||
    accessPoint.PosixUser?.Uid !== 1000 ||
    accessPoint.PosixUser?.Gid !== 1000
  )
    fail('resource_mismatch');
}

// Never return raw stdout/stderr, bootstrap bodies, SDK exceptions or unknown
// fields. The fixed remote command itself emits this small metadata schema.
export function projectWorkspaceReport(value, input) {
  if (
    value?.schemaVersion !== 1 ||
    typeof value.ok !== 'boolean' ||
    value.action !== input.action ||
    value.nonce !== input.nonce
  )
    fail('runtime_response_invalid');
  const report = { schemaVersion: 1, ok: value.ok, action: value.action, nonce: value.nonce };
  if (!value.ok)
    return {
      ...report,
      code: qualificationCode(value),
      quarantined: value.quarantined === true,
    };
  for (const key of ['rootInode', 'projectInode', 'machineInode']) {
    if (!/^\d{1,24}$/.test(value[key] ?? '')) fail('runtime_response_invalid');
    report[key] = value[key];
  }
  if (
    !SHA.test(value.workspaceSha256 ?? '') ||
    value.configurationSha256 !== input.configurationSha256
  )
    fail('runtime_response_invalid');
  report.workspaceSha256 = value.workspaceSha256;
  report.configurationSha256 = value.configurationSha256;
  if (input.action !== 'inspect') {
    if (value.quarantined !== true) fail('runtime_response_invalid');
    report.quarantined = true;
    if (input.action === 'wrong-project') {
      if (
        !/^\d{1,24}$/.test(value.replacementInode ?? '') ||
        value.replacementInode === value.projectInode
      )
        fail('runtime_response_invalid');
      report.replacementInode = value.replacementInode;
    }
    return report;
  }
  if (
    !SHA.test(value.markerSha256 ?? '') ||
    (!input.requireBarrier && !SHA.test(input.markerSha256 ?? '')) ||
    (input.markerSha256 !== undefined && value.markerSha256 !== input.markerSha256) ||
    value.markerEvidence !== (input.requireBarrier ? 'live' : 'retained')
  )
    fail('runtime_response_invalid');
  report.markerSha256 = value.markerSha256;
  report.markerEvidence = value.markerEvidence;
  if (
    !Array.isArray(value.changedFiles) ||
    (input.requireBarrier && !value.changedFiles.length) ||
    value.changedFiles.length > 32
  )
    fail('runtime_response_invalid');
  report.changedFiles = value.changedFiles.map((file) => {
    if (
      !SHA.test(file?.pathSha256 ?? '') ||
      !SHA.test(file?.sha256 ?? '') ||
      !Number.isSafeInteger(file?.bytes) ||
      file.bytes < 0 ||
      file.bytes > 8 * 1024 * 1024
    )
      fail('runtime_response_invalid');
    return { pathSha256: file.pathSha256, sha256: file.sha256, bytes: file.bytes };
  });
  const links = value.dependencies;
  if (
    !Number.isSafeInteger(links?.symlinkCount) ||
    links.symlinkCount < 1 ||
    links.symlinkCount > 512 ||
    !Number.isSafeInteger(links?.hardlinkedTargets) ||
    links.hardlinkedTargets < 0 ||
    links.hardlinkedTargets > links.symlinkCount ||
    !SHA.test(links?.sha256 ?? '')
  )
    fail('runtime_response_invalid');
  report.dependencies = {
    symlinkCount: links.symlinkCount,
    hardlinkedTargets: links.hardlinkedTargets,
    sha256: links.sha256,
  };
  if (!input.requireBarrier) return report;
  const barrier = value.barrier;
  for (const key of ['pid', 'ppid', 'claudePid', 'deadline', 'observedAt'])
    if (!Number.isSafeInteger(barrier?.[key]) || barrier[key] < 2) fail('runtime_response_invalid');
  if (
    !/^\d{1,24}$/.test(barrier.startTicks ?? '') ||
    Math.abs(Date.now() - barrier.observedAt) > 15_000 ||
    barrier.deadline - barrier.observedAt < 45_000 ||
    barrier.deadline - barrier.observedAt > 150_000
  )
    fail('runtime_response_invalid');
  report.barrier = Object.fromEntries(
    ['pid', 'ppid', 'claudePid', 'startTicks', 'deadline', 'observedAt'].map((key) => [
      key,
      barrier[key],
    ]),
  );
  return report;
}

export async function readCommandResponse(response, input) {
  if (
    response?.$metadata?.httpStatusCode !== 200 ||
    response.statusCode !== 200 ||
    response.runtimeSessionId !== input.identity.runtimeSessionId ||
    !response.stream
  )
    fail('runtime_response_invalid');
  let stdout = '';
  let size = 0;
  let stop;
  for await (const event of response.stream) {
    if (!event.chunk || stop) fail('runtime_response_invalid');
    const { contentDelta, contentStop } = event.chunk;
    for (const key of ['stdout', 'stderr']) {
      const text = contentDelta?.[key];
      if (text === undefined) continue;
      if (typeof text !== 'string') fail('runtime_response_invalid');
      size += Buffer.byteLength(text);
      if (size > LIMIT) fail('runtime_output_limit');
      if (key === 'stderr' && text) fail('runtime_command_failed');
      if (key === 'stdout') stdout += text;
    }
    if (contentStop) stop = contentStop;
  }
  if (stop?.status !== 'COMPLETED') fail('runtime_command_failed');
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    fail('runtime_response_invalid');
  }
  const report = projectWorkspaceReport(value, input);
  if (stop.exitCode !== (report.ok ? 0 : 1)) fail('runtime_response_invalid');
  return report;
}

export async function readBootstrapResponse(response, row) {
  if (
    response?.$metadata?.httpStatusCode !== 200 ||
    response.statusCode !== 200 ||
    response.runtimeSessionId !== row.runtimeSessionId ||
    !response.response
  )
    fail('bootstrap_unconfirmed');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.response) {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) fail('bootstrap_unconfirmed');
    size += Buffer.byteLength(chunk);
    if (size > LIMIT) fail('runtime_output_limit');
    chunks.push(Buffer.from(chunk));
  }
  let report;
  try {
    report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('bootstrap_unconfirmed');
  }
  if (
    report.schemaVersion !== 1 ||
    Object.entries(executionIdentity(row)).some(([key, value]) => report[key] !== value) ||
    (report.writerGeneration ?? 1) !== nativeWriterGeneration(row) ||
    !(
      (report.status === 'publication_ready' && report.recovered === true) ||
      (report.status === 'stopped_needs_review' &&
        report.code === 'native_execution_existing_owner' &&
        report.recovered !== false)
    )
  )
    fail('bootstrap_unconfirmed');
}

export async function runOperator(options, ports) {
  validateOptions(options);
  if (options.action === 'barrier-command') return barrierCommand(options.nonce);
  const report = { schemaVersion: 1, action: options.action, nonce: options.nonce, ok: false };
  let initial;
  let fingerprint;
  let bootstrapAttempted = false;
  const diagnosticToken = randomUUID();
  const checked = async () => {
    const state = validateState(await ports.readState(), options);
    if (fingerprint && stateFingerprint(state) !== fingerprint) fail('authority_changed');
    await ports.verifyResources(state);
    const latest = validateState(await ports.readState(), options);
    if (stateFingerprint(latest) !== stateFingerprint(state)) fail('authority_changed');
    return latest;
  };
  try {
    if ((await ports.account()) !== options.account) fail('account_mismatch');
    initial = await checked();
    fingerprint = stateFingerprint(initial);
    report.pins = pins(initial);
    if (negative(options.action)) {
      const state = await checked();
      bootstrapAttempted = true;
      await readBootstrapResponse(await ports.bootstrap(state.row), state.row);
    }
    const state = await checked();
    const input = {
      action: negative(options.action) ? options.action : 'inspect',
      nonce: options.nonce,
      identity: executionIdentity(state.row),
      writerGeneration: options.writerGeneration,
      configurationSha256: state.runtimeConfigurationSha256,
      packageId: state.row.configuration.packageId,
      requireBarrier: state.row.status === 'RUNNING',
      markerSha256: options.markerSha256,
    };
    report.workspace = await readCommandResponse(await ports.command(state.row, input), input);
    if (!report.workspace.ok) fail(report.workspace.code);
    await checked();
    if (options.action === 'stop') {
      const current = await checked();
      const token = hash(JSON.stringify({ fingerprint, nonce: options.nonce, action: 'stop' }));
      if (report.workspace.barrier && report.workspace.barrier.deadline - Date.now() < 15_000)
        fail('barrier_not_active');
      validateStop(await ports.stop(current.row, token), current.row.runtimeSessionId);
      if (report.workspace.barrier && report.workspace.barrier.deadline <= Date.now())
        fail('barrier_not_active');
      report.stop = { confirmed: true, clientToken: token };
    }
    report.ok = true;
  } catch (error) {
    report.code = qualificationCode(error);
  } finally {
    if (bootstrapAttempted) {
      try {
        const current = await checked();
        validateStop(await ports.stop(current.row, diagnosticToken), current.row.runtimeSessionId);
        report.diagnosticStop = { confirmed: true, clientToken: diagnosticToken };
      } catch (error) {
        report.ok = false;
        report.diagnosticStop = { confirmed: false, code: qualificationCode(error) };
        report.code ??= 'stop_unconfirmed';
      }
    }
  }
  return report;
}

export async function livePorts(options) {
  const [
    { fromIni },
    { DynamoDBClient },
    { DynamoDBDocumentClient, GetCommand },
    {
      BedrockAgentCoreClient,
      InvokeAgentRuntimeCommand,
      InvokeAgentRuntimeCommandCommand,
      StopRuntimeSessionCommand,
    },
    { BedrockAgentCoreControlClient, GetAgentRuntimeCommand, GetAgentRuntimeEndpointCommand },
    { EFSClient, DescribeAccessPointsCommand },
  ] = await Promise.all([
    import('@aws-sdk/credential-providers'),
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
    import('@aws-sdk/client-bedrock-agentcore'),
    import('@aws-sdk/client-bedrock-agentcore-control'),
    import('@aws-sdk/client-efs'),
  ]);
  const config = {
    region: options.region,
    credentials: fromIni({ profile: options.profile }),
    maxAttempts: 1,
  };
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(config));
  const runtime = new BedrockAgentCoreClient(config);
  const control = new BedrockAgentCoreControlClient(config);
  const efs = new EFSClient(config);
  const identity = { projectId: options.projectId, executionId: options.executionId };
  const preparation = {
    get: async () =>
      (
        await send(
          ddb,
          new GetCommand({
            TableName: options.table,
            Key: nativeRuntimeBindingKey(identity),
            ConsistentRead: true,
          }),
        )
      ).Item,
  };
  const store = createNativeExecutionStore({
    ddb: { send: (command) => send(ddb, command) },
    tableName: options.table,
    preparationStore: preparation,
  });
  return {
    account: async () => {
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
          '--query',
          'Account',
          '--output',
          'text',
        ],
        { timeout: 45_000, maxBuffer: 4096, env: { ...process.env, AWS_PAGER: '' } },
      );
      return result.stdout.trim();
    },
    readState: async () => {
      try {
        const [row, draft] = await Promise.all([store.get(identity), preparation.get()]);
        if (!row || !draft) fail('authority_read_failed');
        const binding = await resolveNativeRuntimeBinding({
          ddb: { send: async () => ({ Item: draft }) },
          tableName: options.table,
          ...identity,
          deployment: {
            partition: 'aws',
            accountId: options.account,
            region: options.region,
            fileSystemId: row.preparation.fileSystemId,
          },
        });
        return {
          row,
          binding,
          runtimeConfigurationSha256: hash(
            JSON.stringify(executionRuntimeConfiguration(draft, row)),
          ),
        };
      } catch {
        fail('authority_read_failed');
      }
    },
    verifyResources: async ({ row, binding }) => {
      const [actual, endpoint, accessPoints] = await Promise.all([
        send(
          control,
          new GetAgentRuntimeCommand({
            agentRuntimeId: row.target.runtimeId,
            agentRuntimeVersion: row.target.runtimeVersion,
          }),
        ),
        send(
          control,
          new GetAgentRuntimeEndpointCommand({
            agentRuntimeId: row.target.runtimeId,
            endpointName: row.target.endpoint,
          }),
        ),
        send(
          efs,
          new DescribeAccessPointsCommand({
            AccessPointId: binding.accessPointArn.split('/').at(-1),
          }),
        ),
      ]);
      validateResources({ row, binding }, options, { actual, endpoint, accessPoints });
    },
    bootstrap: (row) =>
      send(
        runtime,
        new InvokeAgentRuntimeCommand({
          ...destination(row),
          contentType: 'application/json',
          accept: 'application/json',
          payload: Buffer.from(
            JSON.stringify({
              command: 'native-status',
              ...executionIdentity(row),
              writerGeneration: nativeWriterGeneration(row),
            }),
          ),
        }),
      ),
    command: (row, input) =>
      send(
        runtime,
        new InvokeAgentRuntimeCommandCommand({
          ...destination(row),
          body: { command: workspaceCommand(input), timeout: 30 },
        }),
      ),
    stop: (row, clientToken) =>
      send(
        runtime,
        new StopRuntimeSessionCommand({
          ...destination(row),
          clientToken,
        }),
      ),
  };
}

async function main() {
  try {
    const options = parseQualificationArgs(process.argv.slice(2));
    if (options.help) return console.log(USAGE);
    if (options.action === 'barrier-command') return console.log(barrierCommand(options.nonce));
    const result = await runOperator(options, await livePorts(options));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, code: qualificationCode(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
