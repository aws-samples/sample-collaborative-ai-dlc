import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../services/intents', () => ({
  intentsService: { graph: vi.fn() },
}));

import { intentsService, type IntentKnowledgeGraph } from '../services/intents';
import { useIntentGraph, invalidateIntentGraph } from './useIntentGraph';

const graphMock = vi.mocked(intentsService.graph);

const GRAPH: IntentKnowledgeGraph = {
  nodes: [
    { id: 'intent-1', type: 'Intent', label: 'Improve dashboard' },
    { id: 'art-stories', type: 'Artifact', label: 'Stories', artifactType: 'stories' },
    { id: 'art-reqs', type: 'Artifact', label: 'Requirements', artifactType: 'requirements' },
    {
      id: 'story:intent-1:s-login',
      type: 'Story',
      label: 'Login',
      graphLayer: 'derived',
      slug: 's-login',
      artifactId: 'art-stories',
    },
    {
      id: 'requirement:intent-1:req-auth',
      type: 'Requirement',
      label: 'Auth',
      graphLayer: 'derived',
      slug: 'req-auth',
      artifactId: 'art-reqs',
    },
    {
      id: 'unit:intent-1:u-auth',
      type: 'UnitOfWork',
      label: 'u-auth',
      graphLayer: 'derived',
      slug: 'u-auth',
    },
  ],
  edges: [
    { source: 'intent-1', target: 'art-stories', label: 'CONTAINS' },
    { source: 'art-stories', target: 'story:intent-1:s-login', label: 'HAS_ITEM' },
    {
      source: 'story:intent-1:s-login',
      target: 'requirement:intent-1:req-auth',
      label: 'COVERS',
    },
  ],
};

// Unique ids per test so the module-level cache never bleeds between tests.
let seq = 0;
const freshIds = () => {
  seq += 1;
  return { projectId: `p-${seq}`, intentId: `i-${seq}` };
};

beforeEach(() => {
  graphMock.mockReset();
  graphMock.mockResolvedValue(GRAPH);
});

describe('useIntentGraph', () => {
  it('fetches once and exposes neighbors in both directions', async () => {
    const { projectId, intentId } = freshIds();
    const { result } = renderHook(() => useIntentGraph(projectId, intentId));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const storyNeighbors = result.current.getNeighbors('story:intent-1:s-login');
    expect(storyNeighbors).toEqual([
      expect.objectContaining({
        id: 'art-stories',
        type: 'Artifact',
        edgeLabel: 'HAS_ITEM',
        direction: 'incoming',
      }),
      expect.objectContaining({
        id: 'requirement:intent-1:req-auth',
        type: 'Requirement',
        edgeLabel: 'COVERS',
        direction: 'outgoing',
        graphLayer: 'derived',
      }),
    ]);
    expect(result.current.getNeighbors('nope')).toEqual([]);
    expect(graphMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent consumers into one network fetch (in-flight sharing)', async () => {
    const { projectId, intentId } = freshIds();
    const a = renderHook(() => useIntentGraph(projectId, intentId));
    const b = renderHook(() => useIntentGraph(projectId, intentId));
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(graphMock).toHaveBeenCalledTimes(1);
    expect(b.result.current.nodes).toHaveLength(6);
  });

  it('joins derived items to their source artifact and excludes units from derivedItems', async () => {
    const { projectId, intentId } = freshIds();
    const { result } = renderHook(() => useIntentGraph(projectId, intentId));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.derivedItems.map((i) => i.id)).toEqual([
      'story:intent-1:s-login',
      'requirement:intent-1:req-auth',
    ]);
    expect(result.current.itemsByArtifact.get('art-stories')?.map((i) => i.slug)).toEqual([
      's-login',
    ]);
    expect(result.current.itemsByArtifact.has('unit:intent-1:u-auth')).toBe(false);
  });

  it('invalidateIntentGraph triggers a refetch (the agent.derived realtime path)', async () => {
    const { projectId, intentId } = freshIds();
    const { result } = renderHook(() => useIntentGraph(projectId, intentId));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(graphMock).toHaveBeenCalledTimes(1);

    graphMock.mockResolvedValue({
      nodes: [...GRAPH.nodes, { id: 'art-new', type: 'Artifact', label: 'New' }],
      edges: GRAPH.edges,
    });
    act(() => invalidateIntentGraph(projectId, intentId));
    await waitFor(() => expect(result.current.nodes).toHaveLength(7));
    expect(graphMock).toHaveBeenCalledTimes(2);
  });

  it('reports an error without breaking the view contract', async () => {
    const { projectId, intentId } = freshIds();
    graphMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useIntentGraph(projectId, intentId));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to load knowledge graph');
    expect(result.current.nodes).toEqual([]);
    expect(result.current.getNeighbors('x')).toEqual([]);
  });
});
