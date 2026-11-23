// Public, content-free facts from committed execution transitions. This is an
// audit projection written in the SAME transaction, never scheduling authority.
import { nativeUsageSummary } from '../shared/native-activity.js';

const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const elapsed = (start, end) =>
  nonnegative(start) && nonnegative(end) && end >= start ? `${end - start} ms` : 'unavailable';

// Only numeric observations from the identity-checked publication report may
// cross into member history. Old reports can supply timings without usage.
export const nativePublicationMeasurements = (report, configuration) => {
  const { harnessLaunched, firstUsefulOutput, harnessCompleted } = report.timings ?? {};
  const { lastToolMs, lastApiMs, lastUsage, usageSamples } = report.activityMeasurements ?? {};
  const label = { claude: 'result', codex: 'thread-counter delta', opencode: 'step' }[
    configuration.harness
  ];
  return [
    `Harness launch to first useful output: ${elapsed(harnessLaunched, firstUsefulOutput)}`,
    `Harness wall time including tools: ${elapsed(harnessLaunched, harnessCompleted)}`,
    ...(configuration.harness === 'claude'
      ? [`Last result API time: ${nonnegative(lastApiMs) ? `${lastApiMs} ms` : 'unavailable'}`]
      : []),
    `Last reported tool duration: ${nonnegative(lastToolMs) ? `${lastToolMs} ms` : 'unavailable'}`,
    label && nonnegative(usageSamples) && usageSamples > 0
      ? `Latest ${configuration.harness} ${label} sample ${usageSamples} (${configuration.model ?? 'model unavailable'}): ${nativeUsageSummary(lastUsage, configuration.model)}`
      : 'Harness usage unavailable',
  ].join(' · ');
};
const labels = {
  REQUESTED: 'Start accepted',
  UPGRADING: 'Preparing pinned execution runtime',
  DISPATCHING: 'Dispatch queued',
  RUNNING: 'Runtime delivery confirmed',
  RECOVERING: 'Session recovery requested',
  RECOVERY_REQUIRED: 'Session recovery needs attention',
  AWAITING_USER: 'Response published; awaiting a human reply',
  WAITING_FOR_INPUT: 'Files published; workflow waiting for input',
  STOPPED: 'Files published; agent turn stopped (workflow completion unverified)',
  FAILED: 'Execution failed',
  CANCEL_REQUESTED: 'Cancellation accepted; stop pending',
  CANCELLED: 'Cancellation handling finished; inspect retained stop evidence',
};

const transition = (before, row) => {
  if (!before) return ['accepted', labels.REQUESTED];
  if (before.response?.commandId !== row.response?.commandId && row.response)
    return ['answer.accepted', 'Human reply accepted; delivery pending'];
  if (before.publication?.id !== row.publication?.id && row.publication)
    return ['published', labels[row.status]];
  if (!before.dispatch && row.dispatch)
    return ['dispatch.attempted', 'Dispatch attempted; delivery not yet confirmed'];
  if (before.recovery?.phase !== row.recovery?.phase && row.recovery?.phase === 'RESTORING')
    return [
      'recovery.resuming',
      'Predecessor stopped; starting a fresh session on the surviving workspace',
    ];
  if (before.status !== row.status) {
    if (before.status === 'RECOVERING' && row.status === 'RUNNING')
      return [
        'recovery.resumed',
        'Fresh session admitted; earlier answers retained without replay',
      ];
    return [row.status.toLowerCase(), labels[row.status]];
  }
  return null;
};

export const nativeExecutionHistory = (before, row, measurements) => {
  const fact = transition(before, row);
  if (!fact) return null; // Leases, heartbeats and projection bookkeeping are not events.
  const [type, label] = fact;
  const sequence = row.turnSequence;
  const generation = row.writerGeneration;
  const timing = [];
  if (type === 'accepted' || type === 'dispatch.attempted')
    timing.push(
      `Harness: ${row.configuration.harness}`,
      `Pinned model: ${row.configuration.model ?? 'unavailable'}`,
      `Source commit: ${row.sourceCommit ?? 'not yet resolved'}`,
    );
  if (type === 'published') timing.push(`Publication: ${row.publication.id}`);
  if (type === 'dispatch.attempted') {
    const acceptedAt = row.response?.acceptedAt ?? (sequence === 1 ? row.startedAt : null);
    if (acceptedAt !== null)
      timing.push(`Acceptance to dispatch: ${row.dispatch.attemptedAt - acceptedAt} ms`);
  }
  if (type === 'published') {
    const dispatch = before?.dispatch;
    timing.push(
      `Dispatch to publication: ${elapsed(dispatch?.writerGeneration === generation && dispatch.sequence === sequence ? dispatch.attemptedAt : null, row.updatedAt)}`,
    );
    if (measurements) timing.push(measurements);
  }
  const reason = row.failureCode ?? row.recovery?.reason;
  return {
    pk: row.pk,
    sk: `EVENT#${String(row.version).padStart(16, '0')}`,
    schemaVersion: 1,
    revision: row.version,
    eventId: `native-${row.version}`,
    type: `native.${type}`,
    attemptId: row.attemptId,
    turnSequence: sequence,
    writerGeneration: generation,
    ...(type === 'published' ? { publicationId: row.publication.id } : {}),
    ...(type === 'answer.accepted' && before.publication
      ? { replyToPublicationId: before.publication.id, acceptedAt: row.response.acceptedAt }
      : {}),
    stageInstanceId: null,
    actor:
      type === 'accepted'
        ? row.startedBy
        : type === 'answer.accepted'
          ? row.response.actorId
          : null,
    timestamp: new Date(row.updatedAt).toISOString(),
    summary: [
      `Turn ${sequence} · writer ${generation}: ${label}`,
      ...(reason ? [reason] : []),
      ...timing,
    ].join(' · '),
  };
};

export const nativeHistoryView = (row) => ({
  revision: row.revision,
  eventId: row.eventId,
  type: row.type,
  stageInstanceId: null,
  actor: row.actor,
  timestamp: row.timestamp,
  summary: row.summary,
  ...(row.attemptId && row.turnSequence && row.writerGeneration
    ? {
        attemptId: row.attemptId,
        turnSequence: row.turnSequence,
        writerGeneration: row.writerGeneration,
        ...(row.publicationId ? { publicationId: row.publicationId } : {}),
        ...(row.replyToPublicationId
          ? { replyToPublicationId: row.replyToPublicationId, acceptedAt: row.acceptedAt }
          : {}),
      }
    : {}),
});
