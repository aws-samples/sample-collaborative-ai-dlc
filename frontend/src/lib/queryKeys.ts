import type { QueryKey } from '@tanstack/react-query';

type Part = string | number | boolean | null;

const norm = (value: Part | undefined): Part =>
  value === undefined || value === '' ? null : value;

export interface CompiledRequest {
  version?: number | null;
  releaseId?: string | null;
  importerRevision?: number | null;
  intent?: { projectId: string; intentId: string } | null;
  libraryRelease?: string | null;
}

// Keys are hierarchical tuples so `invalidate(prefix)` reaches every view of
// an entity: invalidate(['intent', p, i]) covers detail, graph and audit.
// Request-shaped keys carry every parameter the service sends, normalized the
// way the service does (workflowsService.compiled, trackersService.listIssues),
// so two different requests can never share an entry.
export const qk = {
  projects: () => ['projects'] as const,
  agentsSettings: () => ['agents', 'settings'] as const,
  projectIntents: (projectId: string) => ['project', projectId, 'intents'] as const,
  intentDetail: (projectId: string, intentId: string) =>
    ['intent', projectId, intentId, 'detail'] as const,
  compiled: (workflowId: string, request: CompiledRequest) => {
    // The service drops version 0 and only sends the importer revision with a release.
    const releaseId = norm(request.releaseId);
    return [
      'workflow',
      workflowId,
      'compiled',
      request.version ? request.version : null,
      releaseId,
      releaseId === null ? null : norm(request.importerRevision),
      request.intent?.projectId ?? null,
      request.intent?.intentId ?? null,
      norm(request.libraryRelease),
    ] as const;
  },
  // --- authoring (workflows, blocks, discussions) ---
  // ['workflows'] is the list; one workflow's views stay under ['workflow', id]
  // and one block type's list and items under ['blocks', type].
  workflows: () => ['workflows'] as const,
  // The service drops version 0 the same way as for compiled views.
  workflowDetail: (workflowId: string, version?: number | null) =>
    ['workflow', workflowId, 'detail', version ? version : null] as const,
  // --- end authoring ---
  // --- settings (admin, space and account settings; factories in lib/settingsQueries.ts) ---
  // Space-scoped views stay under ['project', id] so deleting a space reaches them.
  projectCredentials: (projectId: string) => ['project', projectId, 'agent-credentials'] as const,
  personalCredentials: () => ['me', 'agent-credentials'] as const,
  // --- end settings ---
} satisfies Record<string, (...args: never[]) => QueryKey>;
