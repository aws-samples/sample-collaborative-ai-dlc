import { describe, expect, it } from 'vitest';
import { nativeTraceFixture, ROOT, requirementBytes, traceFiles } from './native-trace-fixture.js';
import { memoryGraph } from './native-graph-fixture.js';
import { nativeProjectionStatus } from '../projection-store.js';
import { nativePublicationGraph, projectNativePublication } from '../publication-graph.js';
import { readNativePublicationTrace } from '../publication-trace.js';
import { TABLE } from './fixtures.js';
import { NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES } from '../../shared/native-artifact-revision.js';

describe('admitted native traceability', () => {
  it('uses exact immutable bytes for the API and independent projector, with revision provenance', async () => {
    const memory = memoryGraph();
    const f = await nativeTraceFixture(memory.g);
    const api = await f.api.graph(f.prepared, f.recheck);
    await f.run(f.identity);
    expect(nativePublicationGraph(f.inputs[0])).toEqual(api);
    const requirement = api.nodes.find((node) => node.type === 'Requirement');
    expect(requirement).toMatchObject({
      label: 'Login',
      provenance: {
        projectId: f.identity.projectId,
        executionId: f.identity.executionId,
        publicationId: f.row().publication.id,
        publicationSequence: 1,
        sourceKind: 'yaml-block',
        startLine: 5,
        endLine: 10,
        artifactType: 'requirements',
      },
    });
    const file = await f.api.file(f.prepared, requirement.artifactId, f.recheck);
    expect(Buffer.from(file.content)).toEqual(requirementBytes);
    expect(requirement.sha256).toBe(file.sha256);
    expect(requirement.provenance.revisionId).toBe(`${file.id}:${file.sha256}`);
    expect(api.edges).toContainEqual({
      source: api.nodes.find((node) => node.type === 'Story').id,
      target: requirement.id,
      label: 'COVERS',
    });
    expect(api.nodes.filter((node) => node.type === 'NativePhase')).toHaveLength(1);
    expect(api.nodes.filter((node) => node.type === 'NativeStage')).toHaveLength(3);
    expect(
      api.nodes
        .filter((node) => node.provenance)
        .every((node) => node.provenance.contract === 'native-trace-v1'),
    ).toBe(true);
    expect(api.nodes.find((node) => node.type === 'Decision')).toMatchObject({
      declared: { status: 'accepted' },
    });
    expect(requirement).not.toHaveProperty('status');
    expect(api.nodes.find((node) => node.type === 'Decision')).not.toHaveProperty('status');
    expect(api.traceability.enrichment).toBe('off');
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
    expect(JSON.stringify(api)).not.toMatch(/versionId|credentialBinding|runtimeSessionId/);
  });

  it('keeps unknown, malformed, binary and private legacy formats generic and readable', async () => {
    const files = [
      {
        path: `${ROOT}/notes.custom`,
        role: 'artifact',
        content: Buffer.from('Unknown exact file'),
      },
      {
        path: `${ROOT}/requirements.md`,
        role: 'artifact',
        content: Buffer.from('## Plain\n- [x] approved'),
      },
      {
        path: `${ROOT}/bad.md`,
        role: 'artifact',
        content: Buffer.from('## Readable\n```yaml\nrequirements: [null]\n```'),
      },
      { path: `${ROOT}/binary.md`, role: 'artifact', content: Buffer.from([0xff, 0x00]) },
      {
        path: 'aidlc/.aidlc-sessions/legacy.md',
        role: 'artifact',
        content: Buffer.from('## Private\nNever index'),
      },
      {
        path: `${ROOT}/.env.md`,
        role: 'artifact',
        content: Buffer.from('## Credential\nNever index'),
      },
      {
        path: `${ROOT}/.aws/notes.md`,
        role: 'artifact',
        content: Buffer.from('## Credential\nNever index'),
      },
    ];
    const f = await nativeTraceFixture(memoryGraph().g, files);
    await f.run(f.identity);
    const graph = await f.api.graph(f.prepared, f.recheck);
    expect(
      graph.nodes
        .filter((node) => node.type === 'Section')
        .map((node) => node.label)
        .toSorted(),
    ).toEqual(['Plain', 'Readable']);
    expect(
      graph.nodes.some((node) => ['Requirement', 'NativePhase', 'NativeStage'].includes(node.type)),
    ).toBe(false);
    expect(graph.traceability.files.filter((file) => file.status === 'incompatible')).toHaveLength(
      1,
    );
    const listing = await f.api.publication(f.prepared, f.recheck);
    for (const file of listing.files)
      expect((await f.api.file(f.prepared, file.id, f.recheck)).sha256).toBe(file.sha256);
  });

  it('does not link duplicate claims, different record roots, or sibling construction units', async () => {
    const files = traceFiles();
    files.push({ ...files[0], path: `${ROOT}/inception/requirements-analysis/duplicate.md` });
    files.push({ ...files[0], path: `${ROOT}-other/inception/requirements-analysis/only.md` });
    files.push({ ...files[0], path: `${ROOT}/construction/unit-a/design/only.md` });
    files.push({ ...files[1], path: `${ROOT}/construction/unit-b/design/story.md` });
    const f = await nativeTraceFixture(memoryGraph().g, files);
    const graph = await f.api.graph(f.prepared, f.recheck);
    expect(graph.edges.filter((edge) => edge.label === 'COVERS')).toEqual([]);
  });

  it('retains all raw files and reports resource limits without a truncated extraction', async () => {
    const files = [
      {
        path: `${ROOT}/big.md`,
        role: 'artifact',
        content: Buffer.alloc(NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES + 1, 65),
      },
      {
        path: `${ROOT}/many.md`,
        role: 'artifact',
        content: Buffer.from('## Repeated\n'.repeat(1001)),
      },
    ];
    const f = await nativeTraceFixture(memoryGraph().g, files);
    const graph = await f.api.graph(f.prepared, f.recheck);
    expect(graph.nodes.filter((node) => node.type === 'Artifact')).toHaveLength(2);
    expect(graph.nodes.some((node) => node.type === 'Section')).toBe(false);
    expect(graph.traceability.files.map((file) => file.status)).toEqual([
      'byte_limit',
      'structure_limit',
    ]);
    const large = graph.nodes.find((node) => node.path?.endsWith('/big.md'));
    expect(f.reads.some((read) => read.Key.includes(`/files/${large.id}/`))).toBe(false);
  });

  it('rejects tampered exact versions and revoked membership without acknowledging projection', async () => {
    const memory = memoryGraph();
    const f = await nativeTraceFixture(memory.g);
    const key = [...f.objects.keys()].find((objectKey) => objectKey.includes('/files/'));
    f.objects.set(key, Buffer.from('tampered'));
    await expect(f.run(f.identity)).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
    expect(memory.writes).toEqual([]);
    f.authorization.member = false;
    await expect(f.api.graph(f.prepared, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_FORBIDDEN',
    });
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('pending');
  });

  it('isolates file reads and reply dispatch from an unavailable graph', async () => {
    const memory = memoryGraph();
    const f = await nativeTraceFixture(memory.g);
    memory.hooks.before = () => {
      throw new Error('Graph outage');
    };
    await expect(f.run(f.identity)).rejects.toThrow('Graph outage');
    const listing = await f.api.publication(f.prepared, f.recheck);
    expect((await f.api.file(f.prepared, listing.files[0].id, f.recheck)).content).toBe(
      requirementBytes.toString(),
    );
    await f.api.respond(f.prepared, 'member', f.replyRequest(), f.recheck);
    expect(f.row().status).toBe('DISPATCHING');
    expect(f.enqueue).toHaveBeenCalled();
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('pending');
    delete memory.hooks.before;
    await f.run(f.identity);
    expect(f.row().status).toBe('DISPATCHING');
  });

  it('rebuilds an older completed cursor once, retaining its current immutable head', async () => {
    const f = await nativeTraceFixture(memoryGraph().g);
    f.hooks.before = (command) => {
      const progress = command.input.TransactItems?.find(
        (item) => item.Put?.Item.sk === 'PROJECTION',
      )?.Put.Item;
      if (progress) delete progress.projectionVersion;
    };
    await f.run(f.identity);
    delete f.hooks.before;
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('pending');
    await f.run(f.identity);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
    expect((await f.projection.claim(f.identity)).kind).toBe('complete');
  });

  it('rejects forged trace tokens and cross-project/execution reuse', async () => {
    const f = await nativeTraceFixture(memoryGraph().g);
    await f.run(f.identity);
    const input = f.inputs[0];
    expect(() =>
      nativePublicationGraph({ ...input, trace: structuredClone(input.trace) }),
    ).toThrow();
    expect(() =>
      nativePublicationGraph({ ...input, draft: { ...f.prepared, projectId: 'other' } }),
    ).toThrow();
    await expect(
      readNativePublicationTrace({
        ...input,
        draft: { ...f.prepared, executionId: 'other' },
        publications: f.publications,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
    await expect(projectNativePublication({ ...input, g: memoryGraph().g })).resolves.toBeDefined();
  });

  it('processes queued history in order and rejects a lease lost during a partial write', async () => {
    const memory = memoryGraph();
    const f = await nativeTraceFixture(memory.g);
    await f.next(traceFiles().slice(0, 2));
    let replacement;
    let paused = false;
    memory.hooks.after = async ({ kind }) => {
      if (paused || kind !== 'V') return;
      paused = true;
      f.tick(181000);
      replacement = await f.projection.claim(f.identity);
    };
    await expect(f.run(f.identity)).rejects.toMatchObject({ code: 'NATIVE_PROJECTION_CONFLICT' });
    expect(replacement.row.publication.sequence).toBe(1);
    await f.projection.release(replacement);
    delete memory.hooks.after;
    await f.run(f.identity);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('pending');
    await f.run(f.identity);
    expect(f.inputs.map((input) => input.publication.sequence)).toEqual([1, 1, 2]);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
    const graph = nativePublicationGraph(f.inputs.at(-1));
    const current = graph.nodes.find((node) => node.type === 'Requirement');
    expect(
      [...memory.edges.values()].filter(
        (edge) => edge.source === current.artifactId && edge.label === 'HAS_ITEM',
      ),
    ).toEqual([expect.objectContaining({ target: current.id })]);
  });
});
