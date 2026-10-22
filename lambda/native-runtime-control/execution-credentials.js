// This facade is a separate Lambda, callable ONLY by the trusted native
// dispatch worker. Neither native runtime roles nor legacy platform roles may
// invoke it. A claimed role in payload is not authentication; IAM is the caller
// boundary. Do not add this operation to the existing runtime-callable broker.
import { isDeepStrictEqual } from 'node:util';
import { readCredentialBindingValue } from '../shared/agent-credentials.js';
import { resolveBindingCredential } from '../shared/source-control-credentials.js';
import { assertCurrentGitConnection, getGitConnection } from '../shared/git-connection-store.js';
import {
  nativeExecutionConfiguration,
  nativeTurnSequence,
  nativeWriterGeneration,
} from './execution-store.js';
import { nativeWorkspaceRecovery } from '../shared/native-recovery-mode.js';
import {
  nativeExecutionDeployment,
  nativePromptSha256,
  nativePreparedConfigurationPins,
  readNativeCodeBinding,
} from './execution-config.js';
import { ID, UUID_V4, matches } from './store.js';
import { nativeDraftPrompt } from './draft-prompt.js';
import { createNativeRuntimeImagePolicy } from './runtime-images.js';
import {
  isNativeSourceBranch,
  isNativeSourceCommit,
  resolveNativeSourceCommit,
} from './execution-source.js';

const CODES = Object.freeze({
  INVALID: 'NATIVE_EXECUTION_CREDENTIALS_INVALID',
  UNAVAILABLE: 'NATIVE_EXECUTION_CREDENTIALS_UNAVAILABLE',
  NOT_ACTIVE: 'NATIVE_EXECUTION_CREDENTIALS_NOT_ACTIVE',
  CHANGED: 'NATIVE_EXECUTION_CREDENTIALS_CHANGED',
  FORBIDDEN: 'NATIVE_EXECUTION_CREDENTIALS_FORBIDDEN',
  MODEL_UNAVAILABLE: 'NATIVE_EXECUTION_MODEL_CREDENTIAL_UNAVAILABLE',
  SOURCE_CHANGED: 'NATIVE_EXECUTION_SOURCE_CREDENTIAL_CHANGED',
  IMAGE_REVOKED: 'NATIVE_EXECUTION_CREDENTIALS_IMAGE_REVOKED',
});
class CredentialDenial extends Error {
  constructor(suffix) {
    super('Native execution credentials could not be authorized');
    this.code = CODES[suffix] ?? CODES.UNAVAILABLE;
  }
}
const fail = (suffix) => {
  throw new CredentialDenial(suffix);
};
const same = isDeepStrictEqual;
const safeText = (value, max = 512) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  ![...value].some((character) => character.codePointAt(0) < 32 || character === '\x7f');
const requestScope = (payload) => {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Object.getPrototypeOf(payload) !== Object.prototype ||
    Reflect.ownKeys(payload).length !== 4 ||
    !['projectId', 'executionId', 'attemptId', 'epoch'].every(
      (key) =>
        Object.hasOwn(payload, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(payload, key), 'value'),
    ) ||
    !matches(payload.projectId, ID) ||
    !matches(payload.executionId, UUID_V4) ||
    !matches(payload.attemptId, UUID_V4) ||
    !Number.isSafeInteger(payload.epoch) ||
    payload.epoch < 1
  )
    fail('INVALID');
  return { projectId: payload.projectId, executionId: payload.executionId };
};
const preparedSnapshot = (draft) => ({
  bindingId: draft.bindingId,
  version: draft.version,
  requestFingerprint: draft.requestFingerprint,
  ...(nativeDraftPrompt(draft).revision > 0
    ? { promptRevision: nativeDraftPrompt(draft).revision }
    : {}),
  image: { uri: draft.imageUri, digest: draft.imageDigest },
  executionRoleArn: draft.executionRoleArn,
  accessPointArn: draft.accessPointArn,
  fileSystemId: draft.fileSystemId,
  rootDirectory: draft.rootDirectory,
  mountPath: draft.mountPath,
  runtimeArn: draft.runtimeArn,
  runtimeVersion: draft.runtimeVersion,
  runtimeEndpoint: draft.runtimeEndpoint,
});
const confirmedWorkspaceResume = (row) =>
  nativeWorkspaceRecovery(row?.configuration) &&
  row.status === 'RECOVERING' &&
  row.recovery?.phase === 'RESTORING' &&
  row.recovery.canRecover === false &&
  matches(row.recovery.id, UUID_V4) &&
  nativeWriterGeneration(row) >= 2 &&
  row.recovery.previousGeneration === nativeWriterGeneration(row) - 1 &&
  row.recovery.writerGeneration === nativeWriterGeneration(row) &&
  row.workspaceResume?.id === row.recovery.id &&
  row.workspaceResume?.sequence === nativeTurnSequence(row) &&
  row.workspaceResume?.writerGeneration === nativeWriterGeneration(row) &&
  row.stopConfirmation?.writerGeneration === row.recovery.previousGeneration &&
  row.stopConfirmation?.runtimeSessionId === row.runtimeSessionId &&
  Number.isSafeInteger(row.stopConfirmation?.confirmedAt) &&
  row.stopConfirmation.confirmedAt >= row.startedAt &&
  row.stopConfirmation.confirmedAt <= row.updatedAt &&
  row.response === undefined &&
  row.dispatch === undefined &&
  row.recoveryCheckpoint === undefined &&
  row.recovery.checkpointId === undefined;
const authorizeExecution = (row, payload, deployment) => {
  if (
    !row ||
    (!['UPGRADING', 'DISPATCHING'].includes(row.status) && !confirmedWorkspaceResume(row)) ||
    row.cancelRequested !== false ||
    row.scope?.projectId !== payload.projectId ||
    row.scope?.executionId !== payload.executionId ||
    row.attemptId !== payload.attemptId ||
    row.epoch !== payload.epoch
  )
    fail('NOT_ACTIVE');
  // Store.get is a validating consistent read, but validate the configuration
  // again at this secret boundary, including injected stores used by tests.
  const config = nativeExecutionConfiguration(row.configuration);
  if (
    nativeTurnSequence(row) > 1 &&
    !confirmedWorkspaceResume(row) &&
    (row.status !== 'DISPATCHING' ||
      row.response?.deliveryStatus !== 'pending' ||
      row.response.sequence !== nativeTurnSequence(row) ||
      row.response.interactionId !== row.interaction?.id ||
      row.response.contentSha256 !== row.interactionContentSha256)
  )
    fail('CHANGED');
  const endpoint = `exec_${nativePromptSha256(row.attemptId).slice(0, 32)}`;
  if (
    !matches(row.bindingId, UUID_V4) ||
    !matches(row.startedBy, ID) ||
    !matches(row.runtimeSessionId, UUID_V4) ||
    config.accountId !== deployment.accountId ||
    config.packageBucket !== deployment.packageBucket ||
    config.publicationBucket !== deployment.publicationBucket ||
    (config.credentialBinding.source === 'user' &&
      config.credentialBinding.userId !== row.startedBy) ||
    row.target?.runtimeArn !== row.preparation?.runtimeArn ||
    row.target?.runtimeId !== row.preparation?.runtimeArn?.split('/').at(-1) ||
    row.target?.endpoint !== endpoint ||
    row.target?.endpointArn !== `${row.target?.runtimeArn}/runtime-endpoint/${endpoint}` ||
    row.target?.imageDigest !== config.image.digest ||
    !matches(row.target?.rolePolicySha256, /^[a-f0-9]{64}$/) ||
    !matches(row.target?.runtimeVersion, /^[1-9][0-9]{0,19}$/) ||
    !matches(row.preparation?.runtimeVersion, /^[1-9][0-9]{0,19}$/) ||
    BigInt(row.target.runtimeVersion) < BigInt(row.preparation.runtimeVersion) ||
    (config.image.digest !== row.preparation.image.digest &&
      BigInt(row.target.runtimeVersion) <= BigInt(row.preparation.runtimeVersion)) ||
    ((row.status === 'DISPATCHING' || confirmedWorkspaceResume(row)) &&
      (!isNativeSourceBranch(row.sourceBranch) || !isNativeSourceCommit(row.sourceCommit)))
  )
    fail('CHANGED');
};
// The pinned image must still be the deployment image, or an exact retained
// image for a resumable run. Revocation blocks renewal even for the current pin.
const authorizeImage = async (policy, row, deployment) => {
  let decision;
  try {
    decision = await policy.decide({
      image: nativeExecutionConfiguration(row.configuration).image,
      row,
      deployment,
    });
  } catch {
    fail('UNAVAILABLE');
  }
  if (decision.status === 'revoked') fail('IMAGE_REVOKED');
  if (!['current', 'retained'].includes(decision.status)) fail('CHANGED');
};
const authorizePreparation = (draft, execution) => {
  if (
    !draft ||
    draft.projectId !== execution.scope.projectId ||
    draft.executionId !== execution.scope.executionId ||
    draft.bindingId !== execution.bindingId ||
    !same(preparedSnapshot(draft), execution.preparation)
  )
    fail('CHANGED');
  const pins = nativePreparedConfigurationPins(draft);
  for (const [key, value] of Object.entries(pins)) {
    if (!same(value, execution.configuration[key])) fail('CHANGED');
  }
};
const membership = async (getSnapshot, projectId, userId, projectIdentity) => {
  if (typeof getSnapshot !== 'function') fail('UNAVAILABLE');
  const value = await getSnapshot(projectId, userId);
  if (
    !value ||
    !['owner', 'admin', 'member'].includes(value.role) ||
    !safeText(value.membershipId) ||
    value.projectIdentity !== projectIdentity
  )
    fail('FORBIDDEN');
  return structuredClone(value);
};

/**
 * Store contract: both get({projectId, executionId}) operations must validate
 * protected records using consistent reads. Execution fields come from
 * createNativeExecutionStore: scope, configuration, preparation, startedBy,
 * attemptId, epoch, runtimeSessionId, target, status, cancelRequested.
 * UPGRADING requires the verified execution target but permits resolving the
 * source before it is pinned. The controller must persist sourceCommit and
 * sourceBranch and recheck DISPATCHING before delivering anything to runtime.
 *
 * getMembershipSnapshot is supplied by the entry's existing Neptune membership
 * reader; omission fails closed. No permission, actor, binding or secret path
 * can be supplied in the request. There is deliberately no credential cache,
 * fallback, effective-binding lookup or grant-signing authority here.
 */
export const createNativeExecutionCredentials =
  ({
    executionStore,
    preparationStore,
    ddb,
    ssm,
    secrets,
    env = process.env,
    getMembershipSnapshot,
    imagePolicy,
  }) =>
  async (payload) => {
    try {
      const scope = requestScope(payload);
      if (
        !executionStore?.get ||
        !preparationStore?.get ||
        !ddb?.send ||
        !ssm?.send ||
        !secrets?.send ||
        !matches(env.AGENT_SETTINGS_SSM_PREFIX, /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
      )
        fail('UNAVAILABLE');
      const deployment = nativeExecutionDeployment(env);
      const images =
        imagePolicy ??
        createNativeRuntimeImagePolicy({ ddb, tableName: env.NATIVE_RUNTIME_BINDINGS_TABLE, env });
      const execution = structuredClone(await executionStore.get(scope));
      authorizeExecution(execution, payload, deployment);
      await authorizeImage(images, execution, deployment);
      if (nativeTurnSequence(execution) > 1 && !confirmedWorkspaceResume(execution)) {
        const response = await executionStore.response?.(
          execution,
          execution.response.interactionId,
        );
        if (
          !response ||
          response.commandId !== execution.response.commandId ||
          response.sequence !== nativeTurnSequence(execution) ||
          response.interactionId !== execution.interaction.id ||
          response.contentSha256 !== execution.interactionContentSha256 ||
          response.textSha256 !== execution.response.textSha256 ||
          typeof response.text !== 'string' ||
          nativePromptSha256(response.text) !== response.textSha256
        )
          fail('CHANGED');
      }
      const prepared = structuredClone(await preparationStore.get(scope));
      authorizePreparation(prepared, execution);
      const actorMembership = await membership(
        getMembershipSnapshot,
        scope.projectId,
        execution.startedBy,
        prepared.projectIdentity,
      );
      const bindingScope = {
        projectId: scope.projectId,
        provider: execution.configuration.repository.provider,
        repository: execution.configuration.repository.repository,
        revision: execution.configuration.repository.bindingRevision,
      };
      const binding = await readNativeCodeBinding(ddb, env, bindingScope);
      const oauth = binding.authType !== 'github-app';
      const delegatorMembership = oauth
        ? await membership(
            getMembershipSnapshot,
            scope.projectId,
            binding.connectionUserId,
            prepared.projectIdentity,
          )
        : null;
      const connection = oauth
        ? structuredClone(await getGitConnection(ddb, binding.connectionUserId, binding.provider))
        : null;
      if (oauth && !connection) fail('SOURCE_CHANGED');

      const modelRequest = {
        base: env.AGENT_SETTINGS_SSM_PREFIX,
        binding: execution.configuration.credentialBinding,
        projectId: scope.projectId,
      };
      if (!(await readCredentialBindingValue(ssm, modelRequest))) fail('MODEL_UNAVAILABLE');
      const git = await resolveBindingCredential({
        ddb,
        ssm,
        secrets,
        binding,
        requiredAccess: 'read',
      });
      let source;
      if (execution.sourceCommit !== undefined || execution.sourceBranch !== undefined) {
        if (
          !isNativeSourceCommit(execution.sourceCommit) ||
          !isNativeSourceBranch(execution.sourceBranch) ||
          (execution.configuration.repository.branch !== null &&
            execution.configuration.repository.branch !== execution.sourceBranch)
        )
          fail('CHANGED');
        source = { branch: execution.sourceBranch, commit: execution.sourceCommit };
      } else {
        source = await resolveNativeSourceCommit({
          provider: binding.provider,
          repository: execution.configuration.repository.repository,
          branch: execution.configuration.repository.branch,
          token: git?.token,
        });
      }
      // Fetch the SAME pinned model source again after the slow provider path.
      // Rotation within that source is accepted; disappearance never falls back.
      const modelValue = await readCredentialBindingValue(ssm, modelRequest);
      if (!modelValue) fail('MODEL_UNAVAILABLE');
      if (
        typeof git?.token !== 'string' ||
        !git.token.trim() ||
        typeof git.username !== 'string' ||
        !git.username.trim()
      )
        fail('SOURCE_CHANGED');

      if (
        !same(
          actorMembership,
          await membership(
            getMembershipSnapshot,
            scope.projectId,
            execution.startedBy,
            prepared.projectIdentity,
          ),
        )
      )
        fail('FORBIDDEN');
      if (oauth) {
        if (
          !same(
            delegatorMembership,
            await membership(
              getMembershipSnapshot,
              scope.projectId,
              binding.connectionUserId,
              prepared.projectIdentity,
            ),
          )
        )
          fail('FORBIDDEN');
        // Retain the existing connection generation and refresh/revocation
        // protections even when cancellation/binding cleanup races a slow read.
        await assertCurrentGitConnection(ddb, connection);
      }
      const currentBinding = await readNativeCodeBinding(ddb, env, bindingScope);
      if (!same(currentBinding, binding)) fail('SOURCE_CHANGED');
      const currentPreparation = structuredClone(await preparationStore.get(scope));
      authorizePreparation(currentPreparation, execution);
      if (!same(currentPreparation, prepared)) fail('CHANGED');
      const currentExecution = structuredClone(await executionStore.get(scope));
      authorizeExecution(currentExecution, payload, deployment);
      if (!same(currentExecution, execution)) fail('CHANGED');
      // A revocation written during the slow provider path still wins.
      await authorizeImage(images, currentExecution, deployment);
      // Never return refresh closures, committer/provider bodies, secret paths,
      // connection rows, requests or configuration objects. The dispatcher uses
      // Git credentials only for its trusted checkout child, not harness env.
      return {
        ok: true,
        ...scope,
        bindingId: execution.bindingId,
        attemptId: execution.attemptId,
        epoch: execution.epoch,
        runtimeSessionId: execution.runtimeSessionId,
        model: { provider: execution.configuration.credentialBinding.provider, value: modelValue },
        git: { username: git.username, password: git.token },
        source,
      };
    } catch (error) {
      // Neither provider exception messages/causes nor payloads are logged or
      // returned. The dedicated entry also silences inherited helper loggers.
      return {
        ok: false,
        code:
          error instanceof CredentialDenial
            ? error.code
            : error?.name === 'NativeExecutionConfigurationError' ||
                ['CONNECTION_REQUIRED', 'CONNECTION_CHANGED', 'BINDING_INVALID'].includes(
                  error?.code,
                )
              ? CODES.SOURCE_CHANGED
              : CODES.UNAVAILABLE,
      };
    }
  };
