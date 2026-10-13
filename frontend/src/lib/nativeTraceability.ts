import type { NativeGraph, NativePublication } from '@/services/nativeIntents';

export function nativeGraphMatchesPublication(
  graph: NativeGraph,
  publication: NativePublication,
  projectId: string,
  intentId: string,
  interactionId: string | null,
): boolean {
  const files = new Map(publication.files.map((file) => [file.id, file]));
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (graph.publicationId !== publication.id || ids.size !== graph.nodes.length) return false;
  if (graph.edges.some((edge) => !ids.has(edge.source) || !ids.has(edge.target))) return false;
  return graph.nodes.every((node) => {
    const file = node.artifactId ? files.get(node.artifactId) : undefined;
    if (
      (node.artifactId && !file) ||
      (node.interactionId && node.interactionId !== interactionId) ||
      (node.publicationId !== undefined && node.publicationId !== publication.id) ||
      (node.intentId !== undefined && node.intentId !== intentId) ||
      (node.projectId !== undefined && node.projectId !== projectId) ||
      (node.sha256 !== undefined && node.sha256 !== file?.sha256) ||
      (node.path !== undefined && node.path !== file?.path)
    )
      return false;
    const p = node.provenance as Record<string, unknown> | undefined;
    // Retained manifest-only graph responses remain supported. Rich nodes must
    // prove the complete immutable revision, not merely name an existing file.
    if (!p) return ['Intent', 'Artifact', 'Question', 'NativeInteraction'].includes(node.type);
    if (
      !file ||
      p.contract !== 'native-trace-v1' ||
      p.method !== 'deterministic' ||
      p.projectId !== projectId ||
      p.executionId !== intentId ||
      p.publicationId !== publication.id ||
      p.publicationSequence !== publication.sequence ||
      p.fileId !== file.id ||
      p.sha256 !== file.sha256 ||
      p.path !== file.path ||
      p.revisionId !== `${file.id}:${file.sha256}`
    )
      return false;
    if (p.sourceKind === 'record-path')
      return (
        p.locationContract === 'native-record-layout-v1' &&
        ['NativePhase', 'NativeStage'].includes(node.type)
      );
    return (
      ['markdown-section', 'yaml-block'].includes(String(p.sourceKind)) &&
      Number.isSafeInteger(p.startLine) &&
      Number.isSafeInteger(p.endLine) &&
      Number(p.startLine) >= 1 &&
      Number(p.endLine) >= Number(p.startLine) &&
      Number(p.endLine) <= file.bytes + 1
    );
  });
}
