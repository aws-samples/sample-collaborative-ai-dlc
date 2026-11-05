import type {
  AgentAuthAction,
  AgentAuthImpactReview,
  AgentAuthModeView,
  AgentCredentialSource,
} from '@/services/agents';
import { ApiError } from '@/services/api';
import { agentAuthProviderUi } from './registry';
import { summarizeConfiguration } from './summary';

// Plain-language reading of a server impact review. The server classifies each
// piece of work it found (see lambda/shared/agent-auth-changes.js); the browser
// only decides what to say and whether a person has to confirm.

/** Outcomes where work that already started can stop or cannot be checked. */
export const AFFECTING_OUTCOMES = ['loses-access', 'repair', 'unknown'] as const;
export type AffectingOutcome = (typeof AFFECTING_OUTCOMES)[number];

const NEXT_START = 'next-start';

export const outcomeCount = (review: AgentAuthImpactReview, outcome: string) =>
  review.counts[outcome] ?? 0;

/**
 * True when the preview found nothing that has already started: every listed
 * item only picks up the change the next time an agent starts. Unrecognised
 * outcomes count as impact, so a newer server never gets auto-applied by mistake.
 */
export const reviewHasNoImpact = (review: AgentAuthImpactReview) =>
  Object.entries(review.counts).every(([outcome, count]) => outcome === NEXT_START || !count) &&
  review.items.every((item) => item.outcome === NEXT_START);

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const tasks = (count: number) => `${count} agent ${plural(count, 'task', 'tasks')}`;

/** One sentence and one suggested action per kind of affected work. */
export const affectingMessage = (outcome: AffectingOutcome, count: number) => {
  const it = plural(count, 'it', 'they');
  const finishes = plural(count, 'it finishes', 'they finish');
  switch (outcome) {
    case 'loses-access':
      return {
        text: `${tasks(count)} will lose access the next time ${it} ${plural(count, 'needs', 'need')} this key.`,
        action: `To avoid this, keep the current key until ${finishes}.`,
      };
    case 'repair':
      return {
        text: `${tasks(count)} cannot continue until ${plural(count, 'its', 'their')} connection is reconnected.`,
        action: 'A platform administrator needs to reconnect it.',
      };
    case 'unknown':
      return {
        text: `We could not check whether ${tasks(count)} will be affected.`,
        action: `If ${it} might still be running, wait until ${finishes} before you continue.`,
      };
  }
};

export const continuingMessage = (count: number) =>
  `${tasks(count)} that already started ${plural(count, 'keeps', 'keep')} working.`;

export const NOT_AFFECTED_MESSAGE = 'Agents that are running now are not affected.';
export const APPLIES_AT_NEXT_START = 'This applies the next time an agent starts.';

const KEY_NAMES: Record<string, string> = {
  bedrock: 'Bedrock API key',
  bedrockBearerToken: 'Bedrock API key',
  kiro: 'Kiro API key',
  kiroApiKey: 'Kiro API key',
};

/** What a key change does for whoever runs agents, in the future tense. */
export const credentialChangeEffect = (
  source: AgentCredentialSource,
  provider: string,
  action: 'rotate' | 'clear',
) => {
  const key = KEY_NAMES[provider] ?? `${provider} key`;
  if (source === 'user')
    return action === 'clear'
      ? `Your agent runs will use the space or platform ${key} instead of yours.`
      : `Your agent runs in every space will use this ${key}.`;
  if (source === 'space')
    return action === 'clear'
      ? `Agent runs in this space will use members' own keys or the platform ${key}.`
      : `Agent runs in this space will use this ${key}, unless a member has set their own.`;
  return action === 'clear'
    ? `Only people or spaces with their own ${key} will be able to run these agents.`
    : `Agent runs will use this ${key}, unless a person or space has set their own.`;
};

/** The change itself, described for a confirmation. */
export const describeCandidate = (
  candidate: AgentAuthAction | undefined,
  modes?: readonly AgentAuthModeView[],
): { lines: string[]; details: { label: string; value: string }[] } => {
  if (!candidate) return { lines: [], details: [] };
  switch (candidate.kind) {
    case 'credential-update':
      return {
        lines: candidate.changes.map((change) =>
          credentialChangeEffect(candidate.source, change.provider, change.action),
        ),
        details: [],
      };
    case 'connection-create': {
      const { connection } = candidate;
      const ui = agentAuthProviderUi(connection.mode);
      const noun = ui?.noun ?? 'connection';
      return {
        lines: [
          connection.source === 'space'
            ? `Agents in this space will use this ${noun}.`
            : `Agents will use this ${noun}, unless a space has its own.`,
        ],
        details: summarizeConfiguration(ui, connection.configuration),
      };
    }
    case 'space-selection':
      return {
        lines:
          candidate.connectionId === null
            ? ['Agents in this space will use the platform connection again.']
            : [],
        details: [],
      };
    case 'policy-change': {
      const label = modes?.find((mode) => mode.id === candidate.mode)?.label ?? candidate.mode;
      return { lines: [`Agents will switch to ${label}.`], details: [] };
    }
  }
};

/** Key-save error codes a person can act on without knowing the review protocol. */
export const authChangeErrorMessage = (error: unknown, fallback: string) => {
  const code = error instanceof ApiError ? error.body?.code : undefined;
  // The card hides the Bedrock key outside Keys mode, so this means the mode
  // changed after the page loaded.
  if (code === 'AGENT_AUTH_MODE_MISMATCH')
    return "Your administrators now manage Bedrock access, so a Bedrock key can't be used. Reload the page to see the current setup.";
  if (code === 'AGENT_AUTH_REVIEW_STALE')
    return 'Something changed while saving, so nothing was saved. Please try again.';
  if (code === 'AGENT_AUTH_CHANGE_IN_PROGRESS')
    return 'Another change is still being finished. Please try again in a moment.';
  return error instanceof Error ? error.message : fallback;
};

export const isStaleReviewError = (error: unknown) =>
  error instanceof ApiError && error.body?.code === 'AGENT_AUTH_REVIEW_STALE';
