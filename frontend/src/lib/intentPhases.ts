import type { IntentStageRow } from '@/contexts/IntentContext';

export interface PhaseGroup {
  phase: string;
  rows: IntentStageRow[];
  done: number;
  total: number;
}

export function groupByPhase(rows: IntentStageRow[]): PhaseGroup[] {
  const map = new Map<string, IntentStageRow[]>();
  for (const row of rows) {
    const key = row.phase ?? '(ungrouped)';
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  const groups: PhaseGroup[] = [];
  for (const [phase, phaseRows] of map) {
    const done = phaseRows.filter((r) => r.state === 'SUCCEEDED' || r.state === 'SKIPPED').length;
    groups.push({ phase, rows: phaseRows, done, total: phaseRows.length });
  }
  return groups;
}
