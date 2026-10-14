const invalid = () => {
  throw Object.assign(new Error('Invalid native revision query'), {
    code: 'NATIVE_PREPARATION_INVALID',
  });
};
const sequence = (value) => {
  if (!/^[1-9][0-9]{0,15}$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) invalid();
  return Number(value);
};

// Query parameters extend existing GET resources; every other resource retains
// its existing query contract. Reject duplicate, partial and unknown identities.
export const nativeRevisionQuery = (event, kind) => {
  const single = event.queryStringParameters ?? {};
  const multi = event.multiValueQueryStringParameters ?? {};
  if (
    [single, multi].some((map) => typeof map !== 'object' || Array.isArray(map)) ||
    Object.values(single).some((value) => typeof value !== 'string')
  )
    invalid();
  const query = { ...single };
  for (const [key, values] of Object.entries(multi)) {
    if (
      !Array.isArray(values) ||
      values.length !== 1 ||
      typeof values[0] !== 'string' ||
      (single[key] !== undefined && single[key] !== values[0])
    )
      invalid();
    query[key] = values[0];
  }
  if (!Object.keys(query).length) return null;
  if (kind === 'publication' && query.history === '1') {
    if (Object.keys(query).some((key) => !['history', 'beforeSequence'].includes(key))) invalid();
    return {
      history: true,
      before: query.beforeSequence === undefined ? null : sequence(query.beforeSequence),
    };
  }
  const source = query.source === '1' && ['file', 'publication'].includes(kind);
  const evidence = query.evidence === '1' && kind === 'publication' && !source;
  const keys = [
    'publicationId',
    'publicationSequence',
    ...(kind === 'file' ? ['sha256'] : []),
    ...(source ? ['source'] : []),
    ...(evidence ? ['evidence'] : []),
  ];
  if (
    Object.keys(query).length !== keys.length ||
    Object.keys(query).some((key) => !keys.includes(key)) ||
    !/^[a-f0-9]{64}$/.test(query.publicationId ?? '') ||
    (kind === 'file' && !/^[a-f0-9]{64}$/.test(query.sha256 ?? ''))
  )
    invalid();
  return {
    publicationId: query.publicationId,
    publicationSequence: sequence(query.publicationSequence),
    ...(source ? { source: true } : {}),
    ...(evidence ? { evidence: true } : {}),
    ...(kind === 'file' ? { fileId: event.pathParameters.fileId, sha256: query.sha256 } : {}),
  };
};
