import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { nativeAuthorityPort } from './authority-client.js';
import { openNativeGraph } from './graph-connection.js';
import { fetchWorkflowSourceMembership } from '../shared/workflow-source-membership.js';
import { createNativePublications } from '../shared/native-publication.js';
import { createNativeInteractions } from '../shared/native-interaction.js';
import { executionIdentity } from './execution-runtime.js';
import { projectNativePublication, readNativePublicationInteraction } from './publication-graph.js';
import { readNativePublicationTrace } from './publication-trace.js';
import {
  logNativePointerRejected,
  nativePointerRejected,
  rejectNativePointer,
} from './pointer-rejection.js';

export const createNativeProjector =
  ({ store, publications, interactions, authorize, project }) =>
  async (scope) => {
    // The claim reads the protected execution before any projection state.
    const claim = await store.claim(scope).catch(rejectNativePointer);
    if (claim.kind !== 'claimed') return { pending: claim.kind === 'busy' };
    const { row, draft } = claim;
    try {
      const check = () => authorize({ row, draft });
      await check();
      const manifest = await publications.read(
        { ...executionIdentity(row), epoch: row.publicationEpoch },
        row.publication,
        { verifyFiles: true },
      );
      if (manifest.packageId !== row.configuration.packageId)
        throw new Error('Native projection package mismatch');
      const interaction = await readNativePublicationInteraction({
        draft,
        row,
        manifest,
        interactions,
      });
      const trace = await readNativePublicationTrace({
        draft,
        publication: row.publication,
        manifest,
        publications,
        authorize: check,
      });
      await project({
        draft,
        publication: row.publication,
        manifest,
        interaction,
        trace,
        authorize: check,
      });
      await check();
      await store.acknowledge(claim);
      return { pending: true };
    } catch (error) {
      await store.release(claim).catch(() => {});
      throw error;
    }
  };

const POINTER_REJECTED = 'native_projection_pointer_rejected';

export const createNativeProjectionWorker =
  ({ reconcile, sqs, queueUrl, logger = console }) =>
  async (event) => {
    const batchItemFailures = [];
    for (const record of event.Records ?? []) {
      let scope;
      try {
        scope = JSON.parse(record.body);
      } catch {
        // No redelivery can repair the body of a message.
        logNativePointerRejected(logger, POINTER_REJECTED, 'NATIVE_POINTER_MALFORMED');
        continue;
      }
      try {
        const result = await reconcile(scope);
        if (result.pending) {
          const sent = await sqs.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify(scope),
              DelaySeconds: 5,
            }),
          );
          if (!sent.MessageId) throw new Error('Native projection wakeup unacknowledged');
        }
      } catch (error) {
        if (nativePointerRejected(error)) {
          logNativePointerRejected(logger, POINTER_REJECTED, error.code, scope);
          continue;
        }
        logger.warn(
          JSON.stringify({
            event: 'native_projection_retry',
            code: /^NATIVE_[A-Z_]+$/.test(error?.code ?? '')
              ? error.code
              : 'NATIVE_PROJECTION_RETRY',
          }),
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };

export const handler = async (event) => {
  const env = process.env;
  const graph = await openNativeGraph(env);
  const s3 = new S3Client({});
  const sqs = new SQSClient({});
  const options = {
    s3,
    bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
    accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
  };
  const store = nativeAuthorityPort('projection', 'projection', [
    'claim',
    'acknowledge',
    'release',
  ]);
  const preparation = nativeAuthorityPort('projection', 'preparation', ['get']);
  const reconcile = createNativeProjector({
    store,
    publications: createNativePublications(options),
    interactions: createNativeInteractions(options),
    authorize: async ({ row, draft }) => {
      const current = await preparation.get(row.scope);
      const membership = await fetchWorkflowSourceMembership(
        graph.g,
        draft.projectId,
        row.startedBy,
      );
      if (
        !current ||
        current.bindingId !== row.bindingId ||
        current.projectIdentity !== draft.projectIdentity ||
        !['owner', 'admin', 'member'].includes(membership?.role) ||
        membership.projectIdentity !== draft.projectIdentity
      )
        throw new Error('Native projection authorization changed');
    },
    project: (input) => projectNativePublication({ ...input, g: graph.g }),
  });
  try {
    return await createNativeProjectionWorker({
      reconcile,
      sqs,
      queueUrl: env.NATIVE_PROJECTION_QUEUE_URL,
    })(event);
  } finally {
    await graph.close();
  }
};
