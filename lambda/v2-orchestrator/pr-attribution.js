import { buildIntentUrl } from '../shared/intent-url.js';

export const buildIntentAttribution = ({ applicationUrl, projectId, intentId }) => {
  const intentUrl = buildIntentUrl({ applicationUrl, projectId, intentId });
  return `[AI-DLC](${intentUrl})`;
};
