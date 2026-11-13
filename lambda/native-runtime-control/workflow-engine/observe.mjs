// A read adapter over the pinned engine's own plan resolution, not another
// scheduler. The host records each emitted gate/check directive separately;
// future conditional gates are not inferred from package defaults here.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const [installation, project] = process.argv.slice(2);
const lib = await import(pathToFileURL(join(installation, 'tools/aidlc-lib.ts')).href);
const graph = await import(pathToFileURL(join(installation, 'tools/aidlc-graph.ts')).href);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const path = lib.stateFilePath(project);
if (!existsSync(path)) {
  console.log(JSON.stringify({ status: 'not_started', effectivePlan: null, audit: [] }));
} else {
  const state = lib.readStateFile(project);
  const session = process.env.AIDLC_SESSION_ID;
  const challenge = session
    ? (lib.readProtectedQuestion(project, session) ??
      lib.readPlanApprovalChallenge(project, session))
    : null;
  const scope = lib.getField(state, 'Scope');
  if (!scope) throw new Error('NATIVE_ENGINE_PLAN_UNAVAILABLE');
  const boxes = lib.parseCheckboxes(state);
  const nodes = graph.loadGraph();
  const stages = nodes.map((node) => ({
    id: node.slug,
    phase: node.phase,
    action: lib.effectivePlanAction(node.slug, scope, state) ?? null,
    state: boxes.find((box) => box.slug === node.slug)?.state ?? null,
    review: {
      role: node.reviewer ?? null,
      class: lib.resolveReviewClass(node.review_class, scope, state),
    },
    sensors: node.sensors_applicable,
  }));
  const missing = stages.filter((stage) => stage.action === null || stage.state === null);
  if (missing.length)
    throw new Error(
      `NATIVE_ENGINE_PLAN_UNAVAILABLE: ${JSON.stringify(missing.map(({ id, action, state }) => ({ id, action, state })))}`,
    );
  const reviews = nodes
    .filter(
      (node) => node.reviewer && lib.resolveReviewClass(node.review_class, scope, state) !== 'none',
    )
    .map((node) => {
      const receipts = lib.freshReviewReceipts(project, state, node);
      return {
        stage: node.slug,
        verdict: receipts.stageVerdict,
        stale: receipts.stageStale || receipts.sourceStale,
        units: [...receipts.unitVerdicts].map(([unit, verdict]) => ({
          unit,
          verdict,
          stale: receipts.unitStale.has(unit),
        })),
        pending:
          Boolean(receipts.stagePending) ||
          receipts.unitPending.size > 0 ||
          receipts.awaitingVerdict.size > 0,
        invalid:
          receipts.unfinishedVerdicts.size > 0 ||
          receipts.editedVerdicts.size > 0 ||
          receipts.dictatedVerdicts.size > 0 ||
          receipts.noReviewerVerdicts.size > 0,
        acceptedChanges: receipts.acceptedChanges.map(
          ({ checkpoint, stage, unit, recorded, current }) => ({
            checkpoint,
            stage,
            unit: unit ?? null,
            recorded,
            current,
          }),
        ),
      };
    });
  const unreadable = [];
  const audit = lib
    .readAuditShardEvents(project, undefined, undefined, unreadable)
    .map((event) => ({
      event: event.event,
      sha256: sha(event.block),
      stage:
        lib.auditBlockField(event.block, 'Stage') ?? lib.auditBlockField(event.block, 'Stage slug'),
      unit: lib.auditBlockField(event.block, 'Unit'),
      at: lib.auditBlockField(event.block, 'Timestamp'),
      messageId: lib.auditBlockField(event.block, 'Message Id'),
      sensor: lib.auditBlockField(event.block, 'Sensor ID'),
      fireId: lib.auditBlockField(event.block, 'Fire id'),
      outputPath: lib.auditBlockField(event.block, 'Output path'),
      note: lib.auditBlockField(event.block, 'Note'),
      reviewer: lib.auditBlockField(event.block, 'Reviewer'),
      result: lib.auditBlockField(event.block, 'Result'),
      verdict: lib.auditBlockField(event.block, 'Verdict'),
      requestId: lib.auditBlockField(event.block, 'Request Id'),
      artifactFingerprint: lib.auditBlockField(event.block, 'Artifact Fingerprint'),
      sourceFingerprint: lib.auditBlockField(event.block, 'Source Fingerprint'),
      reviewFile: lib.auditBlockField(event.block, 'Review File'),
      iteration: lib.auditBlockField(event.block, 'Iteration'),
      userInputSha256:
        (lib.auditBlockField(event.block, 'User Input') ??
          lib.auditBlockField(event.block, 'Details')) === null
          ? null
          : sha(
              lib.auditBlockField(event.block, 'User Input') ??
                lib.auditBlockField(event.block, 'Details'),
            ),
    }));
  if (unreadable.length) throw new Error('NATIVE_ENGINE_AUDIT_UNAVAILABLE');
  console.log(
    JSON.stringify({
      status: 'recorded',
      workflow: {
        status: lib.getField(state, 'Status'),
        currentStage: lib.getField(state, 'Current Stage'),
        recordPath: relative(project, lib.recordDir(project)),
        stateSha256: sha(state),
      },
      effectivePlan: {
        scope,
        // An empty field is an unnamed plan, the same as an absent one.
        name: lib.getField(state, 'Plan') || null,
        stages,
        ceremony: lib.resolveCeremonyPolicy(scope, state),
      },
      gateChoices: (
        await import(pathToFileURL(join(installation, 'tools/aidlc-reply-reader.ts')).href)
      ).APPROVAL_GATE_CHOICES,
      audit,
      reviews,
      protectedQuestion: challenge
        ? {
            challengeId: challenge.challengeId,
            promptDigest: challenge.promptDigest ?? null,
            options: challenge.options,
            targetSha256: sha(JSON.stringify(challenge)),
          }
        : null,
    }),
  );
}
