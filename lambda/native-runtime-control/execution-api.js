import { nativePublicationView } from '../shared/native-publication.js';
import { readNativePublicationTrace } from './publication-trace.js';
import {
  nativePublicationGraph,
  readNativePublicationInteraction,
  sameNativePublicationRevision,
} from './publication-graph.js';
import { executionIdentity } from './execution-runtime.js';
import { nativeReplyRequest, nativeTurnSequence } from './execution-store.js';
import { nativeDraftPrompt, promptFailure } from './draft-prompt.js';
import { nativeInteractionView } from '../shared/native-interaction.js';
import { nativeAnswerText } from '../shared/native-pending-input.js';
import { createNativeRevisionApi } from './revision-api.js';
import { createNativeResultApi } from './result-api.js';

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
const identity = (draft) => ({ projectId: draft.projectId, executionId: draft.executionId });
const publicationIdentity = (row) => ({ ...executionIdentity(row), epoch: row.publicationEpoch });
const interactionIdentity = (row) => ({ ...executionIdentity(row), epoch: row.interactionEpoch });
const responseView = (response, row) =>
  response
    ? {
        id: response.commandId,
        kind: 'user_reply',
        interactionId: response.interactionId,
        sequence: response.sequence,
        actorId: response.actorId,
        text: response.text,
        acceptedAt: new Date(response.acceptedAt).toISOString(),
        deliveryStatus:
          row.response?.commandId === response.commandId ? row.response.deliveryStatus : 'unknown',
      }
    : null;

export const nativeExecutionView = (row) =>
  row
    ? {
        status: row.status,
        revision: row.version,
        attemptId: row.attemptId,
        epoch: row.epoch,
        startedAt: new Date(row.startedAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
        model: row.configuration.model,
        repository: {
          provider: row.configuration.repository.provider,
          repository: row.configuration.repository.repository,
          branch: row.sourceBranch ?? row.configuration.repository.branch,
          commit: row.sourceCommit ?? null,
        },
        ...(row.failureCode ? { failureCode: row.failureCode } : {}),
        publicationId: row.publication?.id ?? null,
        projectionStatus: row.projectionStatus ?? null,
        sequence: nativeTurnSequence(row),
        interactionId: row.interaction?.id ?? null,
        responsePending:
          ['DISPATCHING', 'RECOVERING', 'RECOVERY_REQUIRED'].includes(row.status) &&
          row.response?.deliveryStatus === 'pending',
        recovery: row.recovery
          ? {
              id: row.recovery.id,
              reason: row.recovery.reason,
              canRecover: row.recovery.canRecover,
            }
          : null,
      }
    : null;

const TERMINAL = new Set(['STOPPED', 'FAILED', 'CANCELLED', 'WAITING_FOR_INPUT']);

export const createNativeExecutionApi = ({
  enabled,
  admissionEnabled = enabled,
  projectionStatus,
  store,
  configure,
  publications,
  interactions,
  revisions,
  results,
  enqueue,
  authorizeSource,
  images,
  activity,
  deployment,
}) => {
  // Fast notification is optional; stream + state reconciliation owns delivery.
  const notify = async (scope) => {
    try {
      await enqueue?.(scope);
    } catch {
      /* Committed work remains discoverable. */
    }
  };
  // Protected image policy: the API rejects work that the controller and
  // credential resolver would refuse, but never hides committed results.
  const imageDecision = async (row) => {
    if (!images || typeof deployment !== 'function') return null;
    try {
      return await images.decide({ image: row.configuration.image, row, deployment: deployment() });
    } catch {
      fail('NATIVE_EXECUTION_UNAVAILABLE', 'Native runtime image policy is unavailable');
    }
  };
  const requireImage = async (row) => {
    const decision = await imageDecision(row);
    if (decision?.status === 'revoked')
      fail('NATIVE_EXECUTION_IMAGE_REVOKED', 'The runtime image for this execution was revoked');
    if (decision?.status === 'unapproved')
      fail('NATIVE_EXECUTION_IMAGE_UNAPPROVED', 'The runtime image is no longer approved');
  };
  const read = async (draft, recheck, includeProjection = true) => {
    const row = await store.get(identity(draft));
    if (row && row.bindingId !== draft.bindingId)
      fail('NATIVE_EXECUTION_CONFLICT', 'Native execution binding changed');
    await recheck(draft);
    return row && projectionStatus && includeProjection
      ? { ...row, projectionStatus: await projectionStatus(row) }
      : row;
  };
  const committed = async (draft, recheck) => {
    const row = await read(draft, recheck);
    if (!row?.publication)
      fail('NATIVE_PUBLICATION_NOT_FOUND', 'No native files have been published yet');
    const manifest = await publications.read(publicationIdentity(row), row.publication);
    if (manifest.packageId !== row.configuration.packageId)
      fail('NATIVE_PUBLICATION_INVALID', 'Native package identity changed');
    const current = await read(draft, recheck);
    if (current?.publication?.id !== row.publication.id || current.epoch !== row.epoch)
      fail('NATIVE_EXECUTION_CONFLICT', 'Native publication changed; refresh before reading');
    return { row: current, manifest };
  };
  const committedInteraction = async (draft, recheck) => {
    const row = await read(draft, recheck);
    if (!row?.interaction || !interactions)
      fail('NATIVE_INTERACTION_NOT_FOUND', 'No native assistant turn has been published yet');
    const body = await interactions.read(interactionIdentity(row), row.interaction);
    if (
      body.packageId !== row.configuration.packageId ||
      body.harness !== row.configuration.harness ||
      body.publicationId !== row.publication.id ||
      body.sequence !== row.interaction.sequence ||
      body.nativeSessionId !== row.publication.nativeSessionId ||
      body.contentSha256 !== row.interactionContentSha256
    )
      fail('NATIVE_INTERACTION_INVALID', 'Native interaction identity changed');
    const response = await store.response(row, row.interaction.id);
    const current = await read(draft, recheck);
    if (current?.interaction?.id !== row.interaction.id || current.epoch !== row.epoch)
      fail('NATIVE_EXECUTION_CONFLICT', 'Native interaction changed; refresh before reading');
    return { row: current, body, response };
  };
  return {
    ...(results
      ? createNativeResultApi({
          read: (draft, recheck) => read(draft, recheck, false),
          revisions,
          ...results,
        })
      : {}),
    ...createNativeRevisionApi({
      read: (draft, recheck) => read(draft, recheck, false),
      revisions,
      interactions,
      store,
    }),
    enabled,
    async outputs(draft, after, recheck, afterEvent) {
      const row = await read(draft, recheck);
      if (!row || !activity) return { outputs: [], nextAfter: null };
      const result = await activity.history(identity(draft), after);
      if (afterEvent !== undefined)
        Object.assign(result, await activity.events(identity(draft), afterEvent));
      await recheck(draft);
      return result;
    },
    async status(draft, recheck) {
      const row = await read(draft, recheck);
      const view = nativeExecutionView(row);
      if (row && !TERMINAL.has(row.status) && images && typeof deployment === 'function') {
        // Reads never hide committed results because the policy store is
        // briefly unavailable; the client disables actions for this state and
        // every mutation still re-checks the policy fail-closed.
        try {
          view.imageStatus = (
            await images.decide({ image: row.configuration.image, row, deployment: deployment() })
          ).status;
        } catch {
          view.imageStatus = 'unavailable';
        }
      }
      return {
        executionAvailable: row ? true : admissionEnabled === true,
        admissionEnabled: admissionEnabled === true,
        execution: view,
      };
    },
    async start(draft, actorId, requestId, recheck, promptRevision) {
      // An existing start retains its original starter and configuration.
      let row = await read(draft, recheck);
      const expectedRevision = promptRevision ?? 0;
      if (
        (row ? (row.preparation.promptRevision ?? 0) : nativeDraftPrompt(draft).revision) !==
        expectedRevision
      )
        promptFailure('CONFLICT');
      if (!row) {
        if (!admissionEnabled)
          fail('NATIVE_EXECUTION_DISABLED', 'New native executions are disabled');
        await authorizeSource(draft, actorId);
        const configuration = await configure({ draft, actorId });
        // A new run always pins the current deployment image; an emergency
        // revocation of that image must block new starts too.
        if (images) {
          let revoked;
          try {
            revoked = await images.revocation(configuration.image.digest);
          } catch {
            fail('NATIVE_EXECUTION_UNAVAILABLE', 'Native runtime image policy is unavailable');
          }
          if (revoked)
            fail(
              'NATIVE_EXECUTION_IMAGE_REVOKED',
              'The runtime image for this execution was revoked',
            );
        }
        await recheck(draft);
        await authorizeSource(draft, actorId);
        const result = await store.start({
          ...identity(draft),
          actorId,
          requestId,
          configuration,
          ...(promptRevision !== undefined ? { promptRevision } : {}),
        });
        row = result.row ?? result;
      }
      await recheck(draft);
      if (
        [
          'REQUESTED',
          'UPGRADING',
          'DISPATCHING',
          'RUNNING',
          'RECOVERING',
          'CANCEL_REQUESTED',
        ].includes(row.status)
      )
        await notify(identity(draft));
      return { executionAvailable: true, execution: nativeExecutionView(row) };
    },
    async cancel(draft, recheck) {
      await recheck(draft);
      const row = await store.cancel({ ...identity(draft), bindingId: draft.bindingId });
      await recheck(draft);
      if (row.status === 'CANCEL_REQUESTED') await notify(identity(draft));
      return {
        executionAvailable: true,
        admissionEnabled: admissionEnabled === true,
        execution: nativeExecutionView(row),
      };
    },
    async recover(draft, input, recheck) {
      const existing = await read(draft, recheck);
      if (existing) await requireImage(existing);
      await recheck(draft);
      const row = await store.recover({
        ...identity(draft),
        bindingId: draft.bindingId,
        request: input,
      });
      await recheck(draft);
      if (row.status === 'RECOVERING') await notify(identity(draft));
      return { executionAvailable: true, execution: nativeExecutionView(row) };
    },
    async interaction(draft, recheck) {
      const { row, body, response } = await committedInteraction(draft, recheck);
      return {
        ...nativeInteractionView(row.interaction, body),
        response: responseView(response, row),
      };
    },
    async respond(draft, actorId, input, recheck, member = null) {
      const request = nativeReplyRequest(input);
      // Validate the exact presentation before accepting a new response. A
      // committed response retry uses its immutable ledger even after the next
      // assistant turn, without accepting an answer to a stale presentation.
      const current = await read(draft, recheck);
      if (!current) fail('NATIVE_EXECUTION_NOT_FOUND', 'Native execution not found');
      const prior = await store.response(current, request.interactionId);
      if (!prior) {
        const { row, body } = await committedInteraction(draft, recheck);
        if (
          row.interaction.id !== request.interactionId ||
          body.contentSha256 !== request.contentSha256
        )
          fail('NATIVE_EXECUTION_CONFLICT', 'Native interaction changed; refresh before replying');
        // A structured selection must match the committed question exactly, and
        // the delivered text must be its canonical rendering (exact labels).
        if (request.selection) {
          let rendered;
          try {
            rendered =
              body.schemaVersion === 2
                ? nativeAnswerText(body.pendingInput, request.selection)
                : null;
          } catch {
            rendered = null;
          }
          if (rendered === null || rendered !== request.text)
            fail('NATIVE_EXECUTION_INVALID', 'Native answer does not match the presented question');
        }
        // Never accept a new reply that could not be delivered with the
        // run's pinned image. A committed reply retry keeps its receipt.
        await requireImage(row);
      }
      await recheck(draft);
      const accepted = await store.respond({
        ...identity(draft),
        bindingId: draft.bindingId,
        actorId,
        request,
        ...(member ? { member } : {}),
      });
      // The committed acceptance is the authority point. Queue its one
      // continuation before the read-back recheck, so a revocation racing this
      // request cannot strand an accepted command; the recheck still withholds
      // the result from a caller who is no longer a member. Stream delivery
      // and reconciliation repair lost notifications without a client retry.
      if (accepted.row.status === 'DISPATCHING') await notify(identity(draft));
      await recheck(draft);
      return {
        executionAvailable: true,
        execution: nativeExecutionView(accepted.row),
        response: responseView(accepted.response, accepted.row),
      };
    },
    async publication(draft, recheck) {
      const { row, manifest } = await committed(draft, recheck);
      return nativePublicationView(row.publication, manifest, row.projectionStatus);
    },
    async file(draft, fileId, recheck) {
      const { row, manifest } = await committed(draft, recheck);
      const descriptor = manifest.files.find((f) => f.id === fileId);
      if (!descriptor) fail('NATIVE_PUBLICATION_NOT_FOUND', 'Native file not found');
      // The file remains visible in the manifest. Large binary download is a
      // separate transport; never return a truncated file as exact content.
      if (descriptor.bytes > 3 * 1024 * 1024)
        fail('NATIVE_FILE_TOO_LARGE', 'This file is too large for the inline viewer');
      const { file, bytes } = await publications.file(publicationIdentity(row), manifest, fileId);
      let content, encoding;
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        encoding = content.includes('\0') ? 'base64' : 'utf8';
      } catch {
        encoding = 'base64';
      }
      if (encoding === 'base64') content = bytes.toString('base64');
      const current = await read(draft, recheck);
      if (current?.publication?.id !== row.publication.id || current.epoch !== row.epoch)
        fail('NATIVE_EXECUTION_CONFLICT', 'Native publication changed; refresh before reading');
      return {
        id: file.id,
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        mediaType: file.mediaType,
        publicationId: row.publication.id,
        encoding,
        content,
      };
    },
    async graph(draft, recheck) {
      const { row, manifest } = await committed(draft, recheck);
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
        authorize: () => recheck(draft),
      });
      const current = await read(draft, recheck);
      if (!sameNativePublicationRevision(row, current))
        fail(
          'NATIVE_EXECUTION_CONFLICT',
          'Native graph publication changed; refresh before reading',
        );
      return nativePublicationGraph({
        draft,
        publication: row.publication,
        manifest,
        interaction,
        trace,
      });
    },
  };
};
