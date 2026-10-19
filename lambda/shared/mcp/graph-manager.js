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

// A socket the server or network already dropped: the cached source is dead and
// the next call must open a new one.
export const isGraphConnectionError = (err) =>
  /websocket is not open|connection (?:closed|reset|refused)|socket hang up|econnreset|econnrefused|epipe|not connected|closed websocket/i.test(
    errorText(err),
  );

export const createGraphManager = ({
  openGraph,
  createWriter,
  closeGraphSource,
  scope,
  now = () => Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  isRetryable = isRetryableGraphAuthError,
  isConnectionLost = isGraphConnectionError,
} = {}) => {
  if (!openGraph) throw new Error('createGraphManager requires openGraph');
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

  const ensureGraph = async ({ force = false } = {}) => {
    if (force || (g && maxAgeMs > 0 && now() - openedAt >= maxAgeMs)) {
      await closeCurrent();
    }
    if (g) return g;
    if (!opening) {
      opening = (async () => {
        const nextG = await openGraph();
        g = nextG;
        openedAt = now();
        return nextG;
      })().finally(() => {
        opening = null;
      });
    }
    return opening;
  };

  const ensureWriter = async (options) => {
    const source = await ensureGraph(options);
    if (!writer) {
      if (!createWriter) throw new Error('createGraphManager requires createWriter');
      writer = createWriter({ g: source, scope });
    }
    return writer;
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

  // The connection alone, for a caller that builds its own scoped objects per
  // call (engine-data builds a writer from each request's verified grant, so no
  // scope survives between requests). An auth rejection or a dropped socket
  // invalidates the connection; the call itself is replayed only when the
  // caller says replaying it is safe, since a mutation that failed mid-way may
  // already have partly applied.
  const withGraph = async (fn, { retryAuth = false } = {}) => {
    try {
      return await fn(await ensureGraph());
    } catch (err) {
      const authRejected = isRetryable(err);
      if (!authRejected && !isConnectionLost(err)) throw err;
      await closeCurrent();
      if (!authRejected || !retryAuth) throw err;
      return fn(await ensureGraph({ force: true }));
    }
  };

  return { withWriter, withGraph, close: closeCurrent };
};
