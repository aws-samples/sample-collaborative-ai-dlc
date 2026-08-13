const buildIntentUrl = ({ applicationUrl, projectId, intentId }) =>
  `${String(applicationUrl || '').replace(/\/+$/, '')}/space/${encodeURIComponent(
    projectId,
  )}/intent/${encodeURIComponent(intentId)}`;

export { buildIntentUrl };
