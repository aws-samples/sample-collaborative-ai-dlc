// Structured observations, written only by the execution authority in the
// execution CAS transaction. They record transport and publication boundaries,
// never engine application, workflow approval, rejection or completion.
export const answerHistoryKey = (row, interactionId, kind) => ({
  pk: row.pk,
  sk: `ANSWER#${interactionId}#${kind}`,
});

export const nativeAnswerHistory = (before, row) => {
  const response = row.response;
  if (!response || response.commandId !== before?.response?.commandId) return [];
  const facts = [];
  if (before.response.deliveryStatus === 'pending' && response.deliveryStatus === 'delivered')
    facts.push(['delivered', {}]);
  if (
    row.recovery?.reason === 'DELIVERY_UNCERTAIN' &&
    before.recovery?.reason !== 'DELIVERY_UNCERTAIN'
  )
    facts.push(['uncertain', {}]);
  if (
    row.publication?.id !== before.publication?.id &&
    row.publication?.sequence === response.sequence
  )
    facts.push([
      'publication',
      {
        publicationId: row.publication.id,
        publicationSequence: row.publication.sequence,
      },
    ]);
  return facts.map(([kind, details]) => ({
    ...answerHistoryKey(row, response.interactionId, kind),
    schemaVersion: 1,
    scope: row.scope,
    bindingId: row.bindingId,
    attemptId: row.attemptId,
    interactionId: response.interactionId,
    commandId: response.commandId,
    sequence: response.sequence,
    revision: row.version,
    timestamp: row.updatedAt,
    kind,
    ...details,
  }));
};

export const answerObservation = (value, row, response, kind) => {
  if (!value) return null;
  const key = answerHistoryKey(row, response.interactionId, kind);
  if (
    value.pk !== key.pk ||
    value.sk !== key.sk ||
    value.schemaVersion !== 1 ||
    value.scope?.projectId !== row.scope.projectId ||
    value.scope?.executionId !== row.scope.executionId ||
    value.bindingId !== row.bindingId ||
    value.attemptId !== row.attemptId ||
    value.commandId !== response.commandId ||
    value.interactionId !== response.interactionId ||
    value.sequence !== response.sequence ||
    value.kind !== kind ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision > row.version ||
    !Number.isSafeInteger(value.timestamp) ||
    value.timestamp < response.acceptedAt ||
    value.timestamp > row.updatedAt ||
    (kind === 'publication' &&
      (!/^[a-f0-9]{64}$/.test(value.publicationId ?? '') ||
        value.publicationSequence !== response.sequence))
  )
    throw Object.assign(new Error('Native answer history could not be verified'), {
      code: 'NATIVE_EXECUTION_CONFLICT',
    });
  return {
    recordedAt: new Date(value.timestamp).toISOString(),
    ...(kind === 'publication'
      ? {
          publicationId: value.publicationId,
          publicationSequence: value.publicationSequence,
        }
      : {}),
  };
};
