// quorum-edit-apply-start — apply an APPROVED Quorum edit plan (async
// accept-then-background-job, the run-stage-start pattern).
//
// The orchestrator dispatches this after the human approved the plan. The
// background job is DETERMINISTIC control around bounded one-shot rewrites —
// enforcement by construction: only the target document and the approved plan
// items are ever written; the model produces text, never chooses targets.
//
//   1. rewrite the TARGET document per the human's change description
//      (one-shot → full updated markdown) and write it with server-stamped
//      `quorum` edit provenance (shared/artifact-edit.js);
//   2. mark the target's transitive downstream closure stale (drift truth
//      first — anything the plan does not rehabilitate STAYS marked);
//   3. per approved plan item: `update` → one-shot rewrite + provenance
//      (clears its stale marker); `verify-unaffected` → verification stamp
//      (clears its stale marker, keeps the rationale as the note). A failed
//      rewrite leaves the artifact stale and is reported, never retried
//      silently;
//   4. re-derive the graph projection for every rewritten document;
//   5. complete the durable callback with the outcome.

import { closeGraphSource } from '../mcp/graph-writer.js';
import {
  applyArtifactEdit,
  verifyArtifact,
  markArtifactsStale,
  fetchDownstreamClosure,
} from '../../shared/artifact-edit.js';
import { runOneShotPrompt } from '../cli/one-shot.js';
import {
  PLAN_TARGET_DOC_LIMIT,
  REWRITE_DOC_LIMIT,
  bounded,
  stripMarkdownFence,
  checkRewriteStructure,
  structurePreservationRules,
  fetchArtifactForEdit,
  makeProgressEmitter,
} from './quorum-edit-shared.js';

const REWRITE_ONE_SHOT_TIMEOUT_MS = 300_000;

const jobKey = (p) => `${p.executionId}:qedit-apply:${p.editId}`;

// Rewrite the TARGET document per the human's requested change.
// `structureFeedback` carries the guard's findings on a retry — the previous
// answer damaged the machine-parsed structure and the model must fix that.
export const buildTargetRewritePrompt = ({ artifact, changeDescription, structureFeedback }) =>
  [
    'You are Quorum, applying a human-requested change to a project document.',
    'Rewrite the document below applying the requested change. Preserve the document structure, headings, tone and everything not affected by the change.',
    structurePreservationRules(artifact.artifact_type),
    ...(structureFeedback
      ? [
          '',
          `YOUR PREVIOUS ATTEMPT WAS REJECTED because ${structureFeedback}. Produce the FULL document again with that fixed.`,
        ]
      : []),
    'Respond with ONLY the complete updated markdown document — no commentary, no code fences around the whole document.',
    '',
    `Document: "${artifact.title || artifact.id}" (${artifact.artifact_type ?? 'document'})`,
    `Requested change: ${changeDescription}`,
    '',
    '--- CURRENT DOCUMENT ---',
    String(artifact.content ?? ''),
    '--- END DOCUMENT ---',
  ].join('\n');

// Rewrite a DOWNSTREAM document so it stays consistent with the updated
// upstream. The approved plan item's rationale/proposedChange scope the edit.
export const buildDownstreamRewritePrompt = ({
  artifact,
  upstream,
  changeDescription,
  item,
  structureFeedback,
}) =>
  [
    'You are Quorum, propagating an upstream document change into a dependent document.',
    `The upstream document "${upstream.title || upstream.id}" was just changed as follows: ${changeDescription}`,
    `The approved update plan says this document needs: ${item.proposedChange || item.rationale || 'consistency updates for the upstream change'}`,
    'Rewrite the dependent document below so it is consistent with the updated upstream. Change ONLY what the upstream change requires; preserve structure, headings, tone and unaffected content.',
    structurePreservationRules(artifact.artifact_type),
    ...(structureFeedback
      ? [
          '',
          `YOUR PREVIOUS ATTEMPT WAS REJECTED because ${structureFeedback}. Produce the FULL document again with that fixed.`,
        ]
      : []),
    'Respond with ONLY the complete updated markdown document — no commentary, no code fences around the whole document.',
    '',
    '--- UPDATED UPSTREAM DOCUMENT (bounded) ---',
    bounded(upstream.content, PLAN_TARGET_DOC_LIMIT),
    '--- END UPSTREAM ---',
    '',
    `--- DEPENDENT DOCUMENT: "${artifact.title || artifact.id}" (${artifact.artifact_type ?? 'document'}) ---`,
    String(artifact.content ?? ''),
    '--- END DOCUMENT ---',
  ].join('\n');

export const createQuorumEditApplyStart = ({
  openGraph,
  store,
  broadcast = async () => {},
  availableClis = [],
  oneShot = runOneShotPrompt,
  deriveArtifacts = null,
  // Graph collaborators — injectable so the suite exercises the job without a
  // gremlin server (same seam style as derive-artifacts' createWriter).
  fetchArtifact = fetchArtifactForEdit,
  fetchClosure = fetchDownstreamClosure,
  applyEdit = applyArtifactEdit,
  verify = verifyArtifact,
  markStale = markArtifactsStale,
  sendCallbackSuccess,
  sendCallbackHeartbeat = async () => {},
  env = process.env,
  heartbeatIntervalMs = 60_000,
  busy = null,
  activeJobs = new Map(),
  log = (...args) => console.error('[quorum-edit-apply-start]', ...args),
}) => {
  const start = async (payload = {}) => {
    const {
      projectId,
      intentId,
      executionId,
      editId,
      artifactId,
      changeDescription = '',
      approvedArtifactIds = [],
      enrichment = 'off',
      requestedCli = null,
      cliModels = null,
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
        const cliArgs = { requestedCli, cliModels, availableClis, env };
        const recordSpend = async (out) => {
          if (!out?.metrics) return;
          await store
            ?.recordMetric?.({
              executionId,
              stageInstanceId: `qedit-${editId}`,
              metrics: { ...out.metrics, quorumEditCalls: 1 },
              resolvedModel: out.model ?? null,
            })
            .catch(() => {});
        };

        // Guarded rewrite: run the one-shot, then verify the answer did not
        // destroy the machine-parsed structure (checkRewriteStructure — the
        // 2026-07-09 lost-derived-items incident). One corrective retry with
        // the guard's findings; a second failure REFUSES the rewrite so the
        // artifact keeps its intact content (and its stale marker) instead of
        // being overwritten with structural damage.
        const guardedRewrite = async ({ artifact, buildPrompt }) => {
          let structureFeedback = null;
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            const out = await oneShot({
              prompt: buildPrompt(structureFeedback),
              timeoutMs: REWRITE_ONE_SHOT_TIMEOUT_MS,
              ...cliArgs,
            });
            await recordSpend(out);
            const content = out.ok ? stripMarkdownFence(out.text) : '';
            if (!content) return { ok: false, reason: out.reason ?? 'rewrite_failed' };
            const check = checkRewriteStructure({
              artifactType: artifact.artifact_type,
              artifactId: artifact.id,
              before: artifact.content ?? '',
              after: content,
            });
            if (check.ok) return { ok: true, content };
            structureFeedback = check.problems.join('; ');
            log(
              `structure guard rejected rewrite of ${artifact.id} (attempt ${attempt}): ${structureFeedback}`,
            );
            await progress(
              `Rewrite of "${artifact.title || artifact.id}" rejected (${structureFeedback})${attempt === 1 ? ' — retrying with a corrective reminder…' : '.'}`,
            );
          }
          return { ok: false, reason: 'structure_lost', detail: structureFeedback };
        };

        try {
          g = await openGraph();
          const edit = await store?.getQuorumEdit?.(executionId, editId);
          const planItems = edit?.plan?.items ?? [];
          const approvedSet = new Set(approvedArtifactIds);
          const target = await fetchArtifact(g, intentId, artifactId);

          if (!target) {
            result = { ok: false, reason: 'artifact_not_found' };
          } else if (String(target.content ?? '').length > REWRITE_DOC_LIMIT) {
            result = { ok: false, reason: 'content_too_large' };
          } else {
            // 1. Rewrite the target document.
            await progress(`Rewriting "${target.title || artifactId}" per the requested change…`);
            const targetRewrite = await guardedRewrite({
              artifact: target,
              buildPrompt: (structureFeedback) =>
                buildTargetRewritePrompt({
                  artifact: target,
                  changeDescription,
                  structureFeedback,
                }),
            });
            if (!targetRewrite.ok) {
              result = {
                ok: false,
                reason: targetRewrite.reason ?? 'target_rewrite_failed',
                ...(targetRewrite.detail ? { detail: targetRewrite.detail } : {}),
              };
            } else {
              const targetContent = targetRewrite.content;
              await applyEdit({
                g,
                intentId,
                artifactId,
                content: targetContent,
                editedBy: 'quorum',
                editedByName: 'Quorum',
                origin: 'quorum',
                editRef: `qedit:${editId}`,
              });
              await store
                ?.appendEvent?.({
                  executionId,
                  type: 'v2.artifact.edited',
                  actor: 'quorum',
                  summary: `Quorum updated "${target.title || artifactId}" per the approved edit`,
                })
                .catch(() => {});
              await progress('Target document updated. Marking downstream artifacts…');

              // 2. Drift truth first: the WHOLE closure is stale until the
              // plan rehabilitates each member (update/verify below).
              const closure = await fetchClosure({ g, intentId, artifactId });
              await markStale({
                g,
                intentId,
                artifactIds: closure.map((d) => d.id),
                reason: `edit:${artifactId}:${editId}`,
              });

              // 3. Approved plan items. Only sanitized plan items can be
              // approved (the decision endpoint intersects with the plan), and
              // only approved ids are touched here.
              const updated = [];
              const verified = [];
              const failed = [];
              const updatedTarget = { ...target, content: targetContent };
              for (const item of planItems) {
                if (!approvedSet.has(item.artifactId)) continue;
                const row = await fetchArtifact(g, intentId, item.artifactId);
                if (!row) {
                  failed.push({ artifactId: item.artifactId, reason: 'artifact_not_found' });
                  continue;
                }
                if (item.action === 'update') {
                  if (String(row.content ?? '').length > REWRITE_DOC_LIMIT) {
                    failed.push({ artifactId: item.artifactId, reason: 'content_too_large' });
                    continue;
                  }
                  await progress(`Updating "${row.title || item.artifactId}"…`);
                  const rewrite = await guardedRewrite({
                    artifact: row,
                    buildPrompt: (structureFeedback) =>
                      buildDownstreamRewritePrompt({
                        artifact: row,
                        upstream: updatedTarget,
                        changeDescription,
                        item,
                        structureFeedback,
                      }),
                  });
                  if (!rewrite.ok) {
                    // Left stale on purpose — the badge stays honest, and the
                    // intact original content is never overwritten.
                    failed.push({
                      artifactId: item.artifactId,
                      reason: rewrite.reason ?? 'rewrite_failed',
                      ...(rewrite.detail ? { detail: rewrite.detail } : {}),
                    });
                    continue;
                  }
                  const content = rewrite.content;
                  await applyEdit({
                    g,
                    intentId,
                    artifactId: item.artifactId,
                    content,
                    editedBy: 'quorum',
                    editedByName: 'Quorum',
                    origin: 'quorum',
                    editRef: `qedit:${editId}`,
                  });
                  await store
                    ?.appendEvent?.({
                      executionId,
                      type: 'v2.artifact.edited',
                      actor: 'quorum',
                      summary: `Quorum updated "${row.title || item.artifactId}" to follow the upstream edit`,
                    })
                    .catch(() => {});
                  updated.push(item.artifactId);
                } else {
                  // verify-unaffected: reviewed, still valid — clear the marker
                  // and keep Quorum's rationale as the note.
                  await verify({
                    g,
                    intentId,
                    artifactId: item.artifactId,
                    verifiedBy: 'quorum',
                    verifiedByName: 'Quorum',
                    note: item.rationale ?? '',
                  });
                  verified.push(item.artifactId);
                }
              }

              // 4. Re-derive the projection for every rewritten document.
              const rewrittenTypes = [
                ...new Set(
                  [
                    target.artifact_type,
                    ...planItems
                      .filter((i) => updated.includes(i.artifactId))
                      .map((i) => i.artifactType),
                  ].filter(Boolean),
                ),
              ];
              if (deriveArtifacts && rewrittenTypes.length) {
                await progress('Re-deriving the graph projection for the updated documents…');
                try {
                  await deriveArtifacts({
                    projectId,
                    intentId,
                    executionId,
                    artifactTypes: rewrittenTypes,
                    enrichment,
                    requestedCli,
                    cliModels,
                  });
                } catch (err) {
                  log(`derive after apply failed (${key}):`, err?.message ?? err);
                }
              }

              await progress(
                `Done: target updated, ${updated.length} downstream artifact(s) updated, ${verified.length} verified unaffected${failed.length ? `, ${failed.length} left stale (failed)` : ''}.`,
              );
              result = {
                ok: true,
                updatedArtifactIds: updated,
                verifiedArtifactIds: verified,
                failedArtifactIds: failed.map((f) => f.artifactId),
                failures: failed,
              };
            }
          }
        } catch (err) {
          log(`apply job crashed (${key}):`, err?.message ?? err);
          result = { ok: false, reason: 'apply_job_crashed', detail: err?.message ?? String(err) };
        }

        const sent = await sendCallbackSuccess(callbackId, result);
        if (!sent?.delivered) {
          log(`FAILED to deliver apply callback for ${key}:`, sent?.error);
        }
        return result;
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        await closeGraphSource(g);
        activeJobs.delete(key);
        busy?.leave();
      }
    })();
    job.catch((err) => log(`apply job promise rejected unexpectedly (${key}):`, err?.message));

    return { ok: true, accepted: true, editId, callbackId, jobKey: key };
  };
  start.activeJobs = activeJobs;
  return start;
};
