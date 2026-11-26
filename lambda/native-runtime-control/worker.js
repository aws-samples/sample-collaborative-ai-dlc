import {
  createNativeRuntimeProvisioner,
  logNativeProvisioningDiagnostic,
  NATIVE_WORKSPACE_CHECK_TIMEOUT_MS,
} from './provisioner.js';
import { createNativeRuntimeStore } from './store.js';
import { controlError, validateDeployment } from './policies.js';
import { nativeRuntimeBindingKey } from '../shared/native-runtime-binding.js';

const array = (value) => {
  try {
    const result = JSON.parse(value);
    if (!Array.isArray(result) || !result.length || result.some((v) => typeof v !== 'string' || !v))
      throw new Error();
    return result;
  } catch {
    throw controlError('native_provisioning_configuration_invalid');
  }
};

export const nativeDeploymentFromEnv = (env) =>
  validateDeployment({
    accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
    region: env.AWS_REGION,
    partition: env.AWS_PARTITION,
    fileSystemId: env.NATIVE_RUNTIME_FILE_SYSTEM_ID,
    imageUri: env.NATIVE_RUNTIME_IMAGE_URI,
    imageDigest: env.NATIVE_RUNTIME_IMAGE_DIGEST,
    subnetIds: array(env.NATIVE_RUNTIME_SUBNET_IDS),
    securityGroupIds: array(env.NATIVE_RUNTIME_SECURITY_GROUP_IDS),
    permissionsBoundaryArn: env.NATIVE_RUNTIME_ROLE_BOUNDARY_ARN,
    ecrRepositoryArn: env.NATIVE_RUNTIME_ECR_REPOSITORY_ARN,
  });

// The protected store intentionally sanitizes SDK exceptions. Log selected
// metadata at this port before that happens, without serializing a command.
export const nativeDiagnosticDdb = (ddb, logger = console) => ({
  async send(command) {
    try {
      return await ddb.send(command);
    } catch (error) {
      const pk = command.input?.Key?.pk ?? command.input?.Item?.pk;
      const scopeHash =
        typeof pk === 'string' && /^NATIVE#[0-9a-f]{64}$/.test(pk) && pk.length === 71
          ? pk.slice(7)
          : undefined;
      const operation = ['GetCommand', 'PutCommand'].includes(command.constructor?.name)
        ? command.constructor.name
        : 'unknown';
      logNativeProvisioningDiagnostic(
        logger,
        {
          event: 'native_runtime_service_failure',
          service: 'dynamodb',
          operation,
          scopeHash,
        },
        error,
      );
      throw error;
    }
  },
});

const WAITING_PHASES = new Set(['access_point', 'iam_propagation', 'runtime', 'endpoint']);
const SCHEDULING_TIMEOUT_MS = 1000;
const SCHEDULING_RETURN_MARGIN_MS = 2000;

const logReadinessScheduling = (logger, fields, metadata) =>
  logNativeProvisioningDiagnostic(
    {
      info(text) {
        // Reuse the existing AWS metadata sanitizer without labeling a response
        // (including a successful response) as an exception.
        const sanitized = JSON.parse(text);
        delete sanitized.errorName;
        delete sanitized.errorCode;
        return logger.info(JSON.stringify(sanitized));
      },
    },
    fields,
    metadata === undefined ? undefined : { $metadata: metadata },
  );

const shortenReadinessWait = async (
  record,
  context,
  env,
  changeMessageVisibility,
  random,
  report,
) => {
  const rawCount = record.attributes?.ApproximateReceiveCount;
  if (typeof rawCount !== 'string' || rawCount.length > 16 || !/^[1-9]\d*$/.test(rawCount)) return;
  const count = Number(rawCount);
  if (!Number.isSafeInteger(count)) return;
  report.receiveCount = count;
  // Only the deployment's queue and this delivery's opaque receipt are usable.
  // Invalid scheduling metadata must leave the original retry intact.
  const region = env.AWS_REGION;
  const account = env.NATIVE_RUNTIME_ACCOUNT_ID;
  const partition = env.AWS_PARTITION;
  const queueUrl = env.NATIVE_RUNTIME_QUEUE_URL;
  if (
    typeof changeMessageVisibility !== 'function' ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region ?? '') ||
    !/^\d{12}$/.test(account ?? '') ||
    !['aws', 'aws-cn', 'aws-us-gov'].includes(partition) ||
    typeof queueUrl !== 'string'
  )
    return;
  const suffix = partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
  const prefix = `https://sqs.${region}.${suffix}/${account}/`;
  if (!queueUrl.startsWith(prefix)) return;
  const queueName = queueUrl.slice(prefix.length);
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(queueName) ||
    record.eventSourceARN !== `arn:${partition}:sqs:${region}:${account}:${queueName}` ||
    record.awsRegion !== region ||
    typeof record.receiptHandle !== 'string' ||
    !record.receiptHandle ||
    Buffer.byteLength(record.receiptHandle) > 4096 ||
    record.receiptHandle.trim() !== record.receiptHandle ||
    Array.from(record.receiptHandle).some((character) => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127;
    })
  )
    return;
  const jitter = random();
  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) return;
  const base = count === 1 ? 5 : count === 2 ? 10 : count === 3 ? 20 : 30;
  const visibility = Math.min(30, base + Math.floor(jitter * 3));
  report.delaySeconds = visibility;
  const remaining = context.getRemainingTimeInMillis?.();
  if (
    !Number.isFinite(remaining) ||
    remaining < SCHEDULING_TIMEOUT_MS + SCHEDULING_RETURN_MARGIN_MS
  )
    return;

  const controller = new AbortController();
  let timer;
  try {
    report.outcome = 'unconfirmed';
    // Bound the whole scheduling wait, including an ambiguous/lost response.
    // No resource operations follow the provisioner's conditional lease release.
    const response = await Promise.race([
      Promise.resolve().then(() =>
        changeMessageVisibility(
          {
            QueueUrl: queueUrl,
            ReceiptHandle: record.receiptHandle,
            VisibilityTimeout: visibility,
          },
          { abortSignal: controller.signal },
        ),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve();
        }, SCHEDULING_TIMEOUT_MS);
      }),
    ]);
    if (!controller.signal.aborted && response?.$metadata?.httpStatusCode === 200)
      report.outcome = 'scheduled';
    return response?.$metadata;
  } finally {
    clearTimeout(timer);
  }
};

export const createNativeRuntimeWorker =
  ({
    reconcile,
    changeMessageVisibility,
    random = Math.random,
    logger = console,
    env = process.env,
  }) =>
  async (event, context = {}) => {
    const failures = [];
    const allowed = array(env.NATIVE_PREPARATION_PROJECT_IDS);
    for (const record of event.Records ?? []) {
      try {
        if (
          env.NATIVE_PREPARATION_ENABLED !== 'true' ||
          record.eventSource !== 'aws:sqs' ||
          typeof record.body !== 'string' ||
          Buffer.byteLength(record.body) > 2048
        )
          throw new Error();
        const pointer = JSON.parse(record.body);
        if (
          !pointer ||
          Object.keys(pointer).toSorted().join(',') !== 'executionId,projectId' ||
          !allowed.includes(pointer.projectId) ||
          typeof pointer.executionId !== 'string' ||
          !pointer.executionId ||
          Buffer.byteLength(pointer.executionId) > 512
        )
          throw new Error();
        const result = await reconcile(pointer, {
          remainingMs: () => context.getRemainingTimeInMillis?.() ?? 25_000,
        });
        if (result.status === 'waiting' && WAITING_PHASES.has(result.phase)) {
          const scheduling = {
            event: 'native_runtime_readiness_scheduling',
            scopeHash: nativeRuntimeBindingKey(pointer).pk.slice('NATIVE#'.length),
            phase: result.phase,
            outcome: 'skipped',
          };
          let metadata;
          try {
            metadata = await shortenReadinessWait(
              record,
              context,
              env,
              changeMessageVisibility,
              random,
              scheduling,
            );
          } catch (error) {
            metadata = error?.$metadata;
          } finally {
            logReadinessScheduling(logger, scheduling, metadata);
          }
        }
        // Waiting remains a failed delivery even if changing visibility worked.
        // Never acknowledge pending work or replace it with an unproven enqueue.
        if (!['READY', 'FAILED', 'terminal', 'missing'].includes(result.status)) throw new Error();
      } catch {
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };

let worker;
export const handler = async (event, context) => {
  if (!worker) {
    const [efs, iam, control, runtime, dynamodb, document, sqs] = await Promise.all([
      import('@aws-sdk/client-efs'),
      import('@aws-sdk/client-iam'),
      import('@aws-sdk/client-bedrock-agentcore-control'),
      import('@aws-sdk/client-bedrock-agentcore'),
      import('@aws-sdk/client-dynamodb'),
      import('@aws-sdk/lib-dynamodb'),
      import('@aws-sdk/client-sqs'),
    ]);
    const deployment = nativeDeploymentFromEnv(process.env);
    const config = {
      region: deployment.region,
      maxAttempts: 1,
      requestHandler: { requestTimeout: 10_000, connectionTimeout: 2000 },
    };
    const port = (sdk, Client, methods, clientConfig) => {
      const client = new sdk[Client](clientConfig ?? config);
      return Object.fromEntries(
        methods.map((method) => [
          method,
          (input, options) =>
            client.send(
              new sdk[`${method[0].toUpperCase()}${method.slice(1)}Command`](input),
              options,
            ),
        ]),
      );
    };
    const services = {
      efs: port(efs, 'EFSClient', [
        'createAccessPoint',
        'describeAccessPoints',
        'describeFileSystems',
        'describeMountTargets',
        'describeFileSystemPolicy',
      ]),
      iam: port(iam, 'IAMClient', [
        'getRole',
        'createRole',
        'putRolePolicy',
        'getRolePolicy',
        'listRolePolicies',
        'listAttachedRolePolicies',
      ]),
      control: port(control, 'BedrockAgentCoreControlClient', [
        'createAgentRuntime',
        'getAgentRuntime',
        'createAgentRuntimeEndpoint',
        'getAgentRuntimeEndpoint',
      ]),
      runtime: {
        ...port(runtime, 'BedrockAgentCoreClient', ['invokeAgentRuntime'], {
          ...config,
          requestHandler: {
            ...config.requestHandler,
            requestTimeout: NATIVE_WORKSPACE_CHECK_TIMEOUT_MS,
          },
        }),
        ...port(runtime, 'BedrockAgentCoreClient', ['stopRuntimeSession']),
      },
    };
    const ddb = document.DynamoDBDocumentClient.from(new dynamodb.DynamoDBClient(config));
    const store = createNativeRuntimeStore({ ddb: nativeDiagnosticDdb(ddb), deployment });
    const queue = new sqs.SQSClient({
      region: deployment.region,
      maxAttempts: 1,
      requestHandler: { requestTimeout: SCHEDULING_TIMEOUT_MS, connectionTimeout: 500 },
    });
    worker = createNativeRuntimeWorker({
      reconcile: createNativeRuntimeProvisioner({ store, services, deployment }),
      changeMessageVisibility: (input, options) =>
        queue.send(new sqs.ChangeMessageVisibilityCommand(input), options),
    });
  }
  return worker(event, context);
};
