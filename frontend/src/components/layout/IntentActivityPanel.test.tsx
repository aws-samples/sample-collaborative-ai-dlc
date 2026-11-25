import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  ensureOutputs: vi.fn(),
  setPaneVisible: vi.fn(),
  hasEarlierOutput: vi.fn((_key: string) => false),
  hasLoadedEarlierOutput: vi.fn((_key: string) => false),
  loadEarlierOutput: vi.fn(),
  outputPaneStatus: vi.fn((_key: string) => 'seeded'),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/contexts/IntentContext', () => ({
  INTENT_OUTPUT_KEY: 'intent',
  useIntent: () => ({
    detail: {
      intent: { id: 'i1' },
      events: [
        {
          eventId: 'tracker-closed',
          type: 'v2.tracker.closed',
          summary: 'Closed Issue #42',
          timestamp: '2026-08-11T10:00:00Z',
        },
        {
          eventId: 'tracker-commented',
          type: 'v2.tracker.commented',
          summary: 'Added tracker delivery comment',
          timestamp: '2026-08-11T09:59:00Z',
        },
        {
          eventId: 'tracker-merged-commented',
          type: 'v2.tracker.merged_commented',
          summary: 'Added merged delivery comment',
          timestamp: '2026-08-11T09:58:00Z',
        },
        {
          eventId: 'tracker-failed',
          type: 'v2.tracker.failed',
          summary: 'Tracker write attempt failed',
          timestamp: '2026-08-11T09:57:00Z',
        },
        {
          eventId: 'tracker-blocked',
          type: 'v2.tracker.blocked',
          summary: 'Tracker synchronization stopped',
          timestamp: '2026-08-11T09:56:00Z',
        },
      ],
    },
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
        'Running tool get_artifact with the param\n ... { "id": "intent-statement", "mode": "full" }\n - Completed in 0.12s\n: "label": "No enforcement - trust the developer",\n- Completed in 12.76s\nstdout\n> Question parked - stopping now.\nRunning tool fs_read with the param\n ... { "path": "missing.txt" }\n - Failed in 0.01s\n',
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
            content: ': "label": "No enforcement - trust the developer",\n',
            timestamp: '2026-01-01T00:00:02Z',
          },
          {
            seq: 4,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content: '- Completed in 12.76s\n',
            timestamp: '2026-01-01T00:00:03Z',
          },
          {
            seq: 5,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content: 'stdout\n',
            timestamp: '2026-01-01T00:00:04Z',
          },
          {
            seq: 6,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content: '> Question parked - stopping now.\n',
            timestamp: '2026-01-01T00:00:05Z',
          },
          {
            seq: 7,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content:
              'Running tool get_artifact with the param\n ... { "id": "architecture", "mode": "full" }\n - Completed in 0.43s\n',
            timestamp: '2026-01-01T00:00:06Z',
            display: {
              type: 'artifact',
              title: 'Loaded artifact: artifact',
              summary: 'Completed in 0.43s',
            },
          },
          {
            seq: 8,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content:
              'Running tool fs_read with the param\n ... { "path": "missing.txt" }\n - Failed in 0.01s\n',
            timestamp: '2026-01-01T00:00:07Z',
            display: {
              type: 'tool',
              level: 'error',
              title: 'Fs Read failed',
              details:
                'Running tool fs_read with the param\n ... { "path": "missing.txt" }\n - Failed in 0.01s',
            },
          },
          {
            seq: 9,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content: '+ 10: <div class="settings-card">\n',
            timestamp: '2026-01-01T00:00:08Z',
          },
          {
            seq: 10,
            stageInstanceId: 'si-1',
            kind: 'stdout',
            content: '+ 11: <h2>Mobile App Pairing</h2>\n',
            timestamp: '2026-01-01T00:00:09Z',
          },
        ],
      ],
    ]),
    outputVersion: 1,
    stageNameOf: (key: string) => (key === 'si-1' ? 'Requirements Analysis' : key),
    ensureOutputs: mocks.ensureOutputs,
    outputPaneStatus: mocks.outputPaneStatus,
    setPaneVisible: mocks.setPaneVisible,
    hasEarlierOutput: mocks.hasEarlierOutput,
    hasLoadedEarlierOutput: mocks.hasLoadedEarlierOutput,
    loadEarlierOutput: mocks.loadEarlierOutput,
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
    mocks.setPaneVisible.mockClear();
    mocks.loadEarlierOutput.mockClear();
    mocks.hasEarlierOutput.mockReset().mockReturnValue(false);
    mocks.hasLoadedEarlierOutput.mockReset().mockReturnValue(false);
    mocks.outputPaneStatus.mockReset().mockReturnValue('seeded');
  });

  it('declares the displayed transcript visible, and hidden when the tab is left', async () => {
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);

    await user.click(screen.getByRole('tab', { name: /Agent/i }));
    expect(mocks.setPaneVisible).toHaveBeenLastCalledWith('si-1', true);

    await user.click(screen.getByRole('tab', { name: /Timeline/i }));
    expect(mocks.setPaneVisible).toHaveBeenLastCalledWith('si-1', false);
  });

  it('offers trimmed earlier output', async () => {
    mocks.hasEarlierOutput.mockReturnValue(true);
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);

    await user.click(screen.getByRole('tab', { name: /Agent/i }));
    expect(
      screen.getByText('Earlier output was trimmed to keep this page fast'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load earlier output' }));
    expect(mocks.loadEarlierOutput).toHaveBeenCalledWith('si-1');
  });

  it('keeps offering earlier output while a loaded beginning still leaves a gap', async () => {
    mocks.hasEarlierOutput.mockReturnValue(true);
    mocks.hasLoadedEarlierOutput.mockReturnValue(true);
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);

    await user.click(screen.getByRole('tab', { name: /Agent/i }));
    expect(
      screen.getByText('Part of the earlier output is still hidden to keep this page fast'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more earlier output' }));
    expect(mocks.loadEarlierOutput).toHaveBeenCalledWith('si-1');
  });

  it('shows a retryable error when the transcript failed to load', async () => {
    mocks.outputPaneStatus.mockReturnValue('error');
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);

    await user.click(screen.getByRole('tab', { name: /Agent/i }));
    expect(screen.getByText('Agent output could not be loaded')).toBeInTheDocument();
    mocks.ensureOutputs.mockClear();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.ensureOutputs).toHaveBeenCalledWith('si-1');
  });

  it('defaults to Progress, hides routine tool chatter, and shows Raw transcript on toggle', async () => {
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);

    await user.click(screen.getByRole('tab', { name: /Agent/i }));
    expect(mocks.ensureOutputs).toHaveBeenCalledWith('si-1');
    expect(screen.getByText('Loaded artifact: intent-statement')).toBeInTheDocument();
    expect(screen.getByText('Loaded artifact: architecture')).toBeInTheDocument();
    expect(screen.getByText('Fs Read failed')).toBeInTheDocument();
    expect(screen.getByText('Updated (+2 lines)')).toBeInTheDocument();
    expect(screen.getByText('Question parked - stopping now.')).toBeInTheDocument();
    expect(screen.queryByText('Loaded artifact: artifact')).not.toBeInTheDocument();
    expect(screen.queryByText('Link Artifacts')).not.toBeInTheDocument();
    expect(screen.queryByText(/"mode": "full"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No enforcement/)).not.toBeInTheDocument();
    expect(screen.queryByText('stdout')).not.toBeInTheDocument();
    expect(screen.queryByText(/Completed in 12.76s/)).not.toBeInTheDocument();
    expect(document.querySelectorAll('time[datetime]').length).toBeGreaterThan(0);
    expect(document.querySelector('time[datetime="2026-01-01T00:00:08Z"]')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText(/"mode": "full"/)).toBeInTheDocument();
    expect(screen.getByText(/No enforcement/)).toBeInTheDocument();
    expect(screen.getByText(/Running tool get_artifact/)).toBeInTheDocument();
  });
});

describe('IntentActivityPanel Timeline tab', () => {
  it('renders tracker events with semantic status colors', () => {
    render(<IntentActivityPanel onClose={() => {}} />);

    for (const summary of [
      'Closed Issue #42',
      'Added tracker delivery comment',
      'Added merged delivery comment',
    ]) {
      const item = screen.getByText(summary).closest('.flex.gap-3.py-2');
      expect(item?.querySelector('.bg-agent-success')).not.toBeNull();
    }

    const failed = screen.getByText('Tracker write attempt failed').closest('.flex.gap-3.py-2');
    expect(failed?.querySelector('.bg-agent-error')).not.toBeNull();

    const blocked = screen.getByText('Tracker synchronization stopped').closest('.flex.gap-3.py-2');
    expect(blocked?.querySelector('.bg-agent-waiting')).not.toBeNull();
  });
});

// A Radix tab's aria-controls must name a tabpanel that is in the DOM (axe
// aria-valid-attr-value): the active content renders inside TabsContent.
function expectSelectedTabControlsItsPanel(tab: HTMLElement, content: RegExp | string) {
  expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
  expect(panel).not.toBeNull();
  expect(panel).toHaveAttribute('role', 'tabpanel');
  expect(panel).toHaveAttribute('aria-labelledby', tab.id);
  expect(panel).toHaveTextContent(content);
}

describe('IntentActivityPanel tabs', () => {
  it('points each selected tab at a real tabpanel holding its content', async () => {
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);
    expectSelectedTabControlsItsPanel(
      screen.getByRole('tab', { name: 'Timeline' }),
      /Closed Issue #42/,
    );
    await user.click(screen.getByRole('tab', { name: 'Agent' }));
    expectSelectedTabControlsItsPanel(screen.getByRole('tab', { name: /^Agent/ }), /Progress|Raw/);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });
});

describe('IntentActivityPanel header accessibility', () => {
  it('close button has aria-label and is always in the DOM', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    const closeBtn = screen.getByRole('button', { name: 'Close activity panel' });
    expect(closeBtn).toBeInTheDocument();
    expect(closeBtn).toHaveAttribute('aria-label', 'Close activity panel');
  });

  it('close button fires onClose callback', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<IntentActivityPanel onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close activity panel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
