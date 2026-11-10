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

const NEXT_START = 'next-start';
const CONTINUES = 'continues';

type ImpactItem = AgentAuthImpactReview['items'][number];
type Message = { key: string; text: string; action?: string };

// Inventory records that are setup, not work. Every other type, including ones
// a newer server adds, is read as work that already started.
const KIND_BY_TYPE: Record<string, 'connection' | 'environment'> = {
  AgentConnectionHead: 'connection',
  EnvironmentRevision: 'environment',
};
type Kind = 'work' | 'connection' | 'environment' | 'summary';
const kindOf = (item: ImpactItem): Kind => KIND_BY_TYPE[item.type] ?? 'work';

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const NOUNS: Record<Kind, [string, string]> = {
  work: ['agent task', 'agent tasks'],
  connection: ['shared connection', 'shared connections'],
  environment: ['published runtime environment', 'published runtime environments'],
  // Counts without item details (a resumed review) cannot say what they are.
  summary: ['item', 'items'],
};
const counted = (kind: Kind, count: number) => `${count} ${plural(count, ...NOUNS[kind])}`;

const cannotTell = (key: string, kind: Kind, count: number): Message => ({
  key,
  text: `We could not tell how this change affects ${counted(kind, count)}.`,
  action: 'Continue only if you are sure this is safe.',
});

// One plain sentence, and what to do, per kind of record and server outcome.
const warningFor = (kind: Kind, outcome: string, count: number): Message => {
  const key = `${kind}:${outcome}`;
  const it = plural(count, 'it', 'they');
  const finishes = plural(count, 'it finishes', 'they finish');
  if (kind === 'connection')
    return outcome === 'repair'
      ? {
          key,
          text: `${counted(kind, count)} ${plural(count, 'needs', 'need')} reconnecting by an administrator.`,
          action: `Agents that use ${it} cannot start until then.`,
        }
      : cannotTell(key, kind, count);
  if (kind === 'environment')
    return outcome === 'unknown'
      ? {
          key,
          text: `${counted(kind, count)} ${plural(count, 'has', 'have')} not confirmed support for this change.`,
          action: 'An administrator should publish and verify a compatible environment.',
        }
      : cannotTell(key, kind, count);
  switch (outcome) {
    case 'loses-access':
      return {
        key,
        text: `${counted(kind, count)} will lose access the next time ${it} ${plural(count, 'needs', 'need')} this key.`,
        action: `To avoid this, keep the current key until ${finishes}.`,
      };
    case 'repair':
      return {
        key,
        text: `${counted(kind, count)} cannot continue until ${plural(count, 'its', 'their')} connection is reconnected.`,
        action: 'A platform administrator needs to reconnect it.',
      };
    case 'unknown':
      return {
        key,
        text: `We could not check whether ${counted(kind, count)} will be affected.`,
        action: `If ${it} might still be running, wait until ${finishes} before you continue.`,
      };
    default:
      return cannotTell(key, kind, count);
  }
};

/**
 * The one reading of a review that decides both what the confirmation says and
 * whether a key save needs one. Setup records (shared connections, runtime
 * environments) that keep working are not started work; every other outcome
 * except next-start, recognised or not, is.
 */
export const summarizeImpact = (review: AgentAuthImpactReview) => {
  const groups = new Map<string, { kind: Kind; outcome: string; count: number }>();
  const add = (kind: Kind, outcome: string, count: number) => {
    const key = `${kind}:${outcome}`;
    const group = groups.get(key) ?? { kind, outcome, count: 0 };
    group.count += count;
    groups.set(key, group);
  };
  for (const item of review.items)
    if (item.outcome !== NEXT_START) add(kindOf(item), item.outcome, 1);
  // Counts the items do not explain stay conservative.
  for (const [outcome, count] of Object.entries(review.counts)) {
    const listed = review.items.filter((item) => item.outcome === outcome).length;
    if (outcome !== NEXT_START && count > listed) add('summary', outcome, count - listed);
  }
  const warnings: Message[] = [];
  const notes: Message[] = [];
  const warned = new Set<Kind>();
  for (const { kind, outcome, count } of groups.values()) {
    if (outcome !== CONTINUES) {
      warnings.push(warningFor(kind, outcome, count));
      warned.add(kind);
    } else if (kind === 'work' || kind === 'summary')
      notes.push({
        key: `${kind}:${outcome}`,
        text: `${counted(kind, count)} that already started ${plural(count, 'keeps', 'keep')} working.`,
      });
  }
  // Name only what the warnings are about: started work, records of unknown kind,
  // or shared setup (connections, published environments) alone.
  const heading = warned.has('work')
    ? 'Some work that already started may be affected'
    : warned.has('summary')
      ? 'Some existing work or setup may be affected'
      : warned.size > 0
        ? 'Some shared setup may need attention'
        : null;
  return {
    warnings,
    notes,
    heading,
    needsConfirmation: warnings.length > 0 || notes.length > 0,
  };
};

/** True when nothing that already started is affected, so a key save needs no confirmation. */
export const reviewHasNoImpact = (review: AgentAuthImpactReview) =>
  !summarizeImpact(review).needsConfirmation;

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
