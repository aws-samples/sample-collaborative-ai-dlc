const integer = (env, name, fallback, min = 1) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${name}`);
  return value;
};

export const readConfig = (env = process.env) => {
  const config = {
    port: integer(env, 'PORT', 1234, 0),
    maxConnections: integer(env, 'YJS_MAX_CONNECTIONS', 2000),
    maxDocuments: integer(env, 'YJS_MAX_DOCUMENTS', 256),
    maxPayloadBytes: integer(env, 'YJS_MAX_PAYLOAD_BYTES', 10 * 1024 * 1024),
    maxDocumentBytes: integer(env, 'YJS_MAX_DOCUMENT_BYTES', 8 * 1024 * 1024),
    maxBufferedBytes: integer(env, 'YJS_MAX_BUFFERED_BYTES', 16 * 1024 * 1024),
    maxTotalDocumentBytes: integer(env, 'YJS_MAX_TOTAL_DOCUMENT_BYTES', 64 * 1024 * 1024),
    memoryLimitBytes: integer(env, 'YJS_MEMORY_LIMIT_MIB', 1024) * 1024 * 1024,
    maxAwarenessBytes: integer(env, 'YJS_MAX_AWARENESS_BYTES', 16 * 1024),
    heartbeatMs: integer(env, 'YJS_HEARTBEAT_MS', 20_000),
    docTtlMs: integer(env, 'YJS_DOC_TTL_MS', 60_000),
    handshakeMs: integer(env, 'YJS_HANDSHAKE_TIMEOUT_MS', 10_000),
    saveMs: integer(env, 'YJS_SAVE_INTERVAL_MS', 2000),
    shutdownMs: integer(env, 'YJS_SHUTDOWN_TIMEOUT_MS', 90_000),
    clusterEnabled: env.YJS_CLUSTER_ENABLED === 'true',
    metricsNamespace: env.YJS_METRICS_NAMESPACE || 'CollaborativeAI/Yjs',
    serviceName: env.YJS_SERVICE_NAME || 'yjs-server',
  };
  if (config.maxPayloadBytes < config.maxDocumentBytes + 16) {
    throw new Error('YJS_MAX_PAYLOAD_BYTES must accommodate a full document and its framing');
  }
  if (config.maxBufferedBytes < config.maxPayloadBytes) {
    throw new Error('YJS_MAX_BUFFERED_BYTES must accommodate one maximum-size message');
  }
  return config;
};
