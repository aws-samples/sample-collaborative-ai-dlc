import { api } from './api';

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  label: string;
}

export interface SprintGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const sprintGraphService = {
  get: (sprintId: string) => api.get<SprintGraph>(`/sprints/${sprintId}/graph`),
};
