// Client-side view over the intent knowledge graph (GET .../intents/{id}/graph)
// — the v2 port of v1's useSprintGraph. One module-level SWR cache is shared
// by every consumer (workbench popovers, the derived-items section, and the
// graph page), with in-flight dedup so a page full of artifact cards causes
// exactly one network fetch. `invalidateIntentGraph` is the refresh signal —
// IntentContext calls it on the `agent.derived` realtime broadcast, so the
// derived layer updates moments after a stage's derive completes.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { intentsService, type IntentGraphEdge, type IntentGraphNode } from '@/services/intents';

const CACHE_MAX = 20;

interface GraphEntry {
  nodes: IntentGraphNode[];
  edges: IntentGraphEdge[];
}

const cache = new Map<string, GraphEntry>();
const versions = new Map<string, number>();
const inflight = new Map<string, Promise<GraphEntry>>();
const listeners = new Set<() => void>();

const cacheKey = (projectId: string, intentId: string) => `${projectId}#${intentId}`;

function trimCache() {
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }
}

// Bump the version for one intent's graph — every mounted hook refetches.
// Safe to call from anywhere (realtime handlers, manual reload buttons).
export function invalidateIntentGraph(projectId: string, intentId: string): void {
  const k = cacheKey(projectId, intentId);
  versions.set(k, (versions.get(k) ?? 0) + 1);
  listeners.forEach((l) => l());
}

function fetchGraph(projectId: string, intentId: string): Promise<GraphEntry> {
  const k = cacheKey(projectId, intentId);
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = intentsService
    .graph(projectId, intentId)
    .then(({ nodes, edges }) => {
      cache.set(k, { nodes, edges });
      trimCache();
      return { nodes, edges };
    })
    .finally(() => {
      inflight.delete(k);
    });
  inflight.set(k, p);
  return p;
}

// One neighbor of a node — both directions, with the humanizable edge label.
export interface GraphNeighbor {
  id: string;
  type: string;
  label: string;
  edgeLabel: string;
  direction: 'outgoing' | 'incoming';
  graphLayer?: 'derived';
}

export interface IntentGraphView {
  nodes: IntentGraphNode[];
  edges: IntentGraphEdge[];
  loading: boolean;
  error: string | null;
  /** Neighbors of a node id (empty array for unknown ids). */
  getNeighbors: (id: string) => GraphNeighbor[];
  /** Current derived typed items (graphLayer='derived', excl. units). */
  derivedItems: IntentGraphNode[];
  /** Derived items joined to their source artifact (node.artifactId). */
  itemsByArtifact: Map<string, IntentGraphNode[]>;
  reload: () => void;
}

const EMPTY: GraphEntry = { nodes: [], edges: [] };

export function useIntentGraph(projectId: string, intentId: string): IntentGraphView {
  const k = cacheKey(projectId, intentId);
  const [entry, setEntry] = useState<GraphEntry | null>(() => cache.get(k) ?? null);
  const [loading, setLoading] = useState(() => !cache.get(k));
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(() => versions.get(k) ?? 0);

  // Subscribe to invalidations (version bumps re-run the fetch effect).
  useEffect(() => {
    const listener = () => setVersion(versions.get(k) ?? 0);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [k]);

  useEffect(() => {
    if (!projectId || !intentId) return;
    let cancelled = false;
    const hit = cache.get(k);
    if (hit) {
      setEntry(hit);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    fetchGraph(projectId, intentId)
      .then((fresh) => {
        if (!cancelled) setEntry(fresh);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load knowledge graph');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [k, projectId, intentId, version]);

  const { nodes, edges } = entry ?? EMPTY;

  // Adjacency index: edges under BOTH endpoints, nodes by id.
  const { nodeIndex, edgesByNode } = useMemo(() => {
    const nodeIdx = new Map<string, IntentGraphNode>(nodes.map((n) => [n.id, n]));
    const byNode = new Map<string, IntentGraphEdge[]>();
    for (const e of edges) {
      for (const end of [e.source, e.target]) {
        if (!byNode.has(end)) byNode.set(end, []);
        byNode.get(end)!.push(e);
      }
    }
    return { nodeIndex: nodeIdx, edgesByNode: byNode };
  }, [nodes, edges]);

  const getNeighbors = useCallback(
    (id: string): GraphNeighbor[] => {
      const out: GraphNeighbor[] = [];
      for (const e of edgesByNode.get(id) ?? []) {
        const neighborId = e.source === id ? e.target : e.source;
        // Self-loops would duplicate under both endpoints.
        if (neighborId === id) continue;
        const node = nodeIndex.get(neighborId);
        if (!node) continue;
        out.push({
          id: node.id,
          type: node.type,
          label: node.label,
          edgeLabel: e.label,
          direction: e.source === id ? 'outgoing' : 'incoming',
          ...(node.graphLayer === 'derived' ? { graphLayer: 'derived' as const } : {}),
        });
      }
      return out;
    },
    [nodeIndex, edgesByNode],
  );

  const derivedItems = useMemo(
    () => nodes.filter((n) => n.graphLayer === 'derived' && n.type !== 'UnitOfWork'),
    [nodes],
  );

  const itemsByArtifact = useMemo(() => {
    const map = new Map<string, IntentGraphNode[]>();
    for (const item of derivedItems) {
      if (!item.artifactId) continue;
      if (!map.has(item.artifactId)) map.set(item.artifactId, []);
      map.get(item.artifactId)!.push(item);
    }
    return map;
  }, [derivedItems]);

  const reload = useCallback(() => {
    invalidateIntentGraph(projectId, intentId);
  }, [projectId, intentId]);

  return { nodes, edges, loading, error, getNeighbors, derivedItems, itemsByArtifact, reload };
}
