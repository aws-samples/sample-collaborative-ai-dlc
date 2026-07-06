import type { PhaseNodeInput } from '@/services/workflows';

export const DEFAULT_PHASE_NODES: PhaseNodeInput[] = [
  { phaseId: 'ideation', path: '01', name: 'Ideation', kind: 'phase' },
  { phaseId: 'inception', path: '02', name: 'Inception', kind: 'phase' },
  { phaseId: 'construction', path: '03', name: 'Construction', kind: 'phase' },
  { phaseId: 'operation', path: '04', name: 'Operation', kind: 'phase' },
];
