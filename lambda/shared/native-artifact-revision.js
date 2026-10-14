// Verified native artifact revisions for collaboration: discussion anchors and
// Quorum context. A revision is one committed file's exact bytes, identified by
// its stable file ID and content hash within a named immutable publication.
// The protected execution row or its PUBLICATION#<sequence> history row is the
// authority; the Neptune projection is never consulted. Reads confer no
// execution, approval or edit authority.
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { nativeRuntimeBindingKey } from './native-runtime-binding.js';

const SHA = /^[a-f0-9]{64}$/;
const FILE_ID = /^nf-[a-f0-9]{64}$/;
const REVISION = /^(nf-[a-f0-9]{64}):([a-f0-9]{64})$/;
export const NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES = 3 * 1024 * 1024;
const publicationKey = (sequence) => `PUBLICATION#${String(sequence).padStart(16, '0')}`;

// Shared by member history, discussions and Quorum. Never resolve a historical
// file by its ID alone, or substitute the current receipt for a missing row.
export const nativePublicationRecord = (execution, item) => {
  const { projectId, executionId } = execution.scope ?? {};
  if (
    !item ||
    (item.schemaVersion !== undefined && item.schemaVersion !== 1) ||
    item.bindingId !== execution.bindingId ||
    item.attemptId !== execution.attemptId ||
    item.scope?.projectId !== projectId ||
    item.scope?.executionId !== executionId ||
    !Number.isSafeInteger(item.epoch) ||
    item.epoch < 1 ||
    item.epoch > (execution.epoch ?? execution.publicationEpoch) ||
    !SHA.test(item.publication?.id ?? '') ||
    !Number.isSafeInteger(item.publication.sequence) ||
    item.publication.sequence < 1 ||
    item.publication.sequence > execution.publication.sequence ||
    (item.sk !== undefined && item.sk !== publicationKey(item.publication.sequence)) ||
    (item.pk !== undefined && item.pk !== nativeRuntimeBindingKey({ projectId, executionId }).pk)
  )
    throw unavailable();
  return {
    identity: { projectId, executionId, attemptId: item.attemptId, epoch: item.epoch },
    receipt: item.publication,
    interaction: item.interaction ?? null,
    interactionContentSha256: item.interactionContentSha256 ?? null,
    runtimeSessionId: item.runtimeSessionId,
    admittedAt: item.admittedAt ?? null,
  };
};

export const nativeArtifactRevisionId = ({ fileId, sha256 }) => {
  if (!FILE_ID.test(fileId ?? '') || !SHA.test(sha256 ?? ''))
    throw new Error('Invalid native artifact revision');
  return `${fileId}:${sha256}`;
};
export const parseNativeArtifactRevisionId = (value) => {
  const match = typeof value === 'string' ? REVISION.exec(value) : null;
  return match ? { fileId: match[1], sha256: match[2] } : null;
};

const unavailable = () =>
  Object.assign(new Error('Native artifact revision could not be verified'), {
    code: 'NATIVE_ARTIFACT_REVISION_INVALID',
  });

const describe = ({ manifest, file, found }) => ({
  fileId: file.id,
  path: file.path,
  sha256: file.sha256,
  bytes: file.bytes,
  mediaType: file.mediaType,
  publicationId: found.receipt.id,
  publicationSequence: manifest.sequence,
});

export const createNativeArtifactRevisions = ({ ddb, nativeTable, publications }) => {
  // Resolve the immutable publication receipt plus the identity its objects
  // were written under. The current publication uses the row's publication
  // epoch; an older one must come from its own conditional history row.
  const receiptFor = async (execution, { publicationId, publicationSequence }) => {
    const { projectId, executionId } = execution.scope ?? {};
    if (execution.publication?.id === publicationId) {
      if (
        publicationSequence !== undefined &&
        publicationSequence !== execution.publication.sequence
      )
        throw unavailable();
      return {
        identity: {
          projectId,
          executionId,
          attemptId: execution.attemptId,
          epoch: execution.publicationEpoch,
        },
        receipt: execution.publication,
        interaction: execution.interaction ?? null,
        interactionContentSha256: execution.interactionContentSha256 ?? null,
        runtimeSessionId: execution.runtimeSessionId,
      };
    }
    if (!Number.isSafeInteger(publicationSequence) || publicationSequence < 1) return null;
    const { Item: item } = await ddb.send(
      new GetCommand({
        TableName: nativeTable,
        Key: {
          pk: nativeRuntimeBindingKey({ projectId, executionId }).pk,
          sk: publicationKey(publicationSequence),
        },
        ConsistentRead: true,
      }),
    );
    if (
      !item ||
      item.publication?.id !== publicationId ||
      item.publication?.sequence !== publicationSequence
    )
      return null;
    return nativePublicationRecord(execution, item);
  };

  const publication = async (execution, revision) => {
    if (!execution?.publication || !SHA.test(revision?.publicationId ?? '')) throw unavailable();
    const found = await receiptFor(execution, revision);
    if (!found) throw unavailable();
    let manifest;
    try {
      manifest = await publications.read(found.identity, found.receipt);
    } catch {
      throw unavailable();
    }
    if (manifest.packageId !== execution.configuration?.packageId) throw unavailable();
    return { found, manifest };
  };
  const locate = async (execution, revision) => {
    if (!FILE_ID.test(revision?.fileId ?? '') || !SHA.test(revision?.sha256 ?? ''))
      throw unavailable();
    const { found, manifest } = await publication(execution, revision);
    const file = manifest.files.find((entry) => entry.id === revision.fileId);
    if (!file || file.sha256 !== revision.sha256) throw unavailable();
    return { found, manifest, file };
  };

  return Object.freeze({
    publication,
    async list(execution, beforeSequence = null) {
      if (!execution?.publication) return { items: [], nextBefore: null, gaps: [] };
      const upper =
        beforeSequence === null
          ? execution.publication.sequence
          : Math.min(beforeSequence - 1, execution.publication.sequence);
      if (upper < 1) return { items: [], nextBefore: null, gaps: [] };
      const page = await ddb.send(
        new QueryCommand({
          TableName: nativeTable,
          ConsistentRead: true,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :after AND :end',
          ExpressionAttributeValues: {
            ':pk': nativeRuntimeBindingKey(execution.scope).pk,
            ':after': publicationKey(1),
            ':end': publicationKey(upper),
          },
          ScanIndexForward: false,
          Limit: 32,
        }),
      );
      const gaps = [];
      let expected = upper;
      const items = (page.Items ?? []).map((item) => {
        const found = nativePublicationRecord(execution, item);
        const { id, sequence, filesCount, outcome } = found.receipt;
        if (
          sequence > expected ||
          !Number.isSafeInteger(filesCount) ||
          filesCount < 0 ||
          filesCount > 1000 ||
          !['STOPPED', 'WAITING_FOR_INPUT'].includes(outcome) ||
          (found.admittedAt !== null &&
            (!Number.isSafeInteger(found.admittedAt) ||
              !Number.isFinite(new Date(found.admittedAt).getTime()))) ||
          (found.interaction && !SHA.test(found.interaction.id ?? ''))
        )
          throw unavailable();
        if (sequence < expected) gaps.push({ from: sequence + 1, to: expected });
        expected = sequence - 1;
        return {
          id,
          sequence,
          filesCount,
          outcome,
          epoch: found.identity.epoch,
          admittedAt: found.admittedAt,
          interactionId: found.interaction?.id ?? null,
        };
      });
      const nextBefore = page.LastEvaluatedKey && items.length ? items.at(-1).sequence : null;
      if (!nextBefore && expected > 0) gaps.push({ from: 1, to: expected });
      return { items, nextBefore, gaps };
    },
    // Metadata only: used to anchor a revision-specific discussion.
    async verify(execution, revision) {
      return describe(await locate(execution, revision));
    },
    // Exact verified bytes for Quorum. Text larger than maxBytes is supplied
    // as a clearly truncated prefix; binary content is never supplied.
    async read(execution, revision, { maxBytes }) {
      const located = await locate(execution, revision);
      // Match the inline viewer: never download a large object to build context.
      if (located.file.bytes > NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES)
        return { ...describe(located), encoding: 'too_large', content: null, truncated: false };
      let bytes;
      try {
        ({ bytes } = await publications.file(
          located.found.identity,
          located.manifest,
          located.file.id,
        ));
      } catch {
        throw unavailable();
      }
      let text = null;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (text.includes('\0')) text = null;
      } catch {
        text = null;
      }
      const truncated = text !== null && Buffer.byteLength(text) > maxBytes;
      return {
        ...describe(located),
        encoding: text === null ? 'binary' : 'utf8',
        content:
          text === null
            ? null
            : truncated
              ? Buffer.from(text).subarray(0, maxBytes).toString('utf8')
              : text,
        truncated,
      };
    },
  });
};
