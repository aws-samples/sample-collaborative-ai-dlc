import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { nativePublicationGraph, projectNativePublication } from '../publication-graph.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativePublications, nativeFileId } from '../../shared/native-publication.js';
import { executionFixture } from './execution-fixtures.js';
import { OTHER, TABLE } from './fixtures.js';
import { memoryGraph } from './native-graph-fixture.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const Q = 'aidlc/spaces/default/intents/pipe-visualization/questions.md';
const source = { branch: 'develop', commit: 'e'.repeat(40) };
const identity = (row) => ({
  ...row.scope,
  attemptId: row.attemptId,
  epoch: row.publicationEpoch ?? row.epoch,
});

// Separate fake local to this suite; tests use the actual publisher, manifest
// validation and protected execution store rather than hand-written DTOs.
const setup = async () => {
  const f = executionFixture();
  const commands = [];
  const originalSend = f.ddb.send.bind(f.ddb);
  f.ddb.send = async (command) => {
    commands.push(command);
    return originalSend(command);
  };
  const objects = new Map();
  const objectKey = (key, version) => `${key}\0${version}`;
  let nextVersion = 0;
  const s3 = {
    send: vi.fn(async (command) => {
      const input = command.input;
      expect(input.Bucket).toBe(f.configuration.publicationBucket);
      expect(input.ExpectedBucketOwner).toBe(f.configuration.accountId);
      if (command instanceof PutObjectCommand) {
        const VersionId = `graph-version-${++nextVersion}`;
        objects.set(objectKey(input.Key, VersionId), Buffer.from(input.Body));
        return { VersionId };
      }
      expect(command).toBeInstanceOf(GetObjectCommand);
      const bytes = objects.get(objectKey(input.Key, input.VersionId));
      if (!bytes) throw new Error('Missing immutable publication object');
      return {
        VersionId: input.VersionId,
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      };
    }),
  };
  const publications = createNativePublications({
    s3,
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
    now: () => '2026-09-29T12:00:00.000Z',
  });
  await f.start();
  const { row: claimed } = await f.store.claim(f.bindingIdentity);
  const active = await f.store.advance({
    row: claimed,
    patch: {
      status: 'DISPATCHING',
      target: f.target(claimed),
      sourceBranch: source.branch,
      sourceCommit: source.commit,
    },
  });
  const files = [
    {
      path: Q,
      role: 'question',
      content: Buffer.from('# Question\n\nChange the pipe colour?\n\n[Answer]:\n'),
    },
    { path: 'src/game.ts', role: 'code', content: Buffer.from('const colour = "green";\n') },
    { path: 'aidlc/active-space', role: 'state', content: Buffer.from('default\n') },
    {
      path: 'aidlc/spaces/default/intents/pipe-visualization/design.md',
      role: 'artifact',
      content: Buffer.from('# Design\n'),
    },
  ];
  const publicationInput = {
    identity: identity(active),
    packageId: f.configuration.packageId,
    nativeSessionId: 'session-one',
    outcome: 'WAITING_FOR_INPUT',
    repository: source,
    files,
    questionPath: Q,
  };
  const receipt = await publications.write(publicationInput);
  const row = await f.store.publish({ row: active, publication: receipt });
  const manifest = await publications.read(identity(row), receipt, { verifyFiles: true });
  const authorization = { member: true };
  const recheck = vi.fn(async () => {
    if (!authorization.member)
      throw Object.assign(new Error('Membership revoked'), {
        code: 'NATIVE_PREPARATION_FORBIDDEN',
      });
  });
  const api = createNativeExecutionApi({
    enabled: true,
    store: f.store,
    publications,
    configure: vi.fn(),
    enqueue: vi.fn(),
    authorizeSource: vi.fn(),
  });
  const authorize = vi.fn(async () => {
    await recheck();
    const current = await f.store.get(f.identity);
    if (
      current.cancelRequested ||
      current.publication?.id !== receipt.id ||
      current.bindingId !== row.bindingId ||
      current.epoch !== row.epoch
    )
      throw Object.assign(new Error('Projection authorization changed'), {
        code: 'NATIVE_EXECUTION_CONFLICT',
      });
  });
  return {
    ...f,
    s3,
    objects,
    publications,
    publicationInput,
    files,
    row,
    receipt,
    manifest,
    authorization,
    recheck,
    authorize,
    api,
    commands,
    objectKey,
  };
};

describe('native member graph from the protected committed manifest', () => {
  it('replaces current edges on the next publication without removing foreign scope or exact history', async () => {
    const f = await setup();
    const graph = memoryGraph();
    await projectNativePublication({
      g: graph.g,
      draft: f.prepared,
      publication: f.receipt,
      manifest: f.manifest,
      authorize: f.authorize,
    });
    const parent = nativePublicationGraph({
      draft: f.prepared,
      publication: f.receipt,
      manifest: f.manifest,
    }).nodes[0].id;
    const removedFile = f.manifest.files.find((file) => file.path === Q);
    graph.vertices.set('foreign', {
      label: 'Artifact',
      properties: {
        project_id: ['different-project', f.prepared.projectId],
        intent_id: parent,
        native_execution_id: f.prepared.executionId,
        execution_backend: 'native',
        publication_id: f.receipt.id,
      },
    });
    graph.edges.set('foreign-edge', {
      source: parent,
      target: 'foreign',
      label: 'CONTAINS',
    });
    const publication = { ...f.receipt, id: 'd'.repeat(64), sequence: 2 };
    const manifest = {
      ...f.manifest,
      sequence: 2,
      question: null,
      files: f.manifest.files.filter((file) => file.id !== removedFile.id),
    };
    const apply = () =>
      projectNativePublication({
        g: graph.g,
        draft: f.prepared,
        publication,
        manifest,
        authorize: f.authorize,
      });
    await apply();
    const currentEdges = [...graph.edges.values()].filter((edge) => edge.source === parent);
    expect(currentEdges.map((edge) => edge.target).toSorted()).toEqual(
      [...manifest.files.map((file) => file.id), 'foreign'].toSorted(),
    );
    expect(graph.vertices.has(removedFile.id)).toBe(true);
    const edges = [...graph.edges.entries()];
    await apply();
    expect([...graph.edges.entries()]).toEqual(edges);
    const historical = await f.publications.read(identity(f.row), f.receipt, { verifyFiles: true });
    expect(historical.files.some((file) => file.id === removedFile.id)).toBe(true);
  });

  it('links every exact file and the waiting question without inventing stages or workflow authority', async () => {
    const f = await setup();
    const graph = await f.api.graph(f.prepared, f.recheck);
    const intent = graph.nodes.find((node) => node.type === 'Intent');
    const question = graph.nodes.find((node) => node.type === 'Question');
    expect(graph.publicationId).toBe(f.receipt.id);
    expect(intent).toMatchObject({
      executionBackend: 'native',
      intentId: f.prepared.executionId,
      label: f.prepared.request.title,
    });
    expect(graph.nodes).toHaveLength(f.files.length + 2);
    expect(graph.nodes.filter((node) => node.type === 'Artifact')).toEqual(
      f.manifest.files.map((file) => ({
        id: file.id,
        type: 'Artifact',
        label: file.path,
        artifactId: file.id,
        artifactType: file.role === 'code' ? 'native-code' : 'native-file',
        path: file.path,
        sha256: file.sha256,
        publicationId: f.receipt.id,
      })),
    );
    expect(question).toMatchObject({
      label: Q,
      artifactId: f.manifest.question.fileId,
      status: 'awaiting_answer',
      publicationId: f.receipt.id,
    });
    expect(graph.edges).toEqual([
      ...f.manifest.files.map((file) => ({
        source: intent.id,
        target: file.id,
        label: 'CONTAINS',
      })),
      { source: intent.id, target: question.id, label: 'CONTAINS' },
      { source: question.id, target: f.manifest.question.fileId, label: 'RELATES_TO' },
    ]);
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(ids.size).toBe(graph.nodes.length);
    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
    for (const hidden of [
      'versionId',
      'object',
      'credentialBinding',
      'runtimeArn',
      f.configuration.packageBucket,
      f.configuration.publicationBucket,
    ])
      expect(JSON.stringify(graph)).not.toContain(hidden);
    expect(
      graph.nodes.every((node) => ['Intent', 'Artifact', 'Question'].includes(node.type)),
    ).toBe(true);
  });

  it('ignores a staged uncommitted manifest and any platform META/graph lookalike', async () => {
    const f = await setup();
    const extra = {
      path: 'uncommitted-or-agent-forged.md',
      role: 'artifact',
      content: Buffer.from('untrusted'),
    };
    await f.publications.write({ ...f.publicationInput, files: [...f.files, extra] });
    const graph = await f.api.graph(
      {
        ...f.prepared,
        meta: { executionBackend: 'native', status: 'SUCCEEDED', publication: { id: 'forged' } },
        graph: { nodes: [{ id: 'forged', path: extra.path }] },
      },
      f.recheck,
    );
    expect(graph.publicationId).toBe(f.receipt.id);
    expect(graph.nodes.some((node) => node.path === extra.path || node.id === 'forged')).toBe(
      false,
    );
    expect(graph.nodes.filter((node) => node.type === 'Artifact')).toHaveLength(f.files.length);
  });

  it('keeps stable file/question graph identities when the same exact paths are republished', async () => {
    const f = await setup();
    const later = await f.publications.write(f.publicationInput);
    const manifest = await f.publications.read(identity(f.row), later);
    const first = nativePublicationGraph({
      draft: f.prepared,
      publication: f.receipt,
      manifest: f.manifest,
    });
    const next = nativePublicationGraph({ draft: f.prepared, publication: later, manifest });
    expect(later.id).not.toBe(f.receipt.id);
    expect(next.nodes.map((node) => node.id)).toEqual(first.nodes.map((node) => node.id));
    expect(next.edges).toEqual(first.edges);
    expect(
      next.nodes
        .filter((node) => node.type !== 'Intent')
        .every((node) => node.publicationId === later.id),
    ).toBe(true);
  });

  it('isolates all graph identities across projects even when their chosen execution UUID is the same', async () => {
    const f = await setup();
    const otherIdentity = { ...identity(f.row), projectId: OTHER };
    const receipt = await f.publications.write({ ...f.publicationInput, identity: otherIdentity });
    const manifest = await f.publications.read(otherIdentity, receipt);
    const otherDraft = { ...f.prepared, projectId: OTHER };
    const first = nativePublicationGraph({
      draft: f.prepared,
      publication: f.receipt,
      manifest: f.manifest,
    });
    const second = nativePublicationGraph({ draft: otherDraft, publication: receipt, manifest });
    expect(second.nodes.filter((node) => node.type === 'Artifact').map((node) => node.id)).toEqual(
      f.files.map((file) => nativeFileId(otherIdentity, file.path)),
    );
    const firstIds = new Set(first.nodes.map((node) => node.id));
    expect(second.nodes.filter((node) => firstIds.has(node.id))).toEqual([]);
    for (const type of ['Intent', 'Question']) {
      expect(second.nodes.find((node) => node.type === type).id).not.toBe(
        first.nodes.find((node) => node.type === type).id,
      );
    }
  });

  it('rejects tampered manifest bytes instead of projecting their links', async () => {
    const f = await setup();
    const pointer = f.receipt.manifest;
    const key = f.objectKey(pointer.key, pointer.versionId);
    const bytes = Buffer.from(f.objects.get(key));
    bytes[24] ^= 1;
    f.objects.set(key, bytes);
    await expect(f.api.graph(f.prepared, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_PUBLICATION_INVALID',
    });
  });

  it('rejects an internally inconsistent question-to-file reference even when the manifest hash is recomputed', async () => {
    const f = await setup();
    const manifest = structuredClone(f.manifest);
    manifest.question.fileId = manifest.files.find((file) => file.path === 'src/game.ts').id;
    const bytes = Buffer.from(JSON.stringify(manifest));
    const sha256 = hash(bytes);
    const key = f.receipt.manifest.key.replace(f.receipt.manifest.sha256, sha256);
    f.objects.set(f.objectKey(key, 'forged-version'), bytes);
    await expect(
      f.publications.read(identity(f.row), {
        ...f.receipt,
        id: sha256,
        manifest: { key, versionId: 'forged-version', sha256, bytes: bytes.length },
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
  });

  it('preserves historical graph/file links after cancel without reading the new cancellation epoch', async () => {
    const f = await setup();
    const before = await f.api.graph(f.prepared, f.recheck);
    await f.store.cancel(f.bindingIdentity);
    expect(await f.api.graph(f.prepared, f.recheck)).toEqual(before);
    expect((await f.store.get(f.identity)).publicationEpoch).toBe(1);
  });
});

describe('replayable native Neptune projection', () => {
  it('projects only native properties and replays without duplicate vertices or edges', async () => {
    const f = await setup();
    const memory = memoryGraph();
    const input = {
      g: memory.g,
      draft: f.prepared,
      publication: f.receipt,
      manifest: f.manifest,
      authorize: f.authorize,
    };
    const before = f.commands.length;
    const first = await projectNativePublication(input);
    const once = {
      vertices: structuredClone([...memory.vertices]),
      edges: structuredClone([...memory.edges]),
    };
    const second = await projectNativePublication(input);
    expect(second).toEqual(first);
    expect([...memory.vertices]).toEqual(once.vertices);
    expect([...memory.edges]).toEqual(once.edges);
    expect(memory.vertices.size).toBe(first.nodes.length);
    expect(memory.edges.size).toBe(first.edges.length);
    for (const vertex of memory.vertices.values()) {
      expect(vertex.properties).toMatchObject({
        project_id: f.prepared.projectId,
        native_execution_id: f.prepared.executionId,
        execution_backend: 'native',
        publication_id: f.receipt.id,
      });
      expect(vertex.properties).not.toHaveProperty('credentialBinding');
      expect(vertex.properties).not.toHaveProperty('status');
    }
    expect(f.commands.slice(before).every((command) => command instanceof GetCommand)).toBe(true);
    expect(f.commands.slice(before).every((command) => command.input.TableName === TABLE)).toBe(
      true,
    );
    expect(f.authorize).toHaveBeenCalled();
  });

  it('does not write graph state when authorization is already revoked', async () => {
    const f = await setup();
    const memory = memoryGraph();
    f.authorization.member = false;
    await expect(
      projectNativePublication({
        g: memory.g,
        draft: f.prepared,
        publication: f.receipt,
        manifest: f.manifest,
        authorize: f.authorize,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PREPARATION_FORBIDDEN' });
    expect(memory.writes).toEqual([]);
    expect((await f.store.get(f.identity)).projectionStatus).toBe('pending');
  });

  it.each([
    [
      'foreign project',
      (vertex) => {
        vertex.properties.project_id = OTHER;
      },
    ],
    [
      'foreign execution',
      (vertex) => {
        vertex.properties.native_execution_id = OTHER;
      },
    ],
    [
      'foreign intent',
      (vertex) => {
        vertex.properties.intent_id = 'platform-intent';
      },
    ],
    [
      'platform backend',
      (vertex) => {
        vertex.properties.execution_backend = 'platform';
      },
    ],
    [
      'wrong logical id',
      (vertex) => {
        vertex.properties.id = 'foreign-file';
      },
    ],
    [
      'missing scope',
      (vertex) => {
        delete vertex.properties.project_id;
      },
    ],
    [
      'mixed project values',
      (vertex) => {
        vertex.properties.project_id = [vertex.properties.project_id, OTHER];
      },
    ],
    [
      'duplicate scope values',
      (vertex) => {
        vertex.properties.project_id = [vertex.properties.project_id, vertex.properties.project_id];
      },
    ],
    [
      'wrong vertex label',
      (vertex) => {
        vertex.label = 'Question';
      },
    ],
  ])(
    'refuses an existing vertex with %s without repairing or overwriting its scope',
    async (_label, mutate) => {
      const f = await setup();
      const memory = memoryGraph();
      const graph = nativePublicationGraph({
        draft: f.prepared,
        publication: f.receipt,
        manifest: f.manifest,
      });
      const intent = graph.nodes.find((node) => node.type === 'Intent');
      const artifact = graph.nodes.find((node) => node.type === 'Artifact');
      const vertex = {
        id: artifact.id,
        label: 'Artifact',
        properties: {
          id: artifact.id,
          project_id: f.prepared.projectId,
          intent_id: intent.id,
          native_execution_id: f.prepared.executionId,
          execution_backend: 'native',
          title: 'Preserve existing owner data',
          publication_id: 'original-publication',
        },
      };
      mutate(vertex);
      memory.vertices.set(vertex.id, structuredClone(vertex));
      await expect(
        projectNativePublication({
          g: memory.g,
          draft: f.prepared,
          publication: f.receipt,
          manifest: f.manifest,
          authorize: f.authorize,
        }),
      ).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
      expect(memory.vertices.get(vertex.id)).toEqual(vertex);
      expect(memory.writes.filter((write) => write.id === vertex.id)).toEqual([]);
      expect(memory.edges.size).toBe(0);
      expect((await f.store.get(f.identity)).projectionStatus).toBe('pending');
    },
  );

  it.each(['vertex acknowledgement', 'second edge'])(
    'retries a partial projection after a lost %s without collisions or duplicate graph records',
    async (phase) => {
      const f = await setup();
      const memory = memoryGraph();
      let failed = false;
      let edgeCount = 0;
      const transient = new Error('simulated graph transport interruption');
      if (phase === 'vertex acknowledgement') {
        memory.hooks.after = ({ kind }) => {
          if (!failed && kind === 'V') {
            failed = true;
            throw transient;
          }
        };
      } else {
        memory.hooks.before = ({ kind }) => {
          if (kind === 'E' && ++edgeCount === 2 && !failed) {
            failed = true;
            throw transient;
          }
        };
      }
      const input = {
        g: memory.g,
        draft: f.prepared,
        publication: f.receipt,
        manifest: f.manifest,
        authorize: f.authorize,
      };
      await expect(projectNativePublication(input)).rejects.toBe(transient);
      expect(memory.vertices.size).toBeGreaterThan(0);
      for (const vertex of memory.vertices.values()) {
        expect(vertex.properties).toMatchObject({
          project_id: f.prepared.projectId,
          native_execution_id: f.prepared.executionId,
          execution_backend: 'native',
        });
      }
      expect((await f.store.get(f.identity)).projectionStatus).toBe('pending');
      const graph = await projectNativePublication(input);
      expect(memory.vertices.size).toBe(graph.nodes.length);
      expect(memory.edges.size).toBe(graph.edges.length);
      expect(memory.writes.filter((write) => write.kind === 'vertex')).toHaveLength(
        graph.nodes.length,
      );
      expect(memory.writes.filter((write) => write.kind === 'edge')).toHaveLength(
        graph.edges.length,
      );
      expect(await projectNativePublication(input)).toEqual(graph);
      expect(memory.vertices.size).toBe(graph.nodes.length);
      expect(memory.edges.size).toBe(graph.edges.length);
    },
  );

  it('does not finish or acknowledge a projection after protected cancellation', async () => {
    const f = await setup();
    const memory = memoryGraph();
    let checks = 0;
    const authorize = async () => {
      if (++checks === 2) await f.store.cancel(f.bindingIdentity);
      await f.authorize();
    };
    await expect(
      projectNativePublication({
        g: memory.g,
        draft: f.prepared,
        publication: f.receipt,
        manifest: f.manifest,
        authorize,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
    expect(memory.edges.size).toBe(0);
    expect((await f.store.get(f.identity)).projectionStatus).toBe('pending');
    await expect(f.store.projected({ row: f.row })).rejects.toHaveProperty('code');
  });

  it('acknowledges a successful projection only through the protected native store', async () => {
    const f = await setup();
    const memory = memoryGraph();
    await projectNativePublication({
      g: memory.g,
      draft: f.prepared,
      publication: f.receipt,
      manifest: f.manifest,
      authorize: f.authorize,
    });
    const count = f.commands.length;
    const row = await f.store.projected({ row: f.row });
    expect(row.projectionStatus).toBe('complete');
    expect(await f.api.publication(f.prepared, f.recheck)).toMatchObject({
      id: f.receipt.id,
      projectionStatus: 'complete',
    });
    const writes = f.commands
      .slice(count)
      .filter((command) => command instanceof TransactWriteCommand);
    expect(writes).toHaveLength(1);
    for (const action of writes[0].input.TransactItems) {
      const operation = action.Put ?? action.ConditionCheck;
      expect(operation.TableName).toBe(TABLE);
      expect((operation.Item ?? operation.Key).sk).toBe('EXECUTION');
    }
  });
});
