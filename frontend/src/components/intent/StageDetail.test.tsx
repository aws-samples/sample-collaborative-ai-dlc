import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageDetail } from './StageDetail';

vi.mock('@/contexts/IntentContext', () => ({
  stageRowKey: (row: { stageId: string; stageInstanceId: string | null }) =>
    row.stageInstanceId ?? row.stageId,
  useIntent: () => ({
    detail: null,
    stageEdges: [],
    stageRows: [],
    gates: [],
    sensorsByStage: new Map([
      [
        'instance-1',
        [
          {
            sensorRunId: 'sensor-run-1',
            stageInstanceId: 'instance-1',
            sensorId: 'type-check',
            result: 'FAIL',
            severity: 'blocking',
            held: true,
            detail: (globalThis as { sensorDetail?: unknown }).sensorDetail ?? null,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      ],
    ]),
    artifactsByStage: new Map(),
    outputBuffers: new Map(),
    setSelectedStageId: vi.fn(),
    focusOutput: vi.fn(),
    openArtifactPreview: vi.fn(),
    rewindIntent: vi.fn(),
  }),
}));

const row = {
  stageId: 'type-check',
  phase: null,
  state: 'FAILED' as const,
  stageInstanceId: 'instance-1',
  unitSlug: null,
  runtimeError: null,
  startedAt: null,
  completedAt: null,
  waitMs: 0,
  parkedAt: null,
  pendingHumanTaskId: null,
  attempt: 1,
  cli: null,
  resolvedModel: null,
  order: 1,
  planned: true,
};

const cases = [
  {
    name: 'an earlier silent failure',
    detail: {
      files: [
        { file: 'a.ts', result: 'FAIL', detail: { pass: false } },
        { file: 'b.ts', result: 'FAIL', detail: { pass: false, reason: 'type error on b' } },
      ],
    },
  },
  {
    name: 'an earlier timeout',
    detail: {
      files: [
        { file: 'a.ts', result: 'INCONCLUSIVE', timedOut: true, detail: null },
        { file: 'b.ts', result: 'FAIL', detail: { reason: 'explained failure on b' } },
      ],
    },
  },
] as const;

describe('StageDetail', () => {
  it.each(cases)('keeps the inline explanation aligned with the chip for $name', (testCase) => {
    (globalThis as { sensorDetail?: unknown }).sensorDetail = testCase.detail;

    render(<StageDetail row={row} />);

    const chip = screen.getByTitle(/type-check: FAIL \(blocking\)/);
    const tooltip = chip.getAttribute('title');
    expect(tooltip).toBeTruthy();
    const explanation = tooltip!.split(' — ').at(-1)!;
    expect(screen.getByRole('listitem')).toHaveTextContent(explanation);
  });
});
