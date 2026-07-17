import type { IntentGate, IntentStage } from '@/services/intents';

export interface LaneWaitStatus {
  kind: 'input' | 'recovery';
  stageId: string;
  stageInstanceId: string;
  humanTaskId: string | null;
  since: string | null;
  blocker: string;
}

export const laneWaitKey = (sectionIndex: number | null | undefined, unitSlug: string) =>
  `s${sectionIndex ?? 'legacy'}:${unitSlug}`;

const questionPreview = (gate: IntentGate): string | null => {
  if (gate.prompt) return gate.prompt;
  if (gate.kind !== 'question' || !gate.questions) return null;
  try {
    const questions = JSON.parse(gate.questions) as { text?: string }[];
    return Array.isArray(questions) ? (questions[0]?.text ?? null) : null;
  } catch {
    return null;
  }
};

export function deriveLaneWaits(
  stages: IntentStage[],
  gates: IntentGate[],
): Record<string, LaneWaitStatus> {
  const pending = gates.filter((gate) => gate.status === 'pending');
  const result: Record<string, LaneWaitStatus> = {};

  for (const stage of stages) {
    if (
      stage.state !== 'WAITING_FOR_HUMAN' ||
      !stage.unitSlug ||
      !stage.stageId ||
      !stage.stageInstanceId
    ) {
      continue;
    }
    const ownedGate = pending.find(
      (gate) =>
        gate.stageInstanceId === stage.stageInstanceId &&
        (gate.unitSlug ?? null) === stage.unitSlug &&
        (gate.sectionIndex == null ||
          stage.sectionIndex == null ||
          Number(gate.sectionIndex) === Number(stage.sectionIndex)) &&
        (!stage.pendingHumanTaskId || gate.humanTaskId === stage.pendingHumanTaskId),
    );
    const key = laneWaitKey(stage.sectionIndex, stage.unitSlug);
    if (ownedGate) {
      const preview = questionPreview(ownedGate);
      result[key] = {
        kind: 'input',
        stageId: stage.stageId,
        stageInstanceId: stage.stageInstanceId,
        humanTaskId: ownedGate.humanTaskId,
        since: ownedGate.createdAt ?? stage.parkedAt ?? null,
        blocker: preview
          ? `${stage.stageId}: ${preview}`
          : `${stage.stageId} is waiting on question ${ownedGate.humanTaskId}.`,
      };
    } else {
      result[key] = {
        kind: 'recovery',
        stageId: stage.stageId,
        stageInstanceId: stage.stageInstanceId,
        humanTaskId: null,
        since: stage.parkedAt ?? null,
        blocker: `${stage.stageId} is parked without a pending question. Repair is required.`,
      };
    }
  }

  return result;
}
