/**
 * WebSocket event wiring for observability — extracted to keep useObservability lean.
 */
import { useEffect, useRef } from 'react';
import { realtimeService } from '../../services/realtime';
import { L2Intelligence, type StuckDetection } from './l2Intelligence';
import type { LastToolMap, PendingQuestionsMap, ProjectAgentInfo } from '@/hooks/useObservability';

interface Callbacks {
  addEvent: (type: string, data: Record<string, unknown>) => void;
  clearStuck: (sprintId: string) => void;
  markBlocked: (sprintId: string, projectName: string) => void;
  setLastToolMap: React.Dispatch<React.SetStateAction<LastToolMap>>;
  setPendingQuestions: React.Dispatch<React.SetStateAction<PendingQuestionsMap>>;
  setStuckDetections: React.Dispatch<React.SetStateAction<StuckDetection[]>>;
  refreshProjects: () => void;
  projectsRef: React.RefObject<ProjectAgentInfo[]>;
  l2: React.RefObject<L2Intelligence>;
  /** ID of the most recently active sprint — used to connect WebSocket */
  activeSprintId: string | null;
}

export function useObservabilityEvents(cb: Callbacks) {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  // Connect to the active sprint's WebSocket channel so we receive real-time events.
  // realtimeService is a process-wide singleton shared with the sprint pages
  // (useSprintEvents / ActivityPanel / useAgentStatus). We must NOT disconnect on
  // unmount: that would tear down a socket a sprint page may have just (re)opened
  // on the same documentId. The singleton's connect() already closes the previous
  // socket when a consumer connects to a different documentId.
  useEffect(() => {
    if (!cb.activeSprintId) return;
    realtimeService
      .connect(`sprint:${cb.activeSprintId}`)
      .catch((error) =>
        console.error('[WebSocket] Initial observability connection failed:', error),
      );
  }, [cb.activeSprintId]);

  // Register event handlers once on mount. All callbacks accessed via cbRef to avoid stale closures.
  useEffect(() => {
    const {
      addEvent,
      clearStuck,
      markBlocked,
      setLastToolMap,
      setPendingQuestions,
      setStuckDetections,
      refreshProjects,
      projectsRef,
      l2,
    } = cbRef.current;

    const unsubs = [
      realtimeService.on('agent.started', (d) => {
        addEvent('agent.started', d);
        if (d.sprintId) clearStuck(d.sprintId as string);
        refreshProjects();
      }),
      realtimeService.on('agent.completed', (d) => {
        addEvent('agent.completed', d);
        if (d.sprintId) {
          setPendingQuestions((prev: PendingQuestionsMap) => ({
            ...prev,
            [d.sprintId as string]: 0,
          }));
          clearStuck(d.sprintId as string);
        }
        refreshProjects();
      }),
      realtimeService.on('agent.error', (d) => {
        addEvent('agent.error', d);
        refreshProjects();
      }),
      realtimeService.on('agent.question', (d) => {
        addEvent('agent.question', d);
        if (d.sprintId) {
          setPendingQuestions((prev: PendingQuestionsMap) => ({
            ...prev,
            [d.sprintId as string]: (prev[d.sprintId as string] ?? 0) + 1,
          }));
          const projectName =
            projectsRef.current?.find((p) => p.sprint?.id === d.sprintId)?.project.name ??
            'Unknown';
          markBlocked(d.sprintId as string, projectName);
        }
      }),
      realtimeService.on('agent.tool', (d) => {
        if (d.status === 'pending' || d.status === 'in_progress') {
          const toolName = (d.name || d.title || '') as string;
          addEvent('agent.tool', { ...d, detail: toolName });
          if (d.sprintId) {
            setLastToolMap((prev: LastToolMap) => ({
              ...prev,
              [d.sprintId as string]: { name: toolName, timestamp: Date.now() },
            }));
            const projectName =
              projectsRef.current?.find((p) => p.sprint?.id === d.sprintId)?.project.name ??
              'Unknown';
            const detection = l2.current?.recordToolCall(d.sprintId as string, toolName);
            if (detection) {
              setStuckDetections((prev: StuckDetection[]) => {
                const filtered = prev.filter(
                  (s) => !(s.sprintId === detection.sprintId && s.reason === 'repeated_tool'),
                );
                return [...filtered, { ...detection, projectName }];
              });
            }
          }
        }
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []); // stable — uses cbRef
}
