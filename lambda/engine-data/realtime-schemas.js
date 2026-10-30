// The live event DTO engine-data broadcasts on an intent's realtime channel.
//
// The action set is closed and each action accepts exactly the top-level
// fields its runtime producers send today (run-stage, lanes, composer,
// discussion assist, the process bridge, ...); an unknown action or field is
// refused, not forwarded. Nested values (questions, PR rows, the compose row,
// the discussion message) keep their producer shapes and are bounded by the
// encoded event size instead. Ownership ids are checked against the grant by
// the gateway, never trusted from here.
import { z } from 'zod';

const ID_MAX = 512;
const LABEL_MAX = 256;

// One encoded event, small enough for a websocket frame and far below the
// Invoke limit; producers already chunk long output.
export const MAX_EVENT_BYTES = 32 * 1024;

const id = z.string().min(1).max(ID_MAX);
const label = z.string().max(LABEL_MAX);
const count = z.number().int().nonnegative();
const json = z.unknown();

const ownership = {
  projectId: id.optional(),
  intentId: id.optional(),
  executionId: id.optional(),
  sprintId: id.optional(),
};

const lane = {
  stageInstanceId: id.nullish(),
  unitSlug: id.nullish(),
  sectionIndex: count.nullish(),
};

const action = (name, fields) =>
  z.object({ action: z.literal(name), ...ownership, ...fields }).strict();

export const REALTIME_EVENT = z.discriminatedUnion('action', [
  action('agent.workspace', {
    ...lane,
    state: label.nullish(),
    repos: z.array(json).nullish(),
    summary: z.string().nullish(),
  }),
  action('agent.unit', {
    unitSlug: id.nullish(),
    sectionIndex: count.nullish(),
    state: label.nullish(),
    unitBranch: z.string().max(ID_MAX).nullish(),
  }),
  action('agent.units', { unitCount: count.nullish(), state: label.nullish() }),
  action('agent.stage', {
    ...lane,
    stageId: id.nullish(),
    phase: label.nullish(),
    state: label.nullish(),
    reason: z.string().nullish(),
  }),
  action('agent.note', {
    ...lane,
    noteType: label.nullish(),
    summary: z.string().nullish(),
    note: z.string().nullish(),
    kind: label.nullish(),
    sensorRunId: id.nullish(),
    eventId: id.nullish(),
  }),
  action('agent.steering', {
    stageInstanceId: id.nullish(),
    state: label.nullish(),
    steerIds: z.array(id).nullish(),
  }),
  action('agent.question', { ...lane, humanTaskId: id.nullish(), questions: json }),
  action('agent.execution', {
    status: label.nullish(),
    currentPhase: label.nullish(),
    currentStage: id.nullish(),
  }),
  action('agent.metric', {
    ...lane,
    metricId: id.nullish(),
    metrics: z.record(z.string().max(LABEL_MAX), json).nullish(),
  }),
  action('agent.output', {
    ...lane,
    seq: count.nullish(),
    kind: label.nullish(),
    content: z.string().nullish(),
    timestamp: label.nullish(),
    display: json,
  }),
  action('agent.pr', { prs: z.array(json).nullish() }),
  action('agent.unit-pr', { unitPrs: z.array(json).nullish() }),
  action('agent.derived', {
    artifactCount: count.nullish(),
    sectionCount: count.nullish(),
    itemCount: count.nullish(),
  }),
  action('compose.updated', { compose: z.object({}).passthrough() }),
  action('discussion.message', {
    discussionId: id,
    message: z.object({ id }).passthrough(),
  }),
]);

export const REALTIME_OPS = Object.freeze({
  broadcastIntent: z.object({ payload: REALTIME_EVENT }).strict(),
});
