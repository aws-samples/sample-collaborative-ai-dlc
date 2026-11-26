import { createHash } from 'node:crypto';
import gremlin from 'gremlin';
import { isDeepStrictEqual } from 'node:util';
import { executionIdentity } from './execution-runtime.js';
import { nativeInteractionReceipt } from '../shared/native-interaction.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const intentVertexId = (draft) =>
  `native-intent-${digest(JSON.stringify([draft.projectId, draft.executionId]))}`;
const scopeMismatch = () => {
  throw Object.assign(new Error('Native publication graph scope mismatch'), {
    code: 'NATIVE_PUBLICATION_INVALID',
  });
};
const interactionMismatch = () => {
  throw Object.assign(new Error('Native graph interaction does not match its publication'), {
    code: 'NATIVE_INTERACTION_INVALID',
  });
};
const verifiedInteractions = new WeakMap();
const publicationRevision = (row) =>
  row && {
    identity: executionIdentity(row),
    publication: row.publication,
    publicationEpoch: row.publicationEpoch,
    interaction: row.interaction ?? null,
    interactionEpoch: row.interactionEpoch ?? null,
    interactionContentSha256: row.interactionContentSha256 ?? null,
    packageId: row.configuration.packageId,
    harness: row.configuration.harness,
  };
export const sameNativePublicationRevision = (left, right) =>
  isDeepStrictEqual(publicationRevision(left), publicationRevision(right));

// Only references read and verified from immutable storage can add a response
// node. Keep the body private: graph ports receive neither text nor authority.
export const readNativePublicationInteraction = async ({ draft, row, manifest, interactions }) => {
  if (!row.interaction) return null;
  if (!interactions || !row.publication) interactionMismatch();
  const identity = { ...executionIdentity(row), epoch: row.interactionEpoch };
  const receipt = nativeInteractionReceipt(row.interaction, identity);
  const publication = row.publication;
  if (
    draft.projectId !== row.scope.projectId ||
    draft.executionId !== row.scope.executionId ||
    draft.bindingId !== row.bindingId ||
    row.interactionEpoch !== row.publicationEpoch ||
    receipt.publicationId !== publication.id ||
    receipt.sequence !== publication.sequence ||
    receipt.nativeSessionId !== publication.nativeSessionId ||
    manifest.sequence !== publication.sequence ||
    manifest.nativeSessionId !== publication.nativeSessionId ||
    manifest.packageId !== row.configuration.packageId
  )
    interactionMismatch();
  const body = await interactions.read(identity, receipt);
  if (
    !isDeepStrictEqual(body.scope, identity) ||
    body.publicationId !== publication.id ||
    body.sequence !== publication.sequence ||
    body.nativeSessionId !== publication.nativeSessionId ||
    body.packageId !== row.configuration.packageId ||
    body.harness !== row.configuration.harness ||
    body.contentSha256 !== row.interactionContentSha256
  )
    interactionMismatch();
  const reference = Object.freeze({ interactionId: receipt.id, publicationId: publication.id });
  verifiedInteractions.set(reference, {
    projectId: draft.projectId,
    executionId: draft.executionId,
    bindingId: draft.bindingId,
    publicationId: publication.id,
    sequence: publication.sequence,
    nativeSessionId: publication.nativeSessionId,
    packageId: manifest.packageId,
  });
  return reference;
};

// The member-facing graph is derived from the protected committed manifest.
// Neptune is a replayable projection; an agent-written graph row never
// determines which file or revision a native member is allowed to read.
export const nativePublicationGraph = ({ draft, publication, manifest, interaction }) => {
  const intentId = intentVertexId(draft);
  const nodes = [
    {
      id: intentId,
      type: 'Intent',
      label: draft.request.title || 'Native intent',
      executionBackend: 'native',
      intentId: draft.executionId,
    },
  ];
  const edges = [];
  if (interaction) {
    const verified = verifiedInteractions.get(interaction);
    if (
      !verified ||
      !isDeepStrictEqual(verified, {
        projectId: draft.projectId,
        executionId: draft.executionId,
        bindingId: draft.bindingId,
        publicationId: publication.id,
        sequence: publication.sequence,
        nativeSessionId: publication.nativeSessionId,
        packageId: manifest.packageId,
      })
    )
      interactionMismatch();
    const id = `native-interaction-${digest(
      JSON.stringify([
        draft.projectId,
        draft.executionId,
        publication.id,
        interaction.interactionId,
      ]),
    )}`;
    nodes.push({
      id,
      type: 'NativeInteraction',
      label: 'AI-DLC response',
      interactionId: interaction.interactionId,
      publicationId: publication.id,
    });
    edges.push({ source: intentId, target: id, label: 'CONTAINS' });
  }
  for (const file of manifest.files) {
    nodes.push({
      id: file.id,
      type: 'Artifact',
      label: file.path,
      artifactId: file.id,
      artifactType: file.role === 'code' ? 'native-code' : 'native-file',
      path: file.path,
      sha256: file.sha256,
      publicationId: publication.id,
    });
    edges.push({ source: intentId, target: file.id, label: 'CONTAINS' });
  }
  if (manifest.question) {
    const id = `native-question-${digest(
      JSON.stringify([draft.projectId, draft.executionId, manifest.question.fileId]),
    )}`;
    nodes.push({
      id,
      type: 'Question',
      label: manifest.question.path,
      artifactId: manifest.question.fileId,
      status: 'awaiting_answer',
      publicationId: publication.id,
    });
    edges.push({ source: intentId, target: id, label: 'CONTAINS' });
    edges.push({ source: id, target: manifest.question.fileId, label: 'RELATES_TO' });
  }
  return { publicationId: publication.id, nodes, edges };
};

export const projectNativePublication = async ({
  g,
  draft,
  publication,
  manifest,
  interaction,
  authorize,
}) => {
  const { t, cardinality, statics: __ } = gremlin.process;
  const graph = nativePublicationGraph({ draft, publication, manifest, interaction });
  const protectedScope = {
    project_id: draft.projectId,
    intent_id: intentVertexId(draft),
    native_execution_id: draft.executionId,
    execution_backend: 'native',
  };
  for (const node of graph.nodes) {
    await authorize();
    const scope = {
      id: node.id,
      ...protectedScope,
      ...(node.interactionId
        ? {
            interaction_id: node.interactionId,
            publication_id: publication.id,
          }
        : {}),
    };
    // Initialize scope in the same traversal that creates the vertex. Even a
    // retry after a partially completed projection can prove its ownership.
    let create = __.addV(node.type).property(t.id, node.id);
    for (const [key, value] of Object.entries(scope)) {
      create = create.property(cardinality.single, key, value);
    }
    let query = g.V(node.id).fold().coalesce(__.unfold(), create).hasLabel(node.type);
    // Filter before ANY update, in the same request as the write. Never repair
    // an existing vertex's authority fields. Requiring exactly one value also
    // rejects vertices with both our scope and a foreign scope in a list.
    for (const [key, value] of Object.entries(scope)) {
      query = query.has(key, value).filter(__.properties(key).count().is(1));
    }
    query = query
      .property(cardinality.single, 'publication_id', publication.id)
      .property(cardinality.single, 'title', node.label);
    if (node.artifactId) query = query.property(cardinality.single, 'artifact_id', node.artifactId);
    if (node.path) query = query.property(cardinality.single, 'native_path', node.path);
    if (node.sha256) query = query.property(cardinality.single, 'content_hash', node.sha256);
    if (node.artifactType)
      query = query.property(cardinality.single, 'artifact_type', node.artifactType);
    const written = await query.id().next();
    if (written.done || written.value !== node.id) scopeMismatch();
  }
  for (const edge of graph.edges) {
    await authorize();
    const id = `native-edge-${digest(JSON.stringify(edge))}`;
    await g
      .E(id)
      .fold()
      .coalesce(
        __.unfold(),
        __.V(edge.source).addE(edge.label).to(__.V(edge.target)).property(t.id, id),
      )
      .next();
  }
  if (publication.sequence > 1) {
    await authorize();
    // The protected publication history retains old exact bytes. Neptune is
    // the current projection: disconnect superseded files/questions/responses only when
    // both the parent and target still prove this execution's unique scope.
    let parent = g.V(intentVertexId(draft)).hasLabel('Intent');
    for (const [key, value] of Object.entries({ id: intentVertexId(draft), ...protectedScope })) {
      parent = parent.has(key, value).filter(__.properties(key).count().is(1));
    }
    let stale = __.inV().hasLabel('Artifact', 'Question', 'NativeInteraction');
    for (const [key, value] of Object.entries(protectedScope)) {
      stale = stale.has(key, value).filter(__.properties(key).count().is(1));
    }
    stale = stale
      .has('publication_id')
      .filter(__.properties('publication_id').count().is(1))
      .not(__.has('publication_id', publication.id));
    // Gremlin 3.8's iterate() appends discard, which this Neptune engine does
    // not support. Consume the drop traversal without adding a terminal step.
    await parent.outE('CONTAINS').filter(stale).drop().toList();
  }
  await authorize();
  return graph;
};
