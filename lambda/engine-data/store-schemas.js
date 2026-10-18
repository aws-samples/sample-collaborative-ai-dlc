// Argument schemas for every process-store method engine-data exposes, written
// from the method signatures in lambda/shared/v2-process-store.js.
//
// Each op lists its positional arguments, which of them name the execution, and
// which stage ids address a STAGE# row the call reads or writes. Unknown object
// keys are dropped (zod's default), so a field the store would act on but the
// runtime never sends cannot be smuggled through. `updateExecution` is the one
// strict schema: it can rewrite META, so it accepts only what the runtime sends.
import { z } from 'zod';
import { EXECUTION_STATUS, RECEIPT_KINDS, STAGE_STATE } from '../shared/v2-process-keys.js';

const id = z.string().min(1);
const optionalId = id.nullable().optional();
const text = z.string().nullable().optional();
const json = z.unknown();
const sectionIndex = z.number().int().nonnegative().nullable().optional();
const timestampOrNow = z
  .union([z.literal(true), z.string()])
  .nullable()
  .optional();
const consistentRead = z.object({ consistentRead: z.boolean().optional() }).optional();

// The worker's attempt identity. Rebuilt from these three fields only, so the
// store's ownership fence sees exactly what the dispatch carried.
const ownership = z.object({
  orchestratorRunId: id,
  stageCallbackId: id,
  stageInstanceId: id,
});

// Item keys and index projections decide which partition and which global
// listing a row lands in. No argument may name them; the store derives them.
export const RESERVED_ATTRIBUTES = Object.freeze([
  'pk',
  'sk',
  'GSI1PK',
  'GSI1SK',
  'GSI2PK',
  'GSI2SK',
  'GSI3PK',
  'GSI3SK',
]);

// Field names are interpolated into update-expression placeholders by
// updateQuorumEdit / updateCompose, so only plain attribute identifiers pass.
const fieldName = /^[A-Za-z][A-Za-z0-9_]*$/;
const patchFields = z
  .record(z.unknown())
  .refine((fields) =>
    Object.keys(fields).every((key) => fieldName.test(key) && !RESERVED_ATTRIBUTES.includes(key)),
  )
  .optional();

const lane = { unitSlug: text, sectionIndex };

const op = ({ args, executionId, stageIds = () => [] }) => ({ args, executionId, stageIds });
const first = (args) => args[0];
const inputExecution = (args) => args[0].executionId;
const stageOf = (args) => [args[0].stageInstanceId];
const ownedStage = (input) => (input.ownership ? [input.ownership.stageInstanceId] : []);

export const STORE_OPS = Object.freeze({
  appendEvent: op({
    args: [
      z.object({
        executionId: id,
        type: id,
        stageInstanceId: optionalId,
        ...lane,
        actor: text,
        summary: text,
        payloadRef: json,
        detail: json,
      }),
    ],
    executionId: inputExecution,
  }),
  getStage: op({ args: [id, id, consistentRead], executionId: first }),
  getExecution: op({ args: [id, consistentRead], executionId: first }),
  updateStageState: op({
    args: [
      z.object({
        executionId: id,
        stageInstanceId: id,
        state: z.enum(STAGE_STATE),
        runtimeError: json,
        completedAt: timestampOrNow,
        parkedAt: timestampOrNow,
        cli: text,
        cliSessionId: text,
        resolvedModel: text,
        pendingHumanTaskId: optionalId,
        pendingCodeCommitRefs: json,
        ownership: ownership.nullable().optional(),
      }),
    ],
    executionId: inputExecution,
    stageIds: (args) => [args[0].stageInstanceId, ...ownedStage(args[0])],
  }),
  getHumanTask: op({ args: [id, id, consistentRead], executionId: first }),
  updateExecution: op({
    args: [
      z
        .object({
          executionId: id,
          status: z.enum(EXECUTION_STATUS).optional(),
          currentPhase: text,
          currentStage: text,
          pendingHumanTaskId: optionalId,
          projectType: z.enum(['greenfield', 'brownfield']).optional(),
          // The runtime only ever clears the resume marker; setting one is the
          // control plane's answer path.
          resumeRequired: z.null().optional(),
          ifPendingHumanTaskId: id.optional(),
          ifOrchestratorRunId: id.optional(),
          ifResumeRequiredFor: id.optional(),
          ownership: ownership.nullable().optional(),
        })
        .strict(),
    ],
    executionId: inputExecution,
    stageIds: (args) => ownedStage(args[0]),
  }),
  recordMetric: op({
    args: [
      z.object({
        executionId: id,
        stageInstanceId: optionalId,
        ...lane,
        metrics: z.record(z.unknown()).nullable().optional(),
        resolvedModel: text,
        creditRate: z.number().nullable().optional(),
      }),
    ],
    executionId: inputExecution,
  }),
  recordSensorRun: op({
    args: [
      z.object({
        executionId: id,
        stageInstanceId: id,
        ...lane,
        sensorId: id,
        kind: text,
        severity: text,
        result: id,
        held: z.boolean().optional(),
        detail: json,
      }),
    ],
    executionId: inputExecution,
    stageIds: stageOf,
  }),
  // Creates (or replaces) the stage row, so there is no row to resolve yet; the
  // row it writes is keyed by the grant's execution id.
  putStage: op({
    args: [
      z.object({
        executionId: id,
        stageInstanceId: id,
        stageId: optionalId,
        phase: text,
        state: z.enum(STAGE_STATE).optional(),
        attempt: z.number().int().nonnegative().optional(),
        workerId: text,
        cli: text,
        cliSessionId: text,
        resolvedModel: text,
        stageCallbackId: optionalId,
        pendingCodeCommitRefs: json,
        pendingHumanTaskId: optionalId,
        ...lane,
        aidlcRepoRef: json,
        ownership: ownership.nullable().optional(),
      }),
    ],
    executionId: inputExecution,
  }),
  putReceipt: op({
    args: [
      z.object({
        executionId: id,
        kind: z.enum(RECEIPT_KINDS),
        stageInstanceId: id,
        attempt: z.number().int().nonnegative(),
        ...lane,
        ordinal: z.number().int().nullable().optional(),
        round: z.number().int().nullable().optional(),
        boundDigest: text,
        choice: json,
        decidedBy: text,
        decidedByName: text,
        humanTaskId: optionalId,
        detail: json,
      }),
    ],
    executionId: inputExecution,
    stageIds: stageOf,
  }),
  listReceipts: op({
    args: [
      id,
      z
        .object({
          kind: z.enum(RECEIPT_KINDS).nullable().optional(),
          stageInstanceId: optionalId,
          attempt: z.number().int().nonnegative().nullable().optional(),
          consistentRead: z.boolean().optional(),
        })
        .optional(),
    ],
    executionId: first,
    stageIds: (args) => (args[1]?.stageInstanceId ? [args[1].stageInstanceId] : []),
  }),
  getUnitPlan: op({ args: [id, consistentRead], executionId: first }),
  updateCompose: op({
    args: [
      z.object({
        executionId: id,
        composeId: id,
        state: id.optional(),
        fromStates: z.array(id).nullable().optional(),
        fields: patchFields,
      }),
    ],
    executionId: inputExecution,
  }),
  syncUnitRows: op({
    args: [
      z.object({
        executionId: id,
        units: z.array(
          z.object({
            slug: id.optional(),
            name: id.optional(),
            dependsOn: z.array(id).nullable().optional(),
            depends_on: z.array(id).nullable().optional(),
            kind: text,
          }),
        ),
        batches: z.array(z.array(id)).optional(),
        sectionIndexes: z.array(z.number().int().nonnegative().nullable()).optional(),
      }),
    ],
    executionId: inputExecution,
  }),
  supersedeHumanTask: op({
    args: [
      z.object({
        executionId: id,
        humanTaskId: id,
        supersededBy: text,
        ownership: ownership.nullable().optional(),
      }),
    ],
    executionId: inputExecution,
    stageIds: (args) => ownedStage(args[0]),
  }),
  resumeStageRow: op({
    args: [
      z.object({
        executionId: id,
        stageInstanceId: id,
        cli: text,
        cliSessionId: text,
        resolvedModel: text,
        stageCallbackId: optionalId,
        aidlcRepoRef: json,
        ownership: ownership.nullable().optional(),
      }),
    ],
    executionId: inputExecution,
    stageIds: (args) => [args[0].stageInstanceId, ...ownedStage(args[0])],
  }),
  // The store spreads the checkpoint into the item, so its shape is closed here:
  // exactly what buildWorkflowCheckpoint produces plus the ownership token.
  putWorkflowCheckpoint: op({
    args: [
      z.object({
        type: z.literal('WorkflowCheckpoint').optional(),
        executionId: id,
        checkpointId: id,
        orchestratorRunId: id,
        createdAt: z.string().optional(),
        sourceStageInstanceId: optionalId,
        process: json,
        artifactRefs: z.array(z.unknown()).optional(),
        customRuleRefs: z.array(z.unknown()).optional(),
      }),
    ],
    executionId: inputExecution,
  }),
  putUnitPlan: op({
    args: [
      z.object({
        executionId: id,
        units: z.array(z.unknown()),
        batches: z.array(z.array(id)),
        sourceArtifactId: optionalId,
        producedByStageInstanceId: optionalId,
        skipMatrix: z.record(z.unknown()).nullable().optional(),
        walkingSkeleton: optionalId,
        autonomyMode: text,
        promotedBy: text,
      }),
    ],
    executionId: inputExecution,
  }),
  markSteeringConsumed: op({
    args: [
      z.object({
        executionId: id,
        steerId: id,
        createdAt: id,
        stageInstanceId: optionalId,
      }),
    ],
    executionId: inputExecution,
    stageIds: (args) => (args[0].stageInstanceId ? [args[0].stageInstanceId] : []),
  }),
  markLoopBackArchived: op({
    args: [z.object({ executionId: id, stageInstanceId: id, loopBackId: id })],
    executionId: inputExecution,
    stageIds: stageOf,
  }),
  listSensorRuns: op({
    args: [id, z.object({ stageInstanceId: optionalId }).optional()],
    executionId: first,
    stageIds: (args) => (args[1]?.stageInstanceId ? [args[1].stageInstanceId] : []),
  }),
  listPendingSteering: op({ args: [id], executionId: first }),
  listEvents: op({ args: [id, consistentRead], executionId: first }),
  getExecutionRecords: op({
    args: [id, z.object({ includeOutputs: z.boolean().optional() }).optional()],
    executionId: first,
  }),
  createHumanTask: op({
    args: [
      z.object({
        executionId: id,
        stageInstanceId: optionalId,
        ...lane,
        kind: id,
        prompt: json,
        options: json,
        questions: json,
        skipTargets: json,
        recomposeTargets: json,
        nextStageId: optionalId,
        findings: json,
        detail: json,
        learningsRitual: json,
        loopBackTarget: json,
        loopBackReason: json,
        loopBackStatus: json,
        loopBackNote: json,
        humanTaskId: id.optional(),
        ownership: ownership.nullable().optional(),
        orchestratorRunId: optionalId,
      }),
    ],
    executionId: inputExecution,
    stageIds: (args) => [
      ...(args[0].stageInstanceId ? [args[0].stageInstanceId] : []),
      ...ownedStage(args[0]),
    ],
  }),
  // Exactly the fields init-ws seeds. Identity is checked against the grant by
  // the gateway; an existing row fails inside the store's own condition.
  createExecution: op({
    args: [
      z.object({
        executionId: id,
        projectId: id,
        intentId: id,
        status: z.enum(EXECUTION_STATUS).optional(),
        workflowId: optionalId,
        workflowVersion: z.union([z.number(), z.string()]).nullable().optional(),
        scope: text,
        startedBy: text,
        startedAt: z.string().optional(),
      }),
    ],
    executionId: inputExecution,
  }),
  // Claims (and may create) the stage row, so it cannot be resolved first.
  claimStageAttempt: op({
    args: [
      z.object({
        executionId: id,
        ownership,
        stageId: optionalId,
        phase: text,
      }),
    ],
    executionId: inputExecution,
  }),
  appendOutput: op({
    args: [
      z.object({
        executionId: id,
        stageInstanceId: optionalId,
        ...lane,
        kind: z.string().optional(),
        content: json,
        display: json,
      }),
    ],
    executionId: inputExecution,
  }),
  raiseStageCounter: op({
    args: [
      z.object({
        executionId: id,
        stageInstanceId: id,
        field: id,
        to: z.number().int(),
      }),
    ],
    executionId: inputExecution,
    stageIds: stageOf,
  }),
  getQuorumEdit: op({ args: [id, id], executionId: first }),
  updateQuorumEdit: op({
    args: [
      z.object({
        executionId: id,
        editId: id,
        state: id.optional(),
        fromStates: z.array(id).nullable().optional(),
        fields: patchFields,
      }),
    ],
    executionId: inputExecution,
  }),
  recordGraphRead: op({
    args: [
      z.object({
        executionId: id,
        stageInstanceId: optionalId,
        ...lane,
        tool: id,
        bytes: z.number().nonnegative().optional(),
        resultCount: z.number().int().nullable().optional(),
        args: json,
      }),
    ],
    executionId: inputExecution,
  }),
  setLoopBackRecommendation: op({
    args: [z.object({ executionId: id, stageInstanceId: id, reason: text })],
    executionId: inputExecution,
    stageIds: stageOf,
  }),
  getReceipt: op({
    args: [
      id,
      z.object({
        kind: z.enum(RECEIPT_KINDS),
        stageInstanceId: id,
        attempt: z.number().int().nonnegative(),
        unitSlug: text,
        ordinal: z.number().int().nullable().optional(),
        round: z.number().int().nullable().optional(),
      }),
    ],
    executionId: first,
    stageIds: (args) => [args[1].stageInstanceId],
  }),
});
