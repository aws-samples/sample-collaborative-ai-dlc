import { api } from './api';

// The reusable building-blocks library. The backend key calls the owner a
// tenant, but the product model is simpler: SYSTEM is the read-only imported
// baseline, and default is the shared user-created/forked catalog. Each block is
// versioned (V#latest + immutable snapshots) and may carry a markdown body
// stored in S3 and fetched lazily.
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
  'skill',
  'template',
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
  skill: { singular: 'Skill', plural: 'Skills' },
  template: { singular: 'Template', plural: 'Templates' },
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
  // A SENSOR's executable check rides in scriptRef, separate from its body.
  hasScript: boolean;
  scriptBytes: number;
  createdAt: string;
  updatedAt: string;
  // Type-specific attributes (leadAgent, produces, sensors, reviewer, …).
  [key: string]: unknown;
}

// Create/update payload. `id` is required on create (kebab-case); `body`, when
// present, is stored in S3. Extra type-specific attributes pass through.
export interface BlockInput {
  id?: string;
  name: string;
  description?: string;
  body?: string;
  // Optional executable script (SENSOR check). Stored in S3, separate from body.
  script?: string;
  [key: string]: unknown;
}

export const blocksService = {
  list: (type: BlockType) => api.get<{ blocks: Block[] }>(`/blocks/${type}`),
  get: (type: BlockType, id: string) => api.get<Block>(`/blocks/${type}/${id}`),
  getBody: (type: BlockType, id: string) => api.get<{ body: string }>(`/blocks/${type}/${id}/body`),
  getScript: (type: BlockType, id: string) =>
    api.get<{ script: string }>(`/blocks/${type}/${id}/script`),
  create: (type: BlockType, input: BlockInput) => api.post<Block>(`/blocks/${type}`, input),
  update: (type: BlockType, id: string, input: BlockInput) =>
    api.put<Block>(`/blocks/${type}/${id}`, input),
  delete: (type: BlockType, id: string) => api.delete(`/blocks/${type}/${id}`),
};
