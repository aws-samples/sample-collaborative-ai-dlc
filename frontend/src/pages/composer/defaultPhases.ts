import type { PhaseNodeInput } from '@/services/workflows';

export const DEFAULT_PHASE_NODES: PhaseNodeInput[] = [
  { phaseId: 'initialization', path: '01', name: 'Initialization', kind: 'phase' },
  { phaseId: 'ideation', path: '02', name: 'Ideation', kind: 'phase' },
  { phaseId: 'inception', path: '03', name: 'Inception', kind: 'phase' },
  { phaseId: 'construction', path: '04', name: 'Construction', kind: 'phase' },
  { phaseId: 'operation', path: '05', name: 'Operation', kind: 'phase' },
];
