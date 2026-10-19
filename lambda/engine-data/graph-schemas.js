// Input schemas and scope rules for every graph operation engine-data serves.
//
// A request carries `args: [selector, input]`. The selector is the scope the
// runtime believes it acts in; the gateway checks it against the grant and
// never spreads it into the writer scope. The input is the operation's own
// strict shape: unknown keys are refused (not dropped), so a property bag can
// never carry ownership, provenance or server-owned fields into a write.
//
// Per-op rules:
//   modes        which grant modes may call it ('engine' = execution/stage/
//                conflict grants, 'discussion' = discussion grants);
//   meta         'required': the execution META must exist and match the grant;
//                'optional': a missing META is accepted, a mismatching one is not;
//   anchor       same choice for the Neptune Intent anchor's project;
//   requireStage the selector must name a stage of the granted execution;
//   stageIds     input stage ids that must each resolve in the execution;
//   unitRefs     input lanes that must exist in the execution's unit plan;
//   quorumEditIds input Quorum edit ids that must belong to the execution;
//   grantModes   when set, the exact grant modes allowed (narrower than modes);
//   replaySafe   whether a stale-auth reconnect may re-run the whole operation.
import { z } from 'zod';
import { LEARNING_LAYERS } from '../shared/mcp/graph-writer.js';
import { CLOSURE_MAX_DEPTH, CLOSURE_MAX_NODES } from '../shared/artifact-edit.js';
import { ITEM_TYPES } from '../shared/engine-graph-ops.js';

const ID_MAX = 512;
const TEXT_MAX = 2000;
// Whole artifact bodies (structure repair, Quorum rewrites, assist replies)
// stay far below the synchronous Invoke payload limit.
export const CONTENT_MAX = 1024 * 1024;
const LIST_MAX = 500;
// Traceability coverage carries at most this many evidence ids per file.
const EVIDENCE_IDS_MAX = 1000;

const id = z.string().min(1).max(ID_MAX);
const text = (max = TEXT_MAX) => z.string().max(max);
const ids = (max = LIST_MAX) => z.array(id).max(max);
const index = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      !path.split('/').includes('..'),
  );
const empty = z.object({}).strict();
const strict = (shape) => z.object(shape).strict();

export const GRAPH_SELECTOR = strict({
  projectId: id.optional(),
  intentId: id.optional(),
  executionId: id.optional(),
  stageInstanceId: id.optional(),
  sectionIndex: index.nullable().optional(),
  unitSlug: id.nullable().optional(),
});

const none = () => [];
const op = ({
  input,
  modes = 'engine',
  meta = 'required',
  anchor = 'required',
  requireStage = false,
  stageIds = none,
  unitRefs = none,
  quorumEditIds = none,
  grantModes = null,
  replaySafe = false,
}) => ({
  input,
  modes,
  meta,
  anchor,
  requireStage,
  stageIds,
  unitRefs,
  quorumEditIds,
  grantModes,
  replaySafe,
});
const read = (input, rules = {}) => op({ input, replaySafe: true, ...rules });

const listing = {
  includeContent: z.boolean().optional(),
  includeSuperseded: z.boolean().optional(),
};

export const GRAPH_OPS = Object.freeze({
  getIntentGraph: read(strict(listing)),
  lookupArtifacts: read(strict({ artifactType: id, ...listing })),
  getArtifactToc: read(strict({ id })),
  getItems: read(
    strict({
      itemType: z.enum(ITEM_TYPES).nullable().optional(),
      artifactType: id.nullable().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
  ),
  getCoverage: read(strict({ unitSlug: id.nullable().optional() })),
  getTeamKnowledge: read(strict({ agentRef: id.nullable().optional() })),
  getLearningRules: read(empty),
  updateArtifact: op({ input: strict({ id, props: strict({ content: text(CONTENT_MAX) }) }) }),
  recordPullRequest: op({
    input: strict({
      repoId: id,
      prUrl: text().nullable().optional(),
      prNumber: z
        .union([text(64), z.number().int()])
        .nullable()
        .optional(),
      branch: text(ID_MAX).nullable().optional(),
      baseBranch: text(ID_MAX).nullable().optional(),
    }),
  }),
  recordUnitPullRequest: op({
    input: strict({
      sectionIndex: index,
      unitSlug: id,
      repoId: id,
      provider: id,
      prUrl: text().nullable().optional(),
      prNumber: z.union([z.string().min(1).max(64), z.number().int()]),
      sourceBranch: text(ID_MAX).nullable().optional(),
      targetBranch: text(ID_MAX).nullable().optional(),
      headSha: text(128).nullable().optional(),
      state: text(64).nullable().optional(),
    }),
    unitRefs: (input) => [{ sectionIndex: input.sectionIndex, unitSlug: input.unitSlug }],
  }),
  recordLearningRule: op({
    input: strict({
      id,
      title: text().optional(),
      content: text(64 * 1024),
      layer: z.enum(LEARNING_LAYERS),
      pairing: text(ID_MAX).optional(),
      props: strict({
        recorded_by: text(ID_MAX).optional(),
        recorded_by_name: text(ID_MAX).optional(),
        recorded_at_stage: text(ID_MAX).optional(),
        source: text(ID_MAX).optional(),
      }).optional(),
    }),
  }),
  linkSteeringInfluences: op({
    input: strict({ steerIds: ids(), stageInstanceId: id.optional() }),
    stageIds: (input) => (input.stageInstanceId ? [input.stageInstanceId] : []),
  }),
  mirrorUnitDag: op({
    input: strict({
      units: z.array(strict({ slug: id, dependsOn: ids() })).max(LIST_MAX),
      sourceArtifactId: id.nullable().optional(),
    }).refine((input) => {
      const slugs = new Set(input.units.map((unit) => unit.slug));
      return input.units.every((unit) => unit.dependsOn.every((dep) => slugs.has(dep)));
    }),
  }),
  ingestCodeFiles: op({
    input: strict({
      repository: id,
      commitRef: id,
      stageInstanceId: id.nullable().optional(),
      unitSlug: id.nullable().optional(),
      files: z
        .array(
          strict({
            filePath: relativePath,
            fileKind: z
              .enum(['implementation', 'test', 'configuration', 'documentation'])
              .optional(),
            traceabilitySource: z.enum(['git', 'aidlc-traceability']).optional(),
            summary: text().optional(),
            evidenceIds: z.array(id).max(EVIDENCE_IDS_MAX).optional(),
          }),
        )
        .max(5000),
    }),
    stageIds: (input) => (input.stageInstanceId ? [input.stageInstanceId] : []),
  }),
  mirrorArtifactDerivations: op({ input: strict({ artifactId: id, sourceHash: sha256 }) }),
  resolveDerivedItemEdges: op({ input: empty }),
  applyArtifactEnrichment: op({
    input: strict({
      artifactId: id,
      gist: text(),
      claims: z.array(text()).max(5),
      model: text(ID_MAX).nullable().optional(),
      sourceHash: sha256,
    }),
  }),
  supersedeDerivationsForArtifacts: op({ input: strict({ artifactIds: ids() }) }),
  recordContributionGap: op({
    input: strict({ agentRef: id, reason: text() }),
    requireStage: true,
  }),

  ensureIntent: op({
    input: strict({ title: text().optional() }),
    meta: 'optional',
    anchor: 'optional',
    grantModes: ['execution'],
  }),
  inspect: read(
    strict({ artifactType: id.nullable().optional(), artifactId: id.nullable().optional() }),
    {
      meta: 'optional',
    },
  ),
  readProjectCliConfig: read(empty, { modes: 'both', meta: 'optional' }),
  readDiscussionContext: read(
    strict({ discussionId: id, messageId: id, selectedMessageIds: ids(100).optional() }),
    { modes: 'discussion', meta: 'optional' },
  ),
  completeDiscussionAssist: op({
    input: strict({
      discussionId: id,
      messageId: id,
      requestId: id,
      content: text(64 * 1024),
      status: z.enum(['completed', 'failed']),
    }),
    modes: 'discussion',
    meta: 'optional',
  }),
  getArtifactForEdit: read(strict({ artifactId: id })),
  fetchDownstreamClosure: read(
    strict({
      artifactId: id,
      maxDepth: z.number().int().positive().max(CLOSURE_MAX_DEPTH).optional(),
      maxNodes: z.number().int().positive().max(CLOSURE_MAX_NODES).optional(),
    }),
  ),
  applyArtifactEdit: op({
    input: strict({
      artifactId: id,
      editId: id,
      content: text(CONTENT_MAX),
      ifEditRevision: id.nullable().optional(),
      ifCollaborationEpoch: id.nullable().optional(),
    }),
    quorumEditIds: (input) => [input.editId],
  }),
  verifyArtifact: op({ input: strict({ artifactId: id, note: text().optional() }) }),
  markArtifactsStale: op({
    input: strict({ sourceArtifactId: id, artifactIds: ids(CLOSURE_MAX_NODES), editId: id }),
    quorumEditIds: (input) => [input.editId],
  }),
  archiveArtifactsForStages: op({
    input: strict({
      stageInstanceIds: ids(),
      restartId: id,
      reason: text(),
      actor: text(ID_MAX),
    }),
    stageIds: (input) => input.stageInstanceIds,
  }),
  snapshotCurrentArtifactHeads: op({ input: empty }),
  readCurrentArtifactHeadHashes: read(empty),
});
