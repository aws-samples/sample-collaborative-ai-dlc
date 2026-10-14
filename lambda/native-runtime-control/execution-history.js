// Public, content-free facts from committed execution transitions. This is an
// audit projection written in the SAME transaction, never scheduling authority.
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
    return ['recovery.restoring', 'Predecessor stopped; restoring the saved session'];
  if (before.status !== row.status) {
    if (before.status === 'RECOVERING' && row.status === 'DISPATCHING')
      return ['recovery.restored', 'Saved session restored; dispatch queued'];
    return [row.status.toLowerCase(), labels[row.status]];
  }
  return null;
};

export const nativeExecutionHistory = (before, row) => {
  const fact = transition(before, row);
  if (!fact) return null; // Leases, heartbeats and projection bookkeeping are not events.
  const [type, label] = fact;
  const sequence = row.turnSequence ?? 1;
  const generation = row.writerGeneration ?? 1;
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
  if (type === 'published' && before?.dispatch)
    timing.push(`Dispatch to publication: ${row.updatedAt - before.dispatch.attemptedAt} ms`);
  const reason = row.failureCode ?? row.recovery?.reason;
  return {
    pk: row.pk,
    sk: `EVENT#${String(row.version).padStart(16, '0')}`,
    schemaVersion: 1,
    revision: row.version,
    eventId: `native-${row.version}`,
    type: `native.${type}`,
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
});
