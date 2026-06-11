import { api } from './api';

export type TimelineEventType =
  | 'agent_started'
  | 'agent_completed'
  | 'agent_failed'
  | 'question_asked'
  | 'question_answered'
  | 'artifact_created'
  | 'artifact_updated'
  | 'artifact_deleted'
  | 'phase_changed'
  | 'started_over'
  | 'agent_invoked'
  | 'task_reset';

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  title: string;
  detail: string;
  userId: string;
  userName: string;
  timestamp: string;
  sprintId: string;
  /** Links the event to a question (question_asked / question_answered) */
  questionId?: string;
}

export interface CreateTimelineEventInput {
  type: TimelineEventType;
  title: string;
  detail?: string;
  userId?: string;
  userName?: string;
  questionId?: string;
}

export const timelineEventsService = {
  list: (sprintId: string) => api.get<TimelineEvent[]>(`/sprints/${sprintId}/timeline-events`),
  create: (sprintId: string, input: CreateTimelineEventInput) =>
    api.post<TimelineEvent>(`/sprints/${sprintId}/timeline-events`, input),
};
