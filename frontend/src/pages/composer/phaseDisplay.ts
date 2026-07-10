import type { Block } from '@/services/blocks';
import type { PhaseNode, Placement } from '@/services/workflows';

const LEGACY_VISIBLE_PHASES = ['ideation', 'inception', 'construction', 'operation'];

export const visibleWorkflowPhases = (phases: PhaseNode[]) =>
  phases
    .filter((phase) => phase.phaseId !== 'initialization')
    .toSorted((a, b) => a.path.localeCompare(b.path));

const isLegacyHiddenInitializationSkeleton = (phases: PhaseNode[]) => {
  const byId = new Map(phases.map((phase) => [phase.phaseId, phase.path]));
  if (byId.has('initialization')) return false;
  const visibleLegacyPhases = phases.filter((phase) =>
    LEGACY_VISIBLE_PHASES.includes(phase.phaseId),
  );
  if (visibleLegacyPhases.length === 0) return false;
  return visibleLegacyPhases.every((phase) => {
    const legacyIndex = LEGACY_VISIBLE_PHASES.indexOf(phase.phaseId);
    return phase.path === String(legacyIndex + 1).padStart(2, '0');
  });
};

export const displayPhasePathForPlacement = (
  placement: Placement,
  phases: PhaseNode[],
  stagesById: Record<string, Block>,
) => {
  if (!isLegacyHiddenInitializationSkeleton(phases)) return placement.phasePath ?? null;
  const semanticPhase = stagesById[placement.stageId]?.phase;
  if (typeof semanticPhase !== 'string' || semanticPhase === 'initialization') {
    return placement.phasePath ?? null;
  }
  return (
    phases.find((phase) => phase.phaseId === semanticPhase)?.path ?? placement.phasePath ?? null
  );
};
