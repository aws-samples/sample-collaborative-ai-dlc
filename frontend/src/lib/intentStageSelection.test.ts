import { describe, expect, it } from 'vitest';
import type { Intent } from '@/services/intents';
import type { CompiledWorkflow } from '@/services/workflows';
import { getIntentStageSelection } from './intentStageSelection';

const compiled = {
  scopeGrid: {
    feature: {
      requirements: 'EXECUTE',
      design: 'EXECUTE',
      build: 'SKIP',
    },
  },
  graph: {
    nodes: [
      { stageId: 'initialize', phasePath: '00', order: 0 },
      { stageId: 'requirements', phasePath: '01', order: 1 },
      { stageId: 'design', phasePath: '01', order: 2 },
      { stageId: 'build', phasePath: '02', order: 3 },
    ],
  },
} as unknown as CompiledWorkflow;

describe('getIntentStageSelection', () => {
  it('prefers the composed projection and applies initialization and skip overlays', () => {
    const intent = {
      scope: 'feature',
      composedGrid: {
        requirements: 'SKIP',
        design: 'EXECUTE',
        build: 'EXECUTE',
      },
      skipStageIds: ['build'],
    } as unknown as Intent;

    const selection = getIntentStageSelection(intent, compiled, new Set(['00']));

    expect(selection.available.map((node) => node.stageId)).toEqual([
      'requirements',
      'design',
      'build',
    ]);
    expect(selection.selected.map((node) => node.stageId)).toEqual(['design']);
  });

  it('falls back to the named scope when no composed projection exists', () => {
    const intent = {
      scope: 'feature',
      composedGrid: null,
      skipStageIds: [],
    } as unknown as Intent;

    const selection = getIntentStageSelection(intent, compiled, new Set(['00']));

    expect(selection.selected.map((node) => node.stageId)).toEqual(['requirements', 'design']);
  });
});
