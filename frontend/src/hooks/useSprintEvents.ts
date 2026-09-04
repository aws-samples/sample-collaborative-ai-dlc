import { useEffect } from 'react';
import { realtimeService } from '../services/realtime';

export type SprintEventType =
  | 'artifact.created'
  | 'artifact.updated'
  | 'artifact.deleted'
  | 'sprint.phaseChanged'
  | 'agent.question'
  | 'agent.artifacts'
  | 'agent.completed'
  | 'question.answered';

interface SprintEvent {
  action: SprintEventType;
  sprintId?: string;
  artifactType?: string;
  artifactId?: string;
  projectId?: string;
  phase?: string;
}

/**
 * Subscribe to real-time sprint events and trigger a reload callback
 * when artifacts change, the phase changes, a question arrives,
 * or the agent signals new artifacts / completion.
 */
export function useSprintEvents(sprintId: string, onEvent: (event: SprintEvent) => void) {
  useEffect(() => {
    if (!sprintId) return;

    // Connect to sprint-specific channel
    realtimeService
      .connect(`sprint:${sprintId}`)
      .catch((error) => console.error('[WebSocket] Initial sprint connection failed:', error));

    const events: SprintEventType[] = [
      'artifact.created',
      'artifact.updated',
      'artifact.deleted',
      'sprint.phaseChanged',
      'agent.question',
      'agent.artifacts',
      'agent.completed',
      'question.answered',
    ];

    const unsubs = events.map((eventType) =>
      realtimeService.on(eventType, (data: SprintEvent) => {
        // Some agent events don't carry a sprintId — always fire for those
        if (!data.sprintId || data.sprintId === sprintId) onEvent(data);
      }),
    );

    return () => unsubs.forEach((unsub) => unsub());
  }, [sprintId, onEvent]);
}
