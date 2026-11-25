import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';

// Mutable provider state: one test file for the states the static fixture in
// IntentActivityPanel.test.tsx cannot express (detail still loading, a stage
// whose single event asks several questions).
const intentState = vi.hoisted(() => ({
  detail: null as null | {
    intent: { id: string };
    events: {
      eventId: string;
      type: string;
      summary: string;
      timestamp: string;
      stageInstanceId?: string;
    }[];
  },
  loading: true,
  stageRows: [] as { stageId: string; stageInstanceId: string; state: string }[],
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/contexts/IntentContext', () => ({
  INTENT_OUTPUT_KEY: 'intent',
  useIntent: () => ({
    detail: intentState.detail,
    loading: intentState.loading,
    stageRows: intentState.stageRows,
    agentFocus: null,
    previewSeq: 0,
    activityTabRequest: null,
    projectId: 'p1',
    intentId: 'i1',
    outputBuffers: new Map<string, string>(),
    outputRows: new Map(),
    outputVersion: 0,
    stageNameOf: (key: string) => (key === 'si-1' ? 'Feasibility' : key),
    ensureOutputs: vi.fn(),
    outputPaneStatus: () => 'seeded',
    setPaneVisible: vi.fn(),
    hasEarlierOutput: () => false,
    hasLoadedEarlierOutput: () => false,
    loadEarlierOutput: vi.fn(),
  }),
}));
vi.mock('@/components/discussion', () => ({
  DiscussionPanel: () => <div />,
  useDiscussions: () => ({ discussions: [], isOpen: false, activeDiscussion: null }),
}));
vi.mock('@/components/discussion/DiscussionsTab', () => ({
  DiscussionsTab: () => <div />,
}));
vi.mock('@/services/projects', () => ({
  projectsService: { listMembers: vi.fn(() => Promise.resolve([])) },
}));

import { IntentActivityPanel } from './IntentActivityPanel';

async function openTimeline() {
  render(<IntentActivityPanel onClose={() => {}} />);
  await userEvent.click(screen.getByRole('tab', { name: /Timeline/ }));
}

describe('IntentActivityPanel Timeline tab while the intent loads (R3-2)', () => {
  beforeEach(() => {
    intentState.detail = null;
    intentState.loading = true;
    intentState.stageRows = [];
  });

  it('shows loading skeletons, never "No events yet", before the detail is known', async () => {
    await openTimeline();
    expect(screen.getByTestId('timeline-loading')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading run activity' })).toBeInTheDocument();
    expect(screen.queryByText('No events yet')).not.toBeInTheDocument();
  });

  it('says "No events yet" only once the detail answered with no events', async () => {
    intentState.detail = { intent: { id: 'i1' }, events: [] };
    intentState.loading = false;
    await openTimeline();
    expect(screen.getByText('No events yet')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-loading')).not.toBeInTheDocument();
  });

  it('claims nothing about a run when the intent could not be loaded (R5-30)', () => {
    intentState.detail = null;
    intentState.loading = false;
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByText('Nothing to show for this intent.')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close activity panel' })).toBeInTheDocument();
  });
});

describe('IntentActivityPanel Timeline group pill (R3-7)', () => {
  it('counts the questions the agent asked, not the question events', async () => {
    intentState.loading = false;
    intentState.stageRows = [{ stageId: 'feasibility', stageInstanceId: 'si-1', state: 'RUNNING' }];
    intentState.detail = {
      intent: { id: 'i1' },
      events: [
        {
          eventId: 'e1',
          stageInstanceId: 'si-1',
          type: 'v2.stage.running',
          summary: 'Stage feasibility running',
          timestamp: '2026-08-11T09:00:00Z',
        },
        {
          eventId: 'e2',
          stageInstanceId: 'si-1',
          type: 'v2.question.asked',
          summary: 'Agent asked 4 question(s)',
          timestamp: '2026-08-11T09:01:00Z',
        },
        {
          eventId: 'e3',
          stageInstanceId: 'si-1',
          type: 'v2.stage.parked',
          summary: 'Stage feasibility parked on question q-1',
          timestamp: '2026-08-11T09:01:30Z',
        },
      ],
    };
    await openTimeline();
    expect(screen.getByRole('heading', { level: 3, name: /Feasibility/ })).toBeInTheDocument();
    expect(screen.getByText('4 questions')).toBeInTheDocument();
    expect(screen.queryByText('2 questions')).not.toBeInTheDocument();
    expect(screen.getByText('Agent asked 4 questions')).toBeInTheDocument();
  });
});
