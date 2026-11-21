import type { NativeGraph, NativePublication } from '@/services/nativeIntents';
import { nativeFileRevisionSearch } from './nativeRevisionLinks';

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
      (node.type === 'Question' &&
        node.artifactId &&
        node.artifactId !== publication.question?.fileId) ||
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
    if (p == null)
      return ['Intent', 'Artifact', 'Question', 'NativeInteraction'].includes(node.type);
    if (
      typeof p !== 'object' ||
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

/** Called only for a graph accepted against this publication's manifest. */
export function nativeGraphSourceLinks(
  graph: NativeGraph,
  publication: NativePublication,
  search: string,
) {
  const target = { publicationId: publication.id, publicationSequence: publication.sequence };
  const files = new Map(publication.files.map((file) => [file.id, file]));
  const links = new Map<string, string>();
  for (const node of graph.nodes) {
    const file = node.artifactId && files.get(node.artifactId);
    const p = node.provenance as Record<string, unknown> | undefined;
    if (!file || (!p && node.type !== 'Artifact' && node.type !== 'Question')) continue;
    const link = nativeFileRevisionSearch(search, target, file);
    if (link)
      links.set(
        node.id,
        p && p.sourceKind !== 'record-path' ? `${link}#L${p.startLine}-L${p.endLine}` : link,
      );
  }
  return links;
}
