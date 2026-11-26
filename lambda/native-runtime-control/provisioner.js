import { createHash } from 'node:crypto';
import {
  nativeRuntimeBindingKey,
  nativeRuntimeResourceNames,
} from '../shared/native-runtime-binding.js';
import {
  canonicalJson,
  controlError,
  fileSystemPolicy,
  resourceToken,
  runtimePolicyDocuments,
  samePolicy,
  validateDeployment,
} from './policies.js';

const POLICY_NAME = 'native-runtime';
const ROLE_PROPAGATION_WINDOW_MS = 10 * 60_000;
// Fresh runtime invocations measured 50–52 seconds in dev. This ceiling fits
// inside the 90-second preparation worker; remaining time and lease still win.
export const NATIVE_WORKSPACE_CHECK_TIMEOUT_MS = 80_000;
const WORKSPACE_CHECK_CLEANUP_RESERVE_MS = 8000;
// IAM GetRole returns "Policy", while its SDK enum declares
// "PermissionsBoundaryPolicy". Both identify an attached managed-policy
// boundary; the ARN must still equal the configured boundary exactly.
const BOUNDARY_TYPES = new Set(['Policy', 'PermissionsBoundaryPolicy']);
const mismatch = () => {
  throw controlError('native_provisioning_resource_mismatch');
};
const pending = () => {
  throw controlError('native_provisioning_pending');
};
// Only a completed, verified readiness check can take the cooperative retry
// path. SDK errors, exhausted budgets and uncertain mutations remain pending.
class ReadinessWait extends Error {
  constructor(phase) {
    super('native_provisioning_pending');
    this.code = 'native_provisioning_pending';
    this.phase = phase;
  }
}
const requireEqual = (a, b) => {
  if (canonicalJson(a) !== canonicalJson(b)) mismatch();
};
const missing = (error) =>
  ['NoSuchEntityException', 'NoSuchEntity', 'ResourceNotFoundException'].includes(error?.name);
const transient = (error) =>
  [
    'AbortError',
    'TimeoutError',
    'ThrottlingException',
    'Throttling',
    'TooManyRequestsException',
    'ServiceUnavailableException',
    'InternalServerException',
    'ServiceException',
    'ConflictException',
    'ConcurrentModification',
    'EntityAlreadyExistsException',
    'EntityAlreadyExists',
    'AccessPointNotFound',
  ].includes(error?.name) ||
  missing(error) ||
  ['ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN'].includes(error?.code) ||
  error?.$metadata?.httpStatusCode >= 500;
const accessDenied = (error) =>
  ['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation'].includes(error?.name);
const terminalCodes = new Set([
  'native_provisioning_resource_mismatch',
  'native_provisioning_verification_failed',
  'native_provisioning_source_changed',
  'native_provisioning_configuration_invalid',
]);

const diagnosticErrorNames = new Set([
  'Error',
  'TypeError',
  'AbortError',
  'TimeoutError',
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'ValidationException',
  'InvalidParameterValue',
  'InvalidParameterValueException',
  'NoSuchEntity',
  'NoSuchEntityException',
  'ResourceNotFoundException',
  'AccessPointNotFound',
  'AccessPointAlreadyExists',
  'FileSystemNotFound',
  'PolicyNotFound',
  'BadRequest',
  'IncorrectFileSystemLifeCycleState',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'InternalServerException',
  'InternalServerError',
  'ServiceException',
  'ConflictException',
  'ConcurrentModification',
  'EntityAlreadyExists',
  'EntityAlreadyExistsException',
  'LimitExceeded',
  'ServiceQuotaExceededException',
  'ConditionalCheckFailedException',
  'ProvisionedThroughputExceededException',
  'ResourceInUseException',
  'InvalidSignatureException',
  'ExpiredTokenException',
  'UnrecognizedClientException',
]);
const diagnosticErrorCodes = new Set([
  ...diagnosticErrorNames,
  ...terminalCodes,
  'native_provisioning_access_denied',
  'native_provisioning_failed',
  'native_provisioning_pending',
  'native_deployment_invalid',
  'NATIVE_PREPARATION_INVALID',
  'NATIVE_PREPARATION_UNAVAILABLE',
  'NATIVE_PREPARATION_LEASE_LOST',
  'NATIVE_PREPARATION_CONFLICT',
  'NATIVE_PREPARATION_NOT_FOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

// Only fixed application fields and selected AWS metadata reach the logger.
// Unknown names/codes are not echoed: those properties can also contain text.
export const logNativeProvisioningDiagnostic = (logger, fields, error) => {
  try {
    const record = { ...fields };
    if (error !== undefined) {
      record.errorName = diagnosticErrorNames.has(error?.name) ? error.name : 'UnknownError';
      if (typeof error?.code === 'string') {
        record.errorCode = diagnosticErrorCodes.has(error.code) ? error.code : 'UnknownErrorCode';
      }
      const metadata = error?.$metadata;
      if (
        Number.isInteger(metadata?.httpStatusCode) &&
        metadata.httpStatusCode >= 100 &&
        metadata.httpStatusCode <= 599
      ) {
        record.httpStatus = metadata.httpStatusCode;
      }
      const requestId = metadata?.requestId;
      if (
        typeof requestId === 'string' &&
        requestId.length === 36 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)
      ) {
        record.requestId = requestId;
      }
    }
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) > 1024) return;
    const result = logger.info(text);
    // Observability must not change lease/resource behavior, including when an
    // injected async sink rejects. Never log that secondary exception either.
    Promise.resolve(result).catch(() => {});
  } catch {
    /* A failed logger cannot become a provisioning failure. */
  }
};

export const nativeRuntimeEnvironment = (row) => ({
  NATIVE_RUNTIME_MODE: 'isolated',
  NATIVE_RUNTIME_PROJECT_ID: row.projectId,
  NATIVE_RUNTIME_EXECUTION_ID: row.executionId,
  NATIVE_RUNTIME_BINDING_ID: row.bindingId,
  // Correlation, not a credential. Stable across an acknowledged-lost create.
  NATIVE_RUNTIME_CHECK_NONCE: resourceToken('workspace-check', row),
});

const payloadFor = (row) => ({
  command: 'native-workspace-check',
  projectId: row.projectId,
  executionId: row.executionId,
  bindingId: row.bindingId,
  nonce: resourceToken('workspace-check', row),
});

export const verifyWorkspaceProof = (row, report) => {
  const payload = payloadFor(row);
  const { command: _command, ...identity } = payload;
  const content = Buffer.from(`${JSON.stringify({ format: 1, ...identity })}\n`);
  const evidence = report?.evidence;
  if (
    !report ||
    report.ok !== true ||
    Object.entries(payload).some(([key, value]) => report[key] !== value) ||
    !evidence ||
    evidence.mountPath !== '/mnt/native' ||
    !['nfs', 'nfs4'].includes(evidence.filesystemType) ||
    evidence.uid !== 1000 ||
    evidence.gid !== 1000 ||
    evidence.bytes !== content.length ||
    evidence.sha256 !== createHash('sha256').update(content).digest('hex') ||
    evidence.hardlinkSameInode !== true ||
    evidence.linkCount !== 2 ||
    evidence.atomicRename !== true ||
    evidence.cleanupComplete !== true
  ) {
    throw controlError('native_provisioning_verification_failed');
  }
};

const readProof = async (response, signal) => {
  if (response?.statusCode !== 200 || response.contentType?.split(';')[0] !== 'application/json') {
    throw controlError('native_provisioning_verification_failed');
  }
  const chunks = [];
  let length = 0;
  const body = response.response;
  if (!body || (!body[Symbol.asyncIterator] && !(body instanceof Uint8Array))) {
    throw controlError('native_provisioning_verification_failed');
  }
  const abort = () => body.destroy?.();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const source = body instanceof Uint8Array ? [body] : body;
    for await (const chunk of source) {
      if (signal.aborted) pending();
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > 8192) throw controlError('native_provisioning_verification_failed');
      chunks.push(bytes);
    }
    if (signal.aborted) pending();
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw controlError('native_provisioning_verification_failed');
    }
  } finally {
    signal.removeEventListener('abort', abort);
    body.destroy?.();
  }
};

// Service ports map one-for-one to SDK operations. No AWS clients are created
// here, and neither the SQS body nor a runtime report supplies resource config.
export const createNativeRuntimeProvisioner = ({
  store,
  services,
  deployment,
  now = Date.now,
  logger = console,
}) => {
  const configuredDeployment = validateDeployment(deployment);
  return async (pointer, { remainingMs = () => 25_000 } = {}) => {
    const startedAt = now();
    let row;
    let diagnosticStarted = false;
    let d = configuredDeployment;
    const scopeHash = nativeRuntimeBindingKey(pointer).pk.slice('NATIVE#'.length);
    let lastService;
    let lastOperation;
    const outcome = (result, error) => {
      logNativeProvisioningDiagnostic(
        logger,
        {
          event: 'native_runtime_reconciliation_outcome',
          scopeHash,
          service: lastService,
          operation: lastOperation,
          status: result.status,
          elapsedMs: Math.max(0, now() - startedAt),
          ...(result.phase ? { phase: result.phase } : {}),
          ...(result.code ? { code: result.code } : {}),
        },
        error,
      );
      return result;
    };
    const lease = () => ({
      projectId: row.projectId,
      executionId: row.executionId,
      bindingId: row.bindingId,
      version: row.version,
      fence: row.fence,
      leaseToken: row.leaseToken,
    });
    const budget = () => {
      const available = Math.min(remainingMs() - 2500, row?.leaseExpiresAt - now() - 1000);
      if (!Number.isFinite(available) || available < 1000) pending();
      return Math.min(available, 10_000);
    };
    const workspaceCheckBudget = () => {
      // First invocation can take longer than a control-plane request. Bound
      // invocation plus proof reading together, reserving time under BOTH the
      // Lambda deadline and ownership lease for stop and final verification.
      const available = Math.min(
        remainingMs() - WORKSPACE_CHECK_CLEANUP_RESERVE_MS,
        row?.leaseExpiresAt - now() - WORKSPACE_CHECK_CLEANUP_RESERVE_MS,
        NATIVE_WORKSPACE_CHECK_TIMEOUT_MS,
      );
      if (!Number.isFinite(available) || available < 1000) pending();
      return available;
    };
    const owned = async () => {
      const current = await store.get(pointer);
      if (
        !current ||
        current.status !== 'PREPARING' ||
        ['bindingId', 'version', 'fence', 'leaseToken'].some((key) => current[key] !== row[key]) ||
        current.leaseExpiresAt <= now()
      )
        throw controlError('NATIVE_PREPARATION_LEASE_LOST');
      budget();
    };
    const call = async (service, method, input, options) => {
      await owned();
      lastService = service;
      lastOperation = method;
      try {
        return await services[service][method](
          input,
          options ?? { abortSignal: AbortSignal.timeout(budget()) },
        );
      } catch (error) {
        logNativeProvisioningDiagnostic(
          logger,
          {
            event: 'native_runtime_service_failure',
            scopeHash,
            service,
            operation: method,
          },
          error,
        );
        throw error;
      }
    };
    const advance = async (patch) => {
      row = await store.advance({ ...lease(), patch });
    };
    const tags = () => ({ NativeBinding: row.bindingId, NativeScope: resourceToken('scope', row) });
    const tagList = () => Object.entries(tags()).map(([Key, Value]) => ({ Key, Value }));
    const checkTags = (actual) => {
      const map = Object.fromEntries((actual ?? []).map(({ Key, Value }) => [Key, Value]));
      for (const [key, value] of Object.entries(tags())) if (map[key] !== value) mismatch();
    };
    let documents;
    let names;
    let verifiedRoleCreatedAt;
    const verifyAp = async () => {
      const id = row.accessPointArn.split('/').at(-1);
      const result = await call('efs', 'describeAccessPoints', { AccessPointId: id });
      if (result.NextToken || result.AccessPoints?.length !== 1) mismatch();
      const ap = result.AccessPoints[0];
      if (
        ap.AccessPointArn !== row.accessPointArn ||
        ap.AccessPointId !== id ||
        ap.FileSystemId !== d.fileSystemId ||
        ap.OwnerId !== d.accountId ||
        ap.ClientToken !== resourceToken('efs', row)
      )
        mismatch();
      requireEqual(ap.PosixUser, { Uid: 1000, Gid: 1000 });
      const root = structuredClone(ap.RootDirectory);
      if (
        !/^0?[0-7]{3}$/.test(root?.CreationInfo?.Permissions ?? '') ||
        Number.parseInt(root.CreationInfo.Permissions, 8) !== 0o700
      )
        mismatch();
      root.CreationInfo.Permissions = '700';
      requireEqual(root, {
        Path: names.rootDirectory,
        CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '700' },
      });
      checkTags(ap.Tags);
      if (['deleting', 'deleted', 'error'].includes(ap.LifeCycleState)) mismatch();
      if (ap.LifeCycleState === 'creating') throw new ReadinessWait('access_point');
      if (ap.LifeCycleState !== 'available') pending();
    };
    const verifyFs = async () => {
      const result = await call('efs', 'describeFileSystems', { FileSystemId: d.fileSystemId });
      const fs = result.FileSystems?.[0];
      if (
        result.NextMarker ||
        result.FileSystems?.length !== 1 ||
        fs.FileSystemId !== d.fileSystemId ||
        fs.OwnerId !== d.accountId ||
        fs.Encrypted !== true
      )
        mismatch();
      if (fs.LifeCycleState !== 'available') pending();
      const mounts = await call('efs', 'describeMountTargets', { FileSystemId: d.fileSystemId });
      if (
        mounts.NextMarker ||
        !Array.isArray(mounts.MountTargets) ||
        mounts.MountTargets.some(
          (m) => m.FileSystemId !== d.fileSystemId || m.OwnerId !== d.accountId,
        )
      )
        mismatch();
      if (
        d.subnetIds.some(
          (id) =>
            !mounts.MountTargets.some((m) => m.SubnetId === id && m.LifeCycleState === 'available'),
        )
      )
        pending();
      const policy = await call('efs', 'describeFileSystemPolicy', {
        FileSystemId: d.fileSystemId,
      });
      if (policy.FileSystemId !== d.fileSystemId || !samePolicy(policy.Policy, fileSystemPolicy(d)))
        mismatch();
    };
    const verifyRole = async ({ installMissing = false } = {}) => {
      let result;
      try {
        result = await call('iam', 'getRole', { RoleName: names.roleName });
      } catch (error) {
        if (missing(error) && installMissing) return false;
        throw error;
      }
      const role = result.Role;
      if (
        !role ||
        role.Arn !== documents.roleArn ||
        role.RoleName !== names.roleName ||
        role.Path !== '/native-runs/' ||
        role.PermissionsBoundary?.PermissionsBoundaryArn !== d.permissionsBoundaryArn ||
        !BOUNDARY_TYPES.has(role.PermissionsBoundary?.PermissionsBoundaryType) ||
        !samePolicy(role.AssumeRolePolicyDocument, documents.trustPolicy)
      )
        mismatch();
      checkTags(role.Tags);
      const attached = await call('iam', 'listAttachedRolePolicies', { RoleName: names.roleName });
      if (
        attached.IsTruncated ||
        !Array.isArray(attached.AttachedPolicies) ||
        attached.AttachedPolicies.length
      )
        mismatch();
      const inline = await call('iam', 'listRolePolicies', { RoleName: names.roleName });
      if (
        inline.IsTruncated ||
        !Array.isArray(inline.PolicyNames) ||
        inline.PolicyNames.some((p) => p !== POLICY_NAME) ||
        inline.PolicyNames.length > 1
      )
        mismatch();
      if (!inline.PolicyNames.length) {
        if (!installMissing) pending();
        await call('iam', 'putRolePolicy', {
          RoleName: names.roleName,
          PolicyName: POLICY_NAME,
          PolicyDocument: JSON.stringify(documents.permissionsPolicy),
        });
      }
      const policy = await call('iam', 'getRolePolicy', {
        RoleName: names.roleName,
        PolicyName: POLICY_NAME,
      });
      if (
        policy.RoleName !== names.roleName ||
        policy.PolicyName !== POLICY_NAME ||
        !samePolicy(policy.PolicyDocument, documents.permissionsPolicy)
      )
        mismatch();
      verifiedRoleCreatedAt =
        role.CreateDate instanceof Date ? role.CreateDate.getTime() : undefined;
      return true;
    };
    const runtimeConfig = () => ({
      agentRuntimeName: names.runtimeName,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: d.imageUri } },
      roleArn: documents.roleArn,
      networkConfiguration: {
        networkMode: 'VPC',
        networkModeConfig: { subnets: d.subnetIds, securityGroups: d.securityGroupIds },
      },
      protocolConfiguration: { serverProtocol: 'HTTP' },
      // Service session lifecycle, not an application/model execution budget.
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
      environmentVariables: nativeRuntimeEnvironment(row),
      filesystemConfigurations: [
        { efsAccessPoint: { accessPointArn: row.accessPointArn, mountPath: '/mnt/native' } },
      ],
    });
    const verifyRuntime = async () => {
      const runtime = await call('control', 'getAgentRuntime', { agentRuntimeId: row.runtimeId });
      if (
        runtime.agentRuntimeArn !== row.runtimeArn ||
        runtime.agentRuntimeId !== row.runtimeId ||
        runtime.agentRuntimeVersion !== row.runtimeVersion ||
        runtime.authorizerConfiguration ||
        runtime.capacityProviderConfiguration ||
        runtime.requestHeaderConfiguration
      )
        mismatch();
      const expected = runtimeConfig();
      for (const key of [
        'agentRuntimeName',
        'agentRuntimeArtifact',
        'roleArn',
        'protocolConfiguration',
        'lifecycleConfiguration',
        'environmentVariables',
        'filesystemConfigurations',
      ])
        requireEqual(runtime[key], expected[key]);
      const net = structuredClone(runtime.networkConfiguration);
      if (net?.networkModeConfig?.requireServiceS3Endpoint === false)
        delete net.networkModeConfig.requireServiceS3Endpoint;
      if (Array.isArray(net?.networkModeConfig?.subnets)) net.networkModeConfig.subnets.sort();
      if (Array.isArray(net?.networkModeConfig?.securityGroups))
        net.networkModeConfig.securityGroups.sort();
      requireEqual(net, expected.networkConfiguration);
      if (['CREATE_FAILED', 'UPDATE_FAILED', 'DELETING'].includes(runtime.status)) mismatch();
      if (runtime.status === 'CREATING') throw new ReadinessWait('runtime');
      if (runtime.status !== 'READY') pending();
    };
    const verifyEndpoint = async () => {
      const endpoint = await call('control', 'getAgentRuntimeEndpoint', {
        agentRuntimeId: row.runtimeId,
        endpointName: names.endpointName,
      });
      if (
        endpoint.agentRuntimeArn !== row.runtimeArn ||
        endpoint.agentRuntimeEndpointArn !== row.runtimeEndpointArn ||
        endpoint.name !== names.endpointName ||
        (endpoint.targetVersion != null && endpoint.targetVersion !== row.runtimeVersion)
      )
        mismatch();
      if (['CREATE_FAILED', 'UPDATE_FAILED', 'DELETING'].includes(endpoint.status)) mismatch();
      if (endpoint.status === 'CREATING') throw new ReadinessWait('endpoint');
      if (endpoint.status !== 'READY') pending();
      if (endpoint.liveVersion !== row.runtimeVersion) mismatch();
    };
    try {
      const existing = await store.get(pointer);
      if (!existing) return outcome({ status: 'missing' });
      const claim = await store.claim({ ...pointer, bindingId: existing.bindingId });
      if (claim.kind !== 'claimed')
        return outcome({ status: claim.kind === 'busy' ? 'pending' : claim.kind });
      row = claim.row;
      names = nativeRuntimeResourceNames(row);
      if (
        row.executionBackend !== 'native' ||
        row.isolation !== 'execution' ||
        row.projectId !== pointer.projectId ||
        row.executionId !== pointer.executionId
      )
        mismatch();
      try {
        // Image bytes are pinned at draft creation. Later deployments may
        // change the default image, but may not silently upgrade this run.
        d = validateDeployment({
          ...configuredDeployment,
          imageUri: row.imageUri,
          imageDigest: row.imageDigest,
        });
      } catch {
        throw controlError('native_provisioning_source_changed');
      }
      await verifyFs();
      if (!row.accessPointArn) {
        let ap;
        try {
          ap = await call('efs', 'createAccessPoint', {
            ClientToken: resourceToken('efs', row),
            FileSystemId: d.fileSystemId,
            PosixUser: { Uid: 1000, Gid: 1000 },
            RootDirectory: {
              Path: names.rootDirectory,
              CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '700' },
            },
            Tags: tagList(),
          });
        } catch (error) {
          // EFS represents an idempotent retry as AccessPointAlreadyExists,
          // with the allocated ID. Read and verify it just like a fresh AP.
          if (
            error?.name !== 'AccessPointAlreadyExists' ||
            !/^fsap-[0-9a-f]{17}$/.test(error.AccessPointId ?? '')
          )
            throw error;
          const found = await call('efs', 'describeAccessPoints', {
            AccessPointId: error.AccessPointId,
          });
          if (
            found.NextToken ||
            found.AccessPoints?.length !== 1 ||
            found.AccessPoints[0].AccessPointId !== error.AccessPointId
          )
            mismatch();
          ap = found.AccessPoints[0];
        }
        // Validate the returned ARN before allowing it into role policies.
        runtimePolicyDocuments({ deployment: d, identity: row, accessPointArn: ap.AccessPointArn });
        await advance({
          accessPointArn: ap.AccessPointArn,
          fileSystemId: d.fileSystemId,
          rootDirectory: names.rootDirectory,
          mountPath: '/mnt/native',
        });
      }
      await verifyAp();
      documents = runtimePolicyDocuments({
        deployment: d,
        identity: row,
        accessPointArn: row.accessPointArn,
      });
      if (!(await verifyRole({ installMissing: true }))) {
        await call('iam', 'createRole', {
          RoleName: names.roleName,
          Path: '/native-runs/',
          AssumeRolePolicyDocument: JSON.stringify(documents.trustPolicy),
          PermissionsBoundary: d.permissionsBoundaryArn,
          Tags: tagList(),
        });
        // If interrupted here, only the tagged, exact-trust role is adoptable.
        if (!(await verifyRole({ installMissing: true }))) pending();
      }
      if (!row.executionRoleArn) await advance({ executionRoleArn: documents.roleArn });
      else if (row.executionRoleArn !== documents.roleArn) mismatch();
      if (!row.runtimeArn) {
        let runtime;
        try {
          runtime = await call('control', 'createAgentRuntime', {
            ...runtimeConfig(),
            clientToken: resourceToken('runtime', row),
            tags: tags(),
          });
        } catch (error) {
          // AgentCore can lag IAM's readback for a newly created, fully verified
          // role. Retry this observed same-role validation error for a bounded
          // propagation window; each attempt revalidates all authority.
          const roleAge = now() - verifiedRoleCreatedAt;
          if (
            error?.name === 'ValidationException' &&
            error.message ===
              `Role validation failed for '${documents.roleArn}'. Please verify that the role exists and its trust policy allows assumption by this service` &&
            Number.isFinite(roleAge) &&
            roleAge >= 0 &&
            roleAge < ROLE_PROPAGATION_WINDOW_MS
          )
            throw new ReadinessWait('iam_propagation');
          throw error;
        }
        if (
          !new RegExp(`^${names.runtimeName}-[A-Za-z0-9]+$`).test(runtime.agentRuntimeId ?? '') ||
          runtime.agentRuntimeArn !==
            `${documents.runtimePrefix}${runtime.agentRuntimeId?.slice(names.runtimeName.length + 1)}` ||
          !/^[1-9][0-9]*$/.test(runtime.agentRuntimeVersion ?? '')
        )
          mismatch();
        await advance({
          runtimeArn: runtime.agentRuntimeArn,
          runtimeId: runtime.agentRuntimeId,
          runtimeVersion: runtime.agentRuntimeVersion,
        });
      }
      await verifyRuntime();
      if (!row.runtimeEndpointArn) {
        // Read first so a crash after CreateEndpoint is safely recoverable.
        try {
          const found = await call('control', 'getAgentRuntimeEndpoint', {
            agentRuntimeId: row.runtimeId,
            endpointName: names.endpointName,
          });
          if (
            found.agentRuntimeArn !== row.runtimeArn ||
            found.name !== names.endpointName ||
            found.agentRuntimeEndpointArn !==
              `${row.runtimeArn}/runtime-endpoint/${names.endpointName}` ||
            (found.targetVersion != null && found.targetVersion !== row.runtimeVersion) ||
            (found.liveVersion != null && found.liveVersion !== row.runtimeVersion)
          )
            mismatch();
        } catch (error) {
          if (!missing(error)) throw error;
          await call('control', 'createAgentRuntimeEndpoint', {
            agentRuntimeId: row.runtimeId,
            agentRuntimeVersion: row.runtimeVersion,
            name: names.endpointName,
            clientToken: resourceToken('endpoint', row),
            tags: tags(),
          });
        }
        await advance({
          runtimeEndpoint: names.endpointName,
          runtimeEndpointArn: `${row.runtimeArn}/runtime-endpoint/${names.endpointName}`,
        });
      }
      // Re-read all authority before invocation; do not trust a self-report.
      await verifyEndpoint();
      await verifyAp();
      await verifyRole();
      await verifyRuntime();
      const session = {
        agentRuntimeArn: row.runtimeArn,
        qualifier: names.endpointName,
        runtimeSessionId: `native-check-${row.bindingId}`,
      };
      const signal = AbortSignal.timeout(workspaceCheckBudget());
      let report;
      // Once invocation may have begun, retain conservative retries even if
      // a later read reports CREATING. Never hand off an uncertain session.
      diagnosticStarted = true;
      try {
        const response = await call(
          'runtime',
          'invokeAgentRuntime',
          {
            ...session,
            contentType: 'application/json',
            accept: 'application/json',
            payload: Buffer.from(JSON.stringify(payloadFor(row))),
          },
          { abortSignal: signal },
        );
        report = await readProof(response, signal);
      } finally {
        // Close even a failed diagnostic; never delete its runtime/AP/role.
        const stopped = await call('runtime', 'stopRuntimeSession', {
          ...session,
          clientToken: resourceToken(`stop-${row.fence}`, row),
        });
        if (stopped.statusCode !== 200) pending();
      }
      verifyWorkspaceProof(row, report);
      await verifyFs();
      await verifyAp();
      await verifyRole();
      await verifyRuntime();
      await verifyEndpoint();
      row = await store.ready({ ...lease(), resources: {} });
      return outcome({ status: 'READY' });
    } catch (error) {
      if (row && error instanceof ReadinessWait && !diagnosticStarted) {
        try {
          row = await store.release(lease());
          // No resource operations are allowed after releasing ownership.
          return outcome({ status: 'waiting', phase: error.phase }, error);
        } catch (releaseError) {
          return outcome({ status: 'pending' }, releaseError);
        }
      }
      // Lost leases and transient service failures must not publish or poison a
      // newer owner's row. The queue retries; no resource deletion takes place.
      if (
        !row ||
        (typeof error?.code === 'string' && error.code.startsWith('NATIVE_PREPARATION_')) ||
        error?.code === 'native_provisioning_pending' ||
        transient(error)
      )
        return outcome({ status: 'pending' }, error);
      const code = terminalCodes.has(error?.code)
        ? error.code
        : accessDenied(error)
          ? 'native_provisioning_access_denied'
          : 'native_provisioning_failed';
      try {
        await store.fail({ ...lease(), code });
      } catch (storeError) {
        return outcome({ status: 'pending' }, storeError);
      }
      return outcome({ status: 'FAILED', code }, error);
    }
  };
};
