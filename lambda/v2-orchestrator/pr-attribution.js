export const buildIntentAttribution = ({ applicationUrl, projectId, intentId }) => {
  const intentUrl = `${applicationUrl.replace(/\/+$/, '')}/space/${encodeURIComponent(
    projectId,
  )}/intent/${encodeURIComponent(intentId)}`;
  return `[AI-DLC](${intentUrl})`;
};
