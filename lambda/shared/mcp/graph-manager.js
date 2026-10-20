// Owns the MCP server's Neptune connection lifecycle. The MCP child can stay
// alive while an agent thinks for several minutes; Neptune SigV4 WebSocket
// headers are signed at connection creation, so reconnect before they go stale
// and retry once if the server rejects an expired signature anyway.

const DEFAULT_MAX_AGE_MS = 4 * 60 * 1000;

const errorText = (err, seen = new Set()) => {
  if (!err || seen.has(err)) return '';
  seen.add(err);
  const parts = [err.name, err.message, err.code, err.statusCode, err.status, err.stack];
  if (err.$metadata?.httpStatusCode) parts.push(String(err.$metadata.httpStatusCode));
  if (err.cause) parts.push(errorText(err.cause, seen));
  return parts.filter(Boolean).join('\n');
};

export const isRetryableGraphAuthError = (err) => {
  if (err?.name === 'GraphWriteError') return false;
  const text = errorText(err);
  return (
    /\b403\b|forbidden|unexpected server response/i.test(text) &&
    /signature|sigv4|x-amz-date|expired|request time|current time|too large|forbidden/i.test(text)
  );
};

export const createGraphManager = ({
  openGraph,
  createWriter,
  closeGraphSource,
  scope,
  now = () => Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  isRetryable = isRetryableGraphAuthError,
} = {}) => {
  if (!openGraph) throw new Error('createGraphManager requires openGraph');
  if (!createWriter) throw new Error('createGraphManager requires createWriter');
  if (!closeGraphSource) throw new Error('createGraphManager requires closeGraphSource');

  let g = null;
  let writer = null;
  let openedAt = 0;
  let opening = null;

  const closeCurrent = async () => {
    const current = g;
    g = null;
    writer = null;
    openedAt = 0;
    if (current) await closeGraphSource(current);
  };

  const ensureWriter = async ({ force = false } = {}) => {
    if (force || (g && maxAgeMs > 0 && now() - openedAt >= maxAgeMs)) {
      await closeCurrent();
    }
    if (writer) return writer;
    if (!opening) {
      opening = (async () => {
        const nextG = await openGraph();
        g = nextG;
        openedAt = now();
        writer = createWriter({ g: nextG, scope });
        return writer;
      })().finally(() => {
        opening = null;
      });
    }
    return opening;
  };

  const withWriter = async (fn) => {
    try {
      return await fn(await ensureWriter());
    } catch (err) {
      if (!isRetryable(err)) throw err;
      await closeCurrent();
      return fn(await ensureWriter({ force: true }));
    }
  };

  return { withWriter, close: closeCurrent };
};
