import { useState, useEffect, useCallback, useMemo } from 'react'
import { sprintGraphService, type SprintGraph, type GraphNode, type GraphEdge } from '@/services/sprintGraph'

export interface ArtifactNeighbor {
  id: string
  type: string
  label: string
  edgeLabel: string
  direction: 'outgoing' | 'incoming'
}

/**
 * Fetches the sprint graph once and provides helpers
 * to look up relationships for individual artifacts.
 */
export function useSprintGraph(sprintId: string) {
  const [graph, setGraph] = useState<SprintGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!sprintId) return
    setLoading(true)
    setError(null)
    try {
      const data = await sprintGraphService.get(sprintId)
      setGraph(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load graph')
    } finally {
      setLoading(false)
    }
  }, [sprintId])

  useEffect(() => { load() }, [load])

  // Index nodes by ID for fast lookup
  const nodeIndex = useMemo(() => {
    if (!graph) return new Map<string, GraphNode>()
    const map = new Map<string, GraphNode>()
    graph.nodes.forEach(n => map.set(n.id, n))
    return map
  }, [graph])

  // Index edges by source and target for fast neighbor lookup
  const edgesByNode = useMemo(() => {
    if (!graph) return new Map<string, GraphEdge[]>()
    const map = new Map<string, GraphEdge[]>()
    graph.edges.forEach(edge => {
      if (!map.has(edge.source)) map.set(edge.source, [])
      map.get(edge.source)!.push(edge)
      if (!map.has(edge.target)) map.set(edge.target, [])
      map.get(edge.target)!.push(edge)
    })
    return map
  }, [graph])

  /** Get all direct neighbors (both incoming and outgoing edges) for an artifact */
  const getNeighbors = useCallback((artifactId: string): ArtifactNeighbor[] => {
    const edges = edgesByNode.get(artifactId)
    if (!edges) return []

    return edges
      .map(edge => {
        const isSource = edge.source === artifactId
        const neighborId = isSource ? edge.target : edge.source
        const node = nodeIndex.get(neighborId)
        if (!node) return null
        return {
          id: neighborId,
          type: node.type,
          label: node.label,
          edgeLabel: edge.label,
          direction: isSource ? 'outgoing' as const : 'incoming' as const,
        }
      })
      .filter((n): n is ArtifactNeighbor => n !== null)
  }, [edgesByNode, nodeIndex])

  /** Check if an artifact has any relationships */
  const hasRelationships = useCallback((artifactId: string): boolean => {
    return (edgesByNode.get(artifactId)?.length ?? 0) > 0
  }, [edgesByNode])

  return {
    graph,
    loading,
    error,
    reload: load,
    getNeighbors,
    hasRelationships,
    nodeCount: graph?.nodes.length ?? 0,
    edgeCount: graph?.edges.length ?? 0,
  }
}
