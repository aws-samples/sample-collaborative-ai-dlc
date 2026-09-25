// record-learning — write a human-authored learning into the project's rule
// stack, from the approval gate.
//
// Invoked by the orchestrator (durable step) when an `approve` answer carries a
// non-empty `learnings` text — the stage learnings ritual, which rides
// the existing validation gate instead of adding a second human turn per stage.
// The write itself is exactly the one `record_learning_rule` performs for an
// agent; the orchestrator cannot perform it because it has no Neptune access, and
// the container is the only VPC-attached component on this path (the same reason
// `record-pr` exists).
//
// A human learning always lands on the `project-learnings` layer: an ORG or TEAM
// guardrail is a deliberate, wider-scoped act, and silently promoting one stage's
// note to a cross-project rule would be a surprise the gate never asked about.
//
// The id is derived from the stage instance and the content so a replayed durable
// step upserts the same vertex instead of accumulating near-duplicates.
//
// Returns values, never throws for expected conditions:
//   { ok: true, id, layer }                          — the rule was written
//   { ok: false, reason: 'missing_input' }            — no identity / empty text
//   { ok: false, reason: 'record_failed', detail }    — infra error

import { createHash } from 'node:crypto';
import { createGraphWriter, closeGraphSource } from '../mcp/graph-writer.js';

const LEARNING_LAYER = 'project-learnings';
const MAX_TITLE = 80;
const MAX_CONTENT = 4000;

const learningId = ({ stageId, stageInstanceId, content }) =>
  `gate-learning-${String(stageId ?? stageInstanceId ?? 'stage')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}-${createHash('sha256')
    .update(`${stageInstanceId ?? ''}\u0000${content}`)
    .digest('hex')
    .slice(0, 12)}`;

// The first sentence (or the first line), clipped — a title is a handle, and the
// full text is already the content.
const learningTitle = (content) => {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim()) ?? content;
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const trimmed = sentence.trim();
  return trimmed.length > MAX_TITLE ? `${trimmed.slice(0, MAX_TITLE - 1)}…` : trimmed;
};

export const recordLearning = async (payload, deps) => {
  const {
    projectId,
    intentId,
    executionId,
    stageInstanceId = null,
    stageId = null,
    unitSlug = null,
    sectionIndex = null,
    learnings,
    recordedBy = null,
    recordedByName = null,
  } = payload ?? {};
  const {
    store,
    openGraph,
    broadcast = async () => {},
    createWriter = createGraphWriter,
  } = deps ?? {};

  const content = String(learnings ?? '')
    .trim()
    .slice(0, MAX_CONTENT);
  if (!projectId || !intentId || !executionId || !content) {
    return { ok: false, reason: 'missing_input' };
  }

  const id = learningId({ stageId, stageInstanceId, content });
  let g;
  try {
    g = await openGraph();
    const graph = createWriter({
      g,
      scope: { projectId, intentId, executionId, stageInstanceId },
    });
    const written = await graph.recordLearningRule({
      id,
      title: learningTitle(content),
      content,
      layer: LEARNING_LAYER,
      props: {
        ...(recordedBy ? { recorded_by: recordedBy } : {}),
        ...(recordedByName ? { recorded_by_name: recordedByName } : {}),
        ...(stageId ? { recorded_at_stage: stageId } : {}),
        source: 'gate-learnings-ritual',
      },
    });
    await store
      ?.appendEvent?.({
        executionId,
        type: 'v2.learning.recorded',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: recordedByName ?? recordedBy ?? 'human',
        summary: `${recordedByName || 'Someone'} recorded a learning at the ${stageId ?? 'stage'} gate: ${learningTitle(content)}`,
        detail: { id, layer: written?.layer ?? LEARNING_LAYER },
      })
      .catch(() => {});
    await broadcast({
      executionId,
      intentId,
      projectId,
      action: 'agent.note',
      stageInstanceId,
      unitSlug,
      sectionIndex,
      kind: 'learning',
      note: `learning recorded: ${learningTitle(content)}`,
    }).catch(() => {});
    return { ok: true, id, layer: written?.layer ?? LEARNING_LAYER };
  } catch (e) {
    // The ritual must NEVER fail the run: the stage is already approved and the
    // human's decision stands. The failure becomes a loud timeline event so the
    // lost learning is visible instead of silently dropped.
    await store
      ?.appendEvent?.({
        executionId,
        type: 'v2.learning.record_failed',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `Learning offered at the ${stageId ?? 'stage'} gate could not be recorded: ${e.message}`,
        detail: { id },
      })
      .catch(() => {});
    return { ok: false, reason: 'record_failed', detail: e.message };
  } finally {
    await closeGraphSource(g);
  }
};

export const __test = { learningId, learningTitle };
