import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { isDeepStrictEqual } from 'node:util';
import { nativeExecutionKey } from './execution-store.js';
import {
  nativeEngineFileDigest,
  nativeEnginePin,
  engineFailure,
} from '../shared/native-workflow-protocol.js';

// This reader never trusts a runtime-provided "verified" property. The
// authority row must name the exact already-admitted publication, configuration
// and producer. History remains readable after cancellation, recovery or stop.
export const createNativeEngineProofReader =
  ({ ddb, tableName, objects }) =>
  async ({ row, found, manifest }) => {
    if (!row.configuration.workflowEngine) return null;
    const pin = nativeEnginePin(row.configuration.workflowEngine, row.configuration);
    const key = {
      ...nativeExecutionKey(row.scope),
      sk: `ENGINE#${found.identity.attemptId}#${found.identity.epoch}#PUBLICATION#${found.receipt.id}`,
    };
    const receipt = (
      await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: key,
          ConsistentRead: true,
        }),
      )
    ).Item;
    if (!receipt) return null;
    const identity = receipt.identity;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.pk !== key.pk ||
      receipt.sk !== key.sk ||
      receipt.producerSha256 !== pin.producerSha256 ||
      receipt.publicationId !== found.receipt.id ||
      identity?.projectId !== row.scope.projectId ||
      identity.executionId !== row.scope.executionId ||
      identity.bindingId !== row.bindingId ||
      identity.attemptId !== found.identity.attemptId ||
      identity.epoch !== found.identity.epoch ||
      identity.sequence !== manifest.sequence ||
      identity.configurationSha256 !== row.configurationSha256
    )
      throw engineFailure('NATIVE_ARTIFACT_REVISION_INVALID');
    const evidence = await objects.read(identity, receipt.evidence, 'output');
    if (
      evidence.schemaVersion !== 1 ||
      evidence.publicationId !== found.receipt.id ||
      evidence.publicationManifestSha256 !== found.receipt.manifest.sha256 ||
      evidence.filesSha256 !== nativeEngineFileDigest(manifest.files) ||
      evidence.configurationSha256 !== row.configurationSha256 ||
      !isDeepStrictEqual(evidence.identity, identity) ||
      evidence.publicationSequence !== manifest.sequence ||
      evidence.sourceCommit !== row.configuration.repository.commit ||
      evidence.packageId !== manifest.packageId ||
      evidence.harness !== row.configuration.harness ||
      evidence.producer?.imageSha256 !== pin.producerSha256 ||
      evidence.producer.profileId !== pin.profileId ||
      evidence.producer.functionVersion !== pin.version ||
      !['complete', 'failed', 'not_verified'].includes(evidence.workflowCompletion)
    )
      throw engineFailure('NATIVE_ARTIFACT_REVISION_INVALID');
    return evidence;
  };

export const nativeEngineVerificationSummary = (evidence) =>
  Object.fromEntries(
    [
      'publicationId',
      'publicationSequence',
      'workflowCompletion',
      'requiredChecks',
      'finalReview',
      'humanApproval',
      'policy',
      'requirementsStatus',
      'policyStatus',
      'reason',
    ].map((key) => [key, evidence[key]]),
  );
