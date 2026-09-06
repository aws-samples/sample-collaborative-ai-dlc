import type { Intent } from '@/services/intents';
import type { CompiledWorkflow } from '@/services/workflows';

type CompiledStageNode = CompiledWorkflow['graph']['nodes'][number];

export interface IntentStageSelection {
  available: CompiledStageNode[];
  selected: CompiledStageNode[];
}

export function getIntentStageSelection(
  intent: Intent,
  compiled: CompiledWorkflow,
  initializationPhasePaths: Set<string>,
): IntentStageSelection {
  const projection =
    intent.composedGrid ?? (intent.scope ? compiled.scopeGrid?.[intent.scope] : undefined);
  const explicitSkips = new Set(intent.skipStageIds ?? []);
  const available = compiled.graph.nodes.filter(
    (node) => !initializationPhasePaths.has(node.phasePath ?? ''),
  );
  const selected = available.filter(
    (node) =>
      (!projection || projection[node.stageId] === 'EXECUTE') && !explicitSkips.has(node.stageId),
  );

  return { available, selected };
}
