import type { IntentStageRow } from '@/contexts/IntentContext';
import { describeFailure } from '@/lib/failureReasons';
import type { Intent, IntentActivityEvent } from '@/services/intents';

// Shared by the stage list and the pipeline bar so both paint the same stage
// red: a run can fail before the failing stage gets a row (the orchestrator
// rejects it at dispatch) and every row still reads PENDING/SUCCEEDED while
// the run is FAILED. The failure message or event names the stage.

// Events that relaunch the run: failure evidence recorded before the latest
// one belongs to an earlier execution and must not decorate today's rows.
const RELAUNCH_EVENT_TYPES = new Set([
  'v2.execution.rewound',
  'v2.execution.repaired',
  'v2.execution.lanes_repaired',
  'v2.execution.recomposed',
]);

// A row the server already settled is authoritative; only rows still waiting
// for a state can take an inferred failure.
const SETTLED_STATES: ReadonlySet<string> = new Set(['SUCCEEDED', 'SKIPPED', 'FAILED']);

type FailureEvidence = {
  stageId: string;
  technical: string;
  stageInstanceId?: string | null;
  unitSlug?: string | null;
};

function failureTarget(rows: IntentStageRow[], f: FailureEvidence): IntentStageRow | null {
  const sameStage = rows.filter((r) => r.stageId === f.stageId);
  let matches = sameStage;
  if (f.stageInstanceId && sameStage.some((r) => r.stageInstanceId === f.stageInstanceId)) {
    matches = sameStage.filter((r) => r.stageInstanceId === f.stageInstanceId);
  } else if (f.unitSlug) {
    matches = sameStage.filter((r) => r.unitSlug === f.unitSlug);
  }
  // Several lanes and nothing naming one: marking any of them would be a guess.
  if (matches.length !== 1) return null;
  return SETTLED_STATES.has(matches[0].state) ? null : matches[0];
}

export function withInferredFailure(
  stageRows: IntentStageRow[],
  intent: Intent | undefined,
  events: IntentActivityEvent[],
): IntentStageRow[] {
  if (intent?.status !== 'FAILED' || stageRows.some((r) => r.state === 'FAILED')) {
    return stageRows;
  }
  const relaunchAt = events.findLastIndex((e) => RELAUNCH_EVENT_TYPES.has(e.type));
  const evidence: FailureEvidence[] = [];
  const fromIntent = describeFailure(
    intent.failure?.code,
    intent.failure?.message ?? intent.failureReason,
  );
  if (fromIntent.stageId) {
    evidence.push({ stageId: fromIntent.stageId, technical: fromIntent.technical });
  }
  for (const e of events.slice(relaunchAt + 1).toReversed()) {
    const f = describeFailure(undefined, e.summary);
    if (f.stageId) {
      evidence.push({
        stageId: f.stageId,
        technical: f.technical,
        stageInstanceId: e.stageInstanceId,
        unitSlug: e.unitSlug,
      });
    }
  }
  for (const f of evidence) {
    const target = failureTarget(stageRows, f);
    if (!target) continue;
    return stageRows.map((r) =>
      r === target
        ? { ...r, state: 'FAILED' as const, runtimeError: r.runtimeError ?? f.technical }
        : r,
    );
  }
  return stageRows;
}
