import type { AgentAuthProviderUi, AgentAuthSummaryLine } from './contract';

const humanize = (key: string) => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// Fallback for modes without a provider summary. Only string fields are listed;
// structured values need the provider's own summarize.
export const genericSummary = (
  configuration: Readonly<Record<string, unknown>>,
): AgentAuthSummaryLine[] =>
  Object.entries(configuration).flatMap(([key, value]) =>
    typeof value === 'string' && value !== '' ? [{ label: humanize(key), value }] : [],
  );

export const summarizeConfiguration = (
  ui: AgentAuthProviderUi | undefined,
  configuration: Readonly<Record<string, unknown>>,
) => (ui?.summarize ? ui.summarize(configuration) : genericSummary(configuration));
