import { useState, useEffect, useCallback } from 'react';
import { timelineEventsService, type TimelineEvent, type CreateTimelineEventInput } from '../services/timelineEvents';
import { realtimeService } from '../services/realtime';

export function useTimeline(sprintId: string) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async () => {
    if (!sprintId) return;
    try {
      const data = await timelineEventsService.list(sprintId);
      setEvents(data);
    } catch {
      // Silently fail — timeline is non-critical
    } finally {
      setLoading(false);
    }
  }, [sprintId]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Listen for real-time timeline events from other collaborators
  useEffect(() => {
    const unsub = realtimeService.on('timeline.event', (data: TimelineEvent) => {
      if (data.sprintId === sprintId) {
        setEvents(prev => [data, ...prev]);
      }
    });
    return unsub;
  }, [sprintId]);

  const addEvent = useCallback(async (input: CreateTimelineEventInput) => {
    if (!sprintId) return;
    try {
      const event = await timelineEventsService.create(sprintId, input);
      setEvents(prev => [event, ...prev]);
    } catch {
      // Non-critical
    }
  }, [sprintId]);

  return { events, loading, addEvent, reload: loadEvents };
}
