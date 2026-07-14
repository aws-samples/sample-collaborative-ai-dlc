import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  ensureOutputs: vi.fn(),
}));

vi.mock('@/contexts/IntentContext', () => ({
  INTENT_OUTPUT_KEY: 'intent',
  useIntent: () => ({
    detail: { intent: { id: 'i1' }, events: [] },
    stageRows: [
      {
        stageId: 'requirements-analysis',
        stageInstanceId: 'si-1',
        state: 'RUNNING',
      },
    ],
    agentFocus: null,
    previewSeq: 0,
    outputBuffers: new Map([
      [
        'si-1',
        'Running tool get_artifact with the param\n ... { "id": "intent-statement", "mode": "full" }\n - Completed in 0.12s\nRunning tool fs_read with the param\n ... { "path": "missing.txt" }\n - Failed in 0.01s\n',
      ],
    ]),
    outputRows: new Map([
      [
        'si-1',
        [
          {
            seq: 1,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content:
              'Running tool get_artifact with the param\n ... { "id": "intent-statement", "mode": "full" }\n - Completed in 0.12s\n',
            timestamp: '2026-01-01T00:00:00Z',
            display: {
              type: 'artifact',
              title: 'Loaded artifact: intent-statement',
              summary: 'Completed in 0.12s',
            },
          },
          {
            seq: 2,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content: 'Running tool link_artifacts with the param\n ... { "from": "a" }\n',
            timestamp: '2026-01-01T00:00:01Z',
            display: {
              type: 'tool',
              title: 'Link Artifacts',
              hiddenByDefault: true,
            },
          },
          {
            seq: 3,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content:
              'Running tool fs_read with the param\n ... { "path": "missing.txt" }\n - Failed in 0.01s\n',
            timestamp: '2026-01-01T00:00:02Z',
            display: {
              type: 'tool',
              level: 'error',
              title: 'Fs Read failed',
              details:
                'Running tool fs_read with the param\n ... { "path": "missing.txt" }\n - Failed in 0.01s',
            },
          },
        ],
      ],
    ]),
    outputVersion: 1,
    stageNameOf: (key: string) => (key === 'si-1' ? 'Requirements Analysis' : key),
    ensureOutputs: mocks.ensureOutputs,
    outputPaneStatus: () => 'seeded',
  }),
}));

vi.mock('@/components/discussion', () => ({
  DiscussionPanel: () => <div />,
  useDiscussions: () => ({ discussions: [], isOpen: false, activeDiscussion: null }),
}));
vi.mock('@/components/discussion/DiscussionsTab', () => ({
  DiscussionsTab: () => <div />,
}));

import { IntentActivityPanel } from './IntentActivityPanel';

describe('IntentActivityPanel Agent tab', () => {
  beforeEach(() => {
    mocks.ensureOutputs.mockClear();
  });

  it('defaults to Progress, hides routine tool chatter, and shows Raw transcript on toggle', async () => {
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);

    await user.click(screen.getByRole('tab', { name: /Agent/i }));
    expect(mocks.ensureOutputs).toHaveBeenCalledWith('si-1');
    expect(screen.getByText('Loaded artifact: intent-statement')).toBeInTheDocument();
    expect(screen.getByText('Fs Read failed')).toBeInTheDocument();
    expect(screen.queryByText('Link Artifacts')).not.toBeInTheDocument();
    expect(screen.queryByText(/"mode": "full"/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText(/"mode": "full"/)).toBeInTheDocument();
    expect(screen.getByText(/Running tool get_artifact/)).toBeInTheDocument();
  });
});
