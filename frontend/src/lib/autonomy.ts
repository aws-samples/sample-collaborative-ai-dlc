import type { AutonomyLevel } from '@/services/workflows';

export const AUTONOMY_STYLES: Record<
  AutonomyLevel,
  { dot: string; label: string; chipLabel: string; tooltip: string }
> = {
  'self-halting': {
    dot: 'bg-emerald-500',
    label: 'self-halting',
    chipLabel: 'Auto',
    tooltip: 'Gate: fully autonomous — no human approval required',
  },
  mixed: {
    dot: 'bg-amber-500',
    label: 'mixed',
    chipLabel: 'Mixed',
    tooltip: 'Gate: mixed autonomy — some steps need human input',
  },
  'human-gated': {
    dot: 'bg-rose-500',
    label: 'human-gated',
    chipLabel: 'Human gate',
    tooltip: 'Gate: human validation required — click the chip to configure in the stage editor',
  },
};
