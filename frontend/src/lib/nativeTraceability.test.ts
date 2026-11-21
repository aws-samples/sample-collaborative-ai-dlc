import { describe, expect, it } from 'vitest';
import { nativeGraphMatchesPublication, nativeGraphSourceLinks } from './nativeTraceability';
import type { NativeGraph, NativePublication } from '@/services/nativeIntents';

const file = {
  id: 'nf-file',
  path: 'aidlc/note.md',
  sha256: 'a'.repeat(64),
  bytes: 100,
  role: 'artifact' as const,
  mediaType: 'text/markdown',
};
const publication: NativePublication = {
  id: 'pub',
  sequence: 1,
  createdAt: '2026-10-13',
  files: [file],
  question: null,
  projectionStatus: 'complete',
};
const fixture = (): NativeGraph => ({
  publicationId: 'pub',
  nodes: [
    {
      id: 'section',
      label: 'Scope',
      type: 'Section',
      artifactId: file.id,
      path: file.path,
      sha256: file.sha256,
      publicationId: 'pub',
      provenance: {
        projectId: 'p',
        executionId: 'e',
        publicationId: 'pub',
        publicationSequence: 1,
        fileId: file.id,
        sha256: file.sha256,
        path: file.path,
        revisionId: `${file.id}:${file.sha256}`,
        contract: 'native-trace-v1',
        method: 'deterministic',
        sourceKind: 'markdown-section',
        startLine: 1,
        endLine: 4,
      },
    },
  ],
  edges: [],
});
const valid = (graph: NativeGraph) =>
  nativeGraphMatchesPublication(graph, publication, 'p', 'e', null);
describe('native graph revision validation', () => {
  it('omits unaddressable file links for retained manifests', () => {
    expect(nativeGraphSourceLinks(fixture(), publication, '').size).toBe(0);
  });
  it('uses the verified YAML block range and leaves record-path sources at the file', () => {
    const fileId = `nf-${'b'.repeat(64)}`;
    const manifest = { ...publication, id: 'c'.repeat(64), files: [{ ...file, id: fileId }] };
    const base: NativeGraph['nodes'][number] = {
      ...fixture().nodes[0],
      artifactId: fileId,
      publicationId: manifest.id,
    };
    const p = {
      ...(base.provenance as Record<string, unknown>),
      publicationId: manifest.id,
      fileId,
      revisionId: `${fileId}:${file.sha256}`,
    };
    const graph = {
      publicationId: manifest.id,
      edges: [],
      nodes: [
        {
          ...base,
          id: 'requirement',
          type: 'Requirement',
          provenance: { ...p, sourceKind: 'yaml-block' },
        },
        {
          ...base,
          id: 'stage',
          type: 'NativeStage',
          provenance: {
            ...p,
            sourceKind: 'record-path',
            locationContract: 'native-record-layout-v1',
          },
        },
        { id: 'intent', type: 'Intent', label: file.path },
      ],
    };
    expect(nativeGraphMatchesPublication(graph, manifest, 'p', 'e', null)).toBe(true);
    const links = nativeGraphSourceLinks(graph, manifest, '?view=member');
    const href = `?view=member&nativeRevision=1.${manifest.id}&nativeFile=${fileId}%3A${file.sha256}`;
    expect(links.get('requirement')).toBe(`${href}#L1-L4`);
    expect(links.get('stage')).toBe(href);
    expect(links.has('intent')).toBe(false);
  });
  it('accepts exact derived provenance and legacy manifest-only graphs', () => {
    expect(valid(fixture())).toBe(true);
    expect(
      valid({
        publicationId: 'pub',
        nodes: [
          {
            id: file.id,
            type: 'Artifact',
            label: file.path,
            artifactId: file.id,
            provenance: null,
          },
        ],
        edges: [],
      }),
    ).toBe(true);
  });
  it.each([
    'projectId',
    'executionId',
    'publicationId',
    'publicationSequence',
    'fileId',
    'sha256',
    'path',
    'revisionId',
    'contract',
    'method',
    'startLine',
    'endLine',
  ])('rejects mismatched %s despite a valid file ID', (field) => {
    const graph = fixture();
    (graph.nodes[0].provenance as Record<string, unknown>)[field] = 'foreign';
    expect(valid(graph)).toBe(false);
  });
  it('rejects unanchored rich nodes and dangling cross-scope edges', () => {
    const graph = fixture();
    delete graph.nodes[0].provenance;
    expect(valid(graph)).toBe(false);
    const dangling = fixture();
    dangling.edges.push({ source: 'section', target: 'foreign', label: 'COVERS' });
    expect(valid(dangling)).toBe(false);
  });
  it('requires the extraction and location contracts independently for phase/stage links', () => {
    const graph = fixture();
    graph.nodes[0].type = 'NativePhase';
    const p = graph.nodes[0].provenance as Record<string, unknown>;
    p.sourceKind = 'record-path';
    p.locationContract = 'native-record-layout-v1';
    expect(valid(graph)).toBe(true);
    p.contract = p.locationContract;
    expect(valid(graph)).toBe(false);
  });
});
