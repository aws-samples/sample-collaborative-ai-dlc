import { useEffect } from 'react';
import { realtimeService } from '../services/realtime';

// V2 intent realtime events broadcast by the AgentCore runtime on the
// `intent:<intentId>` channel (see lambda/agentcore/clients.js + v2-agent.md).
export type IntentEventAction =
  | 'agent.workspace'
  | 'agent.execution'
  | 'agent.stage'
  | 'agent.output'
  | 'agent.question'
  | 'agent.metric'
  | 'agent.steering'
  | 'agent.note'
  // Unit-lane lifecycle (docs/v2-parallel.md WP4): v2.unit.* transitions
  // (started / merged / failed) broadcast by the orchestrator.
  | 'agent.unit'
  | 'agent.unit-pr'
  | 'agent.feedback'
  // A derive run completed — the knowledge graph's derived layer changed
  // (sections/items/edges; docs/v2-granular-graph.md).
  | 'agent.derived'
  // The fan-in PR(s) were recorded in the graph — a new work product + node.
  | 'agent.pr'
  | 'intent.attachments';

export interface IntentEvent {
  action: IntentEventAction;
  executionId?: string;
  intentId?: string;
  projectId?: string;
  stageInstanceId?: string;
  stageId?: string;
  // Unit lane attribution (docs/v2-parallel.md WP4): present on stage/output/
  // question/metric/note events from a unit lane, and on agent.unit itself.
  unitSlug?: string | null;
  sectionIndex?: number | null;
  phase?: string;
  state?: string;
  status?: string;
  currentPhase?: string;
  currentStage?: string;
  // agent.output
  seq?: number;
  kind?: string;
  content?: string;
  timestamp?: string;
  display?: {
    type: 'message' | 'tool' | 'edit' | 'batch_read' | 'artifact' | 'question' | 'system' | 'raw';
    level?: string;
    title?: string;
    summary?: string;
    details?: string;
    hiddenByDefault?: boolean;
  };
  // agent.question
  humanTaskId?: string;
  questions?: unknown;
  prompt?: string | null;
  options?: unknown;
  // agent.metric
  metricId?: string;
  metrics?: Record<string, number>;
  // agent.steering (course corrections delivered to the agent)
  steerIds?: string[];
  // agent.note
  eventId?: string;
  noteType?: string;
  summary?: string;
  note?: string;
}

const INTENT_EVENTS: IntentEventAction[] = [
  'agent.workspace',
  'agent.execution',
  'agent.stage',
  'agent.output',
  'agent.question',
  'agent.metric',
  'agent.steering',
  'agent.note',
  'agent.unit',
  'agent.unit-pr',
  'agent.feedback',
  'agent.derived',
  'agent.pr',
  'intent.attachments',
];

/**
 * Subscribe to an intent's realtime channel and forward every agent.* event to
 * `onEvent`. The channel is `intent:<intentId>`; the token endpoint is
 * project-scoped, so the projectId is supplied explicitly for the scope target.
 *
 * D3 (multiple pending gates): this hook does NOT collapse questions — it
 * forwards each `agent.question` as it arrives. The consumer is responsible for
 * accumulating them into a list keyed by `humanTaskId` (upsert, never replace),
 * since a stage run can leave more than one pending HUMAN# gate.
 */
export function useIntentEvents(
  projectId: string,
  intentId: string,
  onEvent: (event: IntentEvent) => void,
) {
  useEffect(() => {
    if (!projectId || !intentId) return;

    realtimeService
      .connect(`intent:${intentId}`, { intentId, projectId })
      .catch((error) => console.error('[WebSocket] Initial intent connection failed:', error));

    const unsubs = INTENT_EVENTS.map((action) =>
      realtimeService.on(action, (data: IntentEvent) => {
        // Some events may omit intentId; fire for those, else match.
        if (!data.intentId || data.intentId === intentId) onEvent({ ...data, action });
      }),
    );

    return () => unsubs.forEach((unsub) => unsub());
  }, [projectId, intentId, onEvent]);
}
