import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/query';

const mocks = vi.hoisted(() => ({
  focusOutput: vi.fn(),
  ensureOutputs: vi.fn(),
  useVisibleOutputPanes: vi.fn(),
  rawNames: false,
  events: [] as { type: string; stageInstanceId: string | null; summary: string }[],
  outputs: true,
}));

vi.mock('@/contexts/IntentContext', () => ({
  INTENT_OUTPUT_KEY: 'intent',
  useVisibleOutputPanes: mocks.useVisibleOutputPanes,
  useIntent: () => ({
    detail: {
      intent: { id: 'i1', status: 'RUNNING', pendingHumanTaskId: null },
      events: mocks.events,
    },
    stageRows: [
      {
        stageId: 'requirements-analysis',
        stageInstanceId: 'si-1',
        state: 'RUNNING',
        phase: 'inception',
        startedAt: '2026-07-18T10:00:00Z',
      },
    ],
    stageNameOf: (key: string) =>
      key === 'si-1' ? (mocks.rawNames ? 'requirements-analysis' : 'Requirements Analysis') : key,
    phaseNameOf: (phase: string) => phase,
    gates: [],
    outputRows: new Map(
      mocks.outputs
        ? [
            [
              'si-1',
              [
                {
                  seq: 1,
                  stageInstanceId: 'si-1',
                  kind: 'stdout',
                  content: '> Drafting the requirements document now.\n',
                  timestamp: '2026-07-18T10:00:01Z',
                  display: {
                    type: 'message',
                    summary: '> Drafting the requirements document now.',
                  },
                },
                {
                  seq: 2,
                  stageInstanceId: 'si-1',
                  kind: 'stdout',
                  content:
                    'Running tool get_artifact with the param\n ... { "id": "intent-statement", "mode": "full" }\n',
                  timestamp: '2026-07-18T10:00:02Z',
                },
                {
                  seq: 3,
                  stageInstanceId: 'si-1',
                  kind: 'stdout',
                  content: ': "label": "No enforcement - trust the developer",\n',
                  timestamp: '2026-07-18T10:00:03Z',
                },
              ],
            ],
          ]
        : [],
    ),
    outputVersion: 1,
    ensureOutputs: mocks.ensureOutputs,
    focusOutput: mocks.focusOutput,
    rewindIntent: vi.fn(),
  }),
}));

vi.mock('@/components/intent/WaitingCard', () => ({ WaitingCard: () => <div /> }));

import { AgentProgressCard } from './AgentProgressCard';

describe('AgentProgressCard', () => {
  it('shows the latest readable progress line, never raw tool JSON', () => {
    render(<AgentProgressCard />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Requirements Analysis')).toBeInTheDocument();
    expect(screen.getByText('Drafting the requirements document now.')).toBeInTheDocument();
    expect(screen.queryByText(/"mode": "full"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No enforcement/)).not.toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
    expect(mocks.useVisibleOutputPanes).toHaveBeenCalledWith(['si-1']);
  });

  it('names the running stage, never its slug, in the title and the status line', () => {
    mocks.rawNames = true;
    mocks.outputs = false;
    mocks.events = [
      {
        type: 'v2.stage.running',
        stageInstanceId: 'si-1',
        summary: 'Stage requirements-analysis running',
      },
    ];
    render(<AgentProgressCard />);
    expect(screen.getByText('Requirements Analysis')).toBeInTheDocument();
    expect(screen.getByText('Stage Requirements Analysis running')).toBeInTheDocument();
    expect(screen.queryByText(/requirements-analysis/)).not.toBeInTheDocument();
  });
});
