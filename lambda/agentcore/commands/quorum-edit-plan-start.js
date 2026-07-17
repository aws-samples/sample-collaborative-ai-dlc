// quorum-edit-plan-start — Quorum's impact analysis for a requested document
// edit (async accept-then-background-job, the run-stage-start pattern).
//
// The orchestrator dispatches this with a durable `callbackId`. The command
// accepts in milliseconds, then a background job:
//   1. loads the target artifact + its transitive downstream closure
//      (shared/artifact-edit.js — the same evidence the impact endpoint and
//      the simple-edit warning use),
//   2. runs ONE bounded one-shot CLI prompt (the Quorum persona, no tools —
//      the discussion-assist inference path) asking for a structured
//      per-artifact update plan,
//   3. sanitizes the plan against the ACTUAL closure (fabricated ids dropped,
//      skipped artifacts appended as explicitly-unassessed verify items),
//   4. persists the plan on the QEDIT row and completes the callback.
//
// EVERY termination completes the callback (success, failure, crash) — the
// orchestrator must never deadlock on a dead job; heartbeats distinguish
// "slow model" from "dead container".

import { closeGraphSource } from '../mcp/graph-writer.js';
import { fetchDownstreamClosure } from '../../shared/artifact-edit.js';
import { runOneShotPrompt, extractJsonObject } from '../cli/one-shot.js';
import { quorumCliModels } from '../model-resolver.js';
import {
  PLAN_CONTEXT_DOC_LIMIT,
  PLAN_TARGET_DOC_LIMIT,
  bounded,
  sanitizePlan,
  fetchArtifactForEdit,
  makeProgressEmitter,
} from './quorum-edit-shared.js';

const PLAN_ONE_SHOT_TIMEOUT_MS = 300_000;

const jobKey = (p) => `${p.executionId}:qedit-plan:${p.editId}`;

export const buildPlanPrompt = ({ artifact, changeDescription, downstream, requestedByName }) => {
  const lines = [
    'You are Quorum, a collaboration-oriented assistant coordinating a post-hoc edit of project documents.',
    'A human wants to change ONE document. Documents downstream of it (derived from it, consuming it, or citing it) may drift out of sync.',
    'Assess EACH downstream artifact: does it need an update to stay consistent with the requested change, or does it remain valid as-is?',
    '',
    'Respond with ONLY a JSON object, no prose, in this exact shape:',
    '{"summary": "<1-3 sentences on the overall impact>", "items": [{"artifactId": "<id>", "action": "update" | "verify-unaffected", "rationale": "<why, one or two sentences>", "proposedChange": "<what would change, short>"}]}',
    'Rules: every artifactId MUST be one of the downstream artifact ids listed below. Include every downstream artifact exactly once. No markdown, no code fences.',
    '',
    `Requested by: ${requestedByName || 'unknown'}`,
    `Requested change to "${artifact.title || artifact.id}" (${artifact.artifact_type ?? 'document'}):`,
    changeDescription,
    '',
    '--- TARGET DOCUMENT (current content) ---',
    bounded(artifact.content, PLAN_TARGET_DOC_LIMIT),
    '--- END TARGET DOCUMENT ---',
    '',
    `Downstream artifacts (${downstream.length}):`,
  ];
  for (const d of downstream) {
    lines.push(
      '',
      `- artifactId: ${d.id}`,
      `  type: ${d.artifactType ?? 'unknown'} · title: ${d.title ?? d.id} · relation: ${(d.via ?? []).join(', ')} · depth: ${d.depth}`,
      `  content (bounded):`,
      bounded(d.content ?? '', PLAN_CONTEXT_DOC_LIMIT),
    );
  }
  if (downstream.length === 0) {
    lines.push('(none — the change affects only the target document)');
  }
  return lines.join('\n');
};

export const createQuorumEditPlanStart = ({
  openGraph,
  store,
  broadcast = async () => {},
  availableClis = [],
  oneShot = runOneShotPrompt,
  // Graph collaborators — injectable so the suite exercises the job without a
  // gremlin server (same seam style as derive-artifacts' createWriter).
  fetchClosure = fetchDownstreamClosure,
  fetchArtifact = fetchArtifactForEdit,
  sendCallbackSuccess,
  sendCallbackHeartbeat = async () => {},
  env = process.env,
  heartbeatIntervalMs = 60_000,
  busy = null,
  activeJobs = new Map(),
  log = (...args) => console.error('[quorum-edit-plan-start]', ...args),
}) => {
  const start = async (payload = {}) => {
    const {
      projectId,
      intentId,
      executionId,
      editId,
      artifactId,
      changeDescription = '',
      requestedByName = '',
      requestedCli = null,
      cliModels = null,
      tierModels = null,
      callbackId,
    } = payload;
    if (!callbackId) return { ok: false, reason: 'missing_callback_id' };
    if (!projectId || !intentId || !executionId || !editId || !artifactId) {
      return { ok: false, reason: 'missing_quorum_edit_identity' };
    }
    const key = jobKey(payload);
    const inFlight = activeJobs.get(key);
    if (inFlight) {
      if (inFlight.callbackId === callbackId) {
        return { ok: true, accepted: true, alreadyRunning: true, editId, callbackId };
      }
      return { ok: false, reason: 'job_already_running', detail: key };
    }
    activeJobs.set(key, { startedAt: Date.now(), callbackId });
    busy?.enter();

    const job = (async () => {
      let heartbeatTimer = null;
      let g;
      let result;
      try {
        heartbeatTimer = setInterval(() => {
          sendCallbackHeartbeat(callbackId).catch(() => {});
        }, heartbeatIntervalMs);
        heartbeatTimer.unref?.();

        const progress = makeProgressEmitter({
          store,
          broadcast,
          executionId,
          intentId,
          projectId,
          editId,
        });
        try {
          g = await openGraph();
          const artifact = await fetchArtifact(g, intentId, artifactId);
          if (!artifact) {
            result = { ok: false, reason: 'artifact_not_found' };
          } else {
            await progress(
              `Analyzing downstream impact of editing "${artifact.title || artifactId}"…`,
            );
            const closure = await fetchClosure({ g, intentId, artifactId });
            // The plan prompt needs each downstream doc's content (bounded).
            const downstream = [];
            for (const d of closure) {
              const row = await fetchArtifact(g, intentId, d.id);
              downstream.push({ ...d, content: row?.content ?? '' });
            }
            await progress(
              `Found ${downstream.length} downstream artifact(s) — asking Quorum for an update plan…`,
            );
            const prompt = buildPlanPrompt({
              artifact,
              changeDescription,
              downstream,
              requestedByName,
            });
            const out = await oneShot({
              prompt,
              requestedCli,
              // Quorum-effective map: quorum row > flat selection > fallback.
              cliModels: quorumCliModels({ cliModels, tierModels }),
              availableClis,
              env,
              timeoutMs: PLAN_ONE_SHOT_TIMEOUT_MS,
            });
            if (out.metrics) {
              await store
                ?.recordMetric?.({
                  executionId,
                  stageInstanceId: `qedit-${editId}`,
                  metrics: { ...out.metrics, quorumEditCalls: 1 },
                  resolvedModel: out.model ?? null,
                })
                .catch(() => {});
            }
            if (!out.ok) {
              result = { ok: false, reason: out.reason ?? 'plan_cli_failed' };
            } else {
              const parsed = extractJsonObject(out.text);
              if (!parsed) {
                result = { ok: false, reason: 'plan_unparseable' };
              } else {
                const plan = sanitizePlan({ parsed, downstream });
                // Persist the plan on the row too (fields-only patch — the
                // AWAITING_APPROVAL transition belongs to the orchestrator).
                await store
                  ?.updateQuorumEdit?.({ executionId, editId, fields: { plan } })
                  .catch(() => {});
                await progress(
                  `Plan ready: ${plan.items.filter((i) => i.action === 'update').length} artifact(s) to update, ${plan.items.filter((i) => i.action !== 'update').length} judged unaffected.`,
                );
                result = { ok: true, plan };
              }
            }
          }
        } catch (err) {
          log(`plan job crashed (${key}):`, err?.message ?? err);
          result = { ok: false, reason: 'plan_job_crashed', detail: err?.message ?? String(err) };
        }

        const sent = await sendCallbackSuccess(callbackId, result);
        if (!sent?.delivered) {
          log(`FAILED to deliver plan callback for ${key}:`, sent?.error);
        }
        return result;
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        await closeGraphSource(g);
        activeJobs.delete(key);
        busy?.leave();
      }
    })();
    job.catch((err) => log(`plan job promise rejected unexpectedly (${key}):`, err?.message));

    return { ok: true, accepted: true, editId, callbackId, jobKey: key };
  };
  start.activeJobs = activeJobs;
  return start;
};
