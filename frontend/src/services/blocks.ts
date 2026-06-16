import { api } from './api';

// The reusable building-blocks library. Blocks live in a per-tenant catalog
// with a read-only SYSTEM baseline; each is versioned (V#latest + immutable
// snapshots) and may carry a markdown body stored in S3 and fetched lazily.
// Mirrors the backend in lambda/building-blocks. Workflows/artifacts are
// separate concerns and not part of this set.

// The library block types, named to match AI-DLC V2, lowercased for use as
// `/blocks/{type}` path parts. Phases are not a block type (defined inline on a
// workflow); a Stage is the atomic unit, a Sensor a check, a Rule a guardrail,
// an Artifact a named output that wires stages, Knowledge the per-agent corpus.
export const BLOCK_TYPES = [
  'stage',
  'agent',
  'scope',
  'rule',
  'sensor',
  'artifact',
  'knowledge',
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

// Human labels for each type (singular / plural) for headings and tabs.
export const BLOCK_TYPE_LABELS: Record<BlockType, { singular: string; plural: string }> = {
  stage: { singular: 'Stage', plural: 'Stages' },
  agent: { singular: 'Agent', plural: 'Agents' },
  scope: { singular: 'Scope', plural: 'Scopes' },
  rule: { singular: 'Rule', plural: 'Rules' },
  sensor: { singular: 'Sensor', plural: 'Sensors' },
  artifact: { singular: 'Artifact', plural: 'Artifacts' },
  knowledge: { singular: 'Knowledge', plural: 'Knowledge' },
};

// The metadata returned for a block (the body is fetched separately). Block
// types carry extra type-specific attributes, so this is an open shape.
export interface Block {
  id: string;
  blockId: string;
  blockType: string;
  tenantId: string;
  name: string;
  description?: string;
  version: number;
  readOnly: boolean;
  hasBody: boolean;
  bodyBytes: number;
  createdAt: string;
  updatedAt: string;
  // Type-specific attributes (kind, leadAgent, c1_definition, …).
  [key: string]: unknown;
}

// Create/update payload. `id` is required on create (kebab-case); `body`, when
// present, is stored in S3. Extra type-specific attributes pass through.
export interface BlockInput {
  id?: string;
  name: string;
  description?: string;
  body?: string;
  [key: string]: unknown;
}

export const blocksService = {
  list: (type: BlockType) => api.get<{ blocks: Block[] }>(`/blocks/${type}`),
  get: (type: BlockType, id: string) => api.get<Block>(`/blocks/${type}/${id}`),
  getBody: (type: BlockType, id: string) => api.get<{ body: string }>(`/blocks/${type}/${id}/body`),
  create: (type: BlockType, input: BlockInput) => api.post<Block>(`/blocks/${type}`, input),
  update: (type: BlockType, id: string, input: BlockInput) =>
    api.put<Block>(`/blocks/${type}/${id}`, input),
  delete: (type: BlockType, id: string) => api.delete(`/blocks/${type}/${id}`),
};
