// Timeline tab: one readable line per event, grouped by stage, raw payload one
// action away, filters, and a new-events affordance that never scrolls the
// reader. Events are fed through the mocked IntentProvider like the other
// IntentActivityPanel suites.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import type { IntentActivityEvent } from '@/services/intents';

const mocks = vi.hoisted(() => ({
  events: [] as IntentActivityEvent[],
  user: null as { userId: string; email: string } | null,
  activityTabRequest: null as { tab: string; seq: number } | null,
  intentId: 'i1',
  members: [] as { userId: string; email?: string }[],
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user }),
}));
vi.mock('@/contexts/IntentContext', () => ({
  INTENT_OUTPUT_KEY: 'intent',
  useIntent: () => ({
    detail: {
      intent: { id: mocks.intentId },
      events: mocks.events,
      stages: [
        { stageInstanceId: 'si-cap', stageId: 'intent-capture', unitSlug: null },
        { stageInstanceId: 'si-req', stageId: 'requirements-analysis', unitSlug: null },
      ],
    },
    stageRows: [
      { stageId: 'intent-capture', stageInstanceId: 'si-cap', state: 'SUCCEEDED', unitSlug: null },
      {
        stageId: 'requirements-analysis',
        stageInstanceId: 'si-req',
        state: 'RUNNING',
        unitSlug: null,
      },
    ],
    agentFocus: null,
    previewSeq: 0,
    activityTabRequest: mocks.activityTabRequest,
    outputBuffers: new Map(),
    outputRows: new Map(),
    outputVersion: 1,
    stageNameOf: (key: string) =>
      ({ 'si-cap': 'intent-capture', 'si-req': 'requirements-analysis' })[key] ?? key,
    ensureOutputs: vi.fn(),
    outputPaneStatus: () => 'seeded',
    setPaneVisible: vi.fn(),
    hasEarlierOutput: () => false,
    loadEarlierOutput: vi.fn(),
  }),
}));
vi.mock('@/components/discussion', () => ({
  DiscussionPanel: () => <div />,
  useDiscussions: () => ({
    discussions: [],
    isOpen: false,
    activeDiscussion: null,
    members: mocks.members,
  }),
}));
vi.mock('@/components/discussion/DiscussionsTab', () => ({
  DiscussionsTab: () => <div />,
}));

import { IntentActivityPanel } from './IntentActivityPanel';

let seq = 0;
const ev = (
  type: string,
  summary: string,
  extra: Partial<IntentActivityEvent> = {},
): IntentActivityEvent => {
  seq += 1;
  return {
    eventId: `evt-${seq}`,
    type,
    stageInstanceId: null,
    actor: 'agentcore',
    summary,
    timestamp: `2026-07-18T10:${String(seq).padStart(2, '0')}:00Z`,
    ...extra,
  };
};

const BASE_EVENTS = (): IntentActivityEvent[] => [
  ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
  ev('v2.question.asked', 'Agent asked 1 question(s)', { stageInstanceId: 'si-cap' }),
  ev(
    'v2.stage.parked',
    'Stage intent-capture parked on question q-6b3fdecf-3b0c-4a71-a19e-39256ac2109e',
    {
      stageInstanceId: 'si-cap',
    },
  ),
  ev('v2.artifact.created', 'Artifact created: Intent Statement', { stageInstanceId: 'si-cap' }),
  ev('v2.artifact.created', 'Artifact created: Stakeholder Map', { stageInstanceId: 'si-cap' }),
  ev(
    'v2.git.pushed',
    'Engine committed + pushed work for intent-capture (eipasteur/retail-store-ui@95f1832d)',
    {
      stageInstanceId: 'si-cap',
    },
  ),
  ev('v2.stage.succeeded', 'Stage intent-capture succeeded', { stageInstanceId: 'si-cap' }),
  ev('v2.stage.validated', 'Stage intent-capture approved by human validation', {
    actor: 'orchestrator',
  }),
  ev('v2.stage.running', 'Stage requirements-analysis running', { stageInstanceId: 'si-req' }),
  ev(
    'v2.git.push_failed',
    'Engine push failed for requirements-analysis: eipasteur/retail-store-ui (push_failed: dlc/x (fetch first))',
    {
      stageInstanceId: 'si-req',
    },
  ),
];

describe('IntentActivityPanel Timeline tab', () => {
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    seq = 0;
    mocks.events = BASE_EVENTS();
    mocks.user = null;
    mocks.activityTabRequest = null;
    mocks.intentId = 'i1';
    mocks.members = [];
  });

  it('switches to the requested tab when the page asks for the Timeline (openTimeline)', async () => {
    const user = userEvent.setup();
    const view = render(<IntentActivityPanel onClose={() => {}} />);
    await user.click(screen.getByRole('tab', { name: /^Agent/ }));
    expect(screen.getByRole('tab', { name: /^Agent/ })).toHaveAttribute('aria-selected', 'true');

    mocks.activityTabRequest = { tab: 'timeline', seq: 1 };
    view.rerender(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByRole('tab', { name: /Timeline/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Requirements Analysis');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('2 events');
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('(2)');

    // The same tab requested again (new seq) still wins over a manual switch.
    await user.click(screen.getByRole('tab', { name: /^Agent/ }));
    mocks.activityTabRequest = { tab: 'timeline', seq: 2 };
    view.rerender(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByRole('tab', { name: /Timeline/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('groups events by stage, newest stage open, earlier stages collapsed with counts', async () => {
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);

    const latest = screen.getByRole('button', { name: /Requirements Analysis/ });
    expect(latest).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Stage Requirements Analysis started')).toBeInTheDocument();
    expect(screen.getByText('Push to retail-store-ui failed')).toBeInTheDocument();

    const earlier = screen.getByRole('button', { name: 'Intent Capture' });
    expect(earlier).toHaveAttribute('aria-expanded', 'false');
    // N17: the count is spelled out under the title, never "(7)" beside it,
    // where it reads like an attempt number.
    expect(screen.getByText('7 events')).toBeInTheDocument();
    expect(earlier).not.toHaveTextContent('(7)');
    expect(screen.queryByText('Stage Intent Capture approved')).not.toBeInTheDocument();

    await user.click(earlier);
    expect(screen.getByText('Stage Intent Capture approved')).toBeInTheDocument();
    expect(screen.getByText('2 documents created')).toBeInTheDocument();
    expect(screen.getByText('Intent Statement, Stakeholder Map')).toBeInTheDocument();
    expect(screen.getByText('Agent asked 1 question')).toBeInTheDocument();
  });

  it('keeps UUIDs and SHAs out of sight until Details is opened', async () => {
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Intent Capture' }));

    expect(screen.queryByText(/95f1832d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/q-6b3fdecf/)).not.toBeInTheDocument();

    const pushed = screen.getByText('Work pushed to retail-store-ui').closest('.flex.gap-3.py-2')!;
    await user.click(within(pushed as HTMLElement).getByRole('button', { name: 'Details' }));
    expect(within(pushed as HTMLElement).getByText(/95f1832d/)).toBeInTheDocument();
    expect(within(pushed as HTMLElement).getByText('v2.git.pushed')).toBeInTheDocument();
  });

  it('filters to questions, documents or errors and hides stages without a match', async () => {
    const user = userEvent.setup();
    render(<IntentActivityPanel onClose={() => {}} />);

    // The chips are plain labels; only Errors carries a count, the one number
    // that asks for a look.
    for (const name of ['All', 'Questions', 'Documents']) {
      expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('radio', { name: /^Errors\s*\d+$/ })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Questions/ }));
    expect(screen.queryByRole('button', { name: /Requirements Analysis/ })).not.toBeInTheDocument();
    expect(screen.getByText('Agent asked 1 question')).toBeInTheDocument();
    expect(screen.queryByText('2 documents created')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Documents/ }));
    expect(screen.getByText('2 documents created')).toBeInTheDocument();
    expect(screen.queryByText('Agent asked 1 question')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Errors/ }));
    expect(screen.getByText('Push to retail-store-ui failed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Intent Capture/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /All/ }));
    expect(screen.getByRole('button', { name: 'Intent Capture' })).toBeInTheDocument();
    expect(screen.getByText('7 events')).toBeInTheDocument();
  });

  it('announces new events without moving a reader who scrolled down', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<IntentActivityPanel onClose={() => {}} />);
    const scroller = screen.getByTestId('timeline-scroll');
    Object.defineProperty(scroller, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    });
    scroller.dispatchEvent(new Event('scroll'));

    mocks.events = [
      ...mocks.events,
      ev('v2.question.asked', 'Agent asked 2 question(s)', { stageInstanceId: 'si-req' }),
      ev('v2.stage.parked', 'Stage requirements-analysis parked on question q-1', {
        stageInstanceId: 'si-req',
      }),
    ];
    rerender(<IntentActivityPanel onClose={() => {}} />);

    expect(screen.queryByText('Agent asked 2 questions')).not.toBeInTheDocument();
    const pill = screen.getByRole('button', { name: '2 new events' });
    expect(scroller.scrollTop).toBe(400);

    await user.click(pill);
    expect(screen.getByText('Agent asked 2 questions')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new events/ })).not.toBeInTheDocument();
  });

  it("shows the next intent's events, not the previous ones, after switching while scrolled down", () => {
    mocks.events = [
      ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
      ev('v2.artifact.created', 'Artifact created: Alpha Brief', { stageInstanceId: 'si-cap' }),
    ];
    const { rerender } = render(<IntentActivityPanel onClose={() => {}} />);
    const scroller = screen.getByTestId('timeline-scroll');
    Object.defineProperty(scroller, 'scrollTop', {
      value: 400,
      writable: true,
      configurable: true,
    });
    scroller.dispatchEvent(new Event('scroll'));

    // The shell keeps the panel mounted across intent navigation; B has more events.
    mocks.intentId = 'i2';
    mocks.events = [
      ev('v2.stage.running', 'Stage requirements-analysis running', { stageInstanceId: 'si-req' }),
      ev('v2.question.asked', 'Agent asked 2 question(s)', { stageInstanceId: 'si-req' }),
      ev('v2.artifact.created', 'Artifact created: Beta Brief', { stageInstanceId: 'si-req' }),
    ];
    rerender(<IntentActivityPanel onClose={() => {}} />);

    expect(screen.getByText('Stage Requirements Analysis started')).toBeInTheDocument();
    expect(screen.getByText('Agent asked 2 questions')).toBeInTheDocument();
    expect(screen.queryByText('Stage Intent Capture started')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new events?/ })).not.toBeInTheDocument();
  });

  it('shows new events immediately when the reader is at the top', () => {
    const { rerender } = render(<IntentActivityPanel onClose={() => {}} />);
    mocks.events = [
      ...mocks.events,
      ev('v2.question.asked', 'Agent asked 2 question(s)', { stageInstanceId: 'si-req' }),
    ];
    rerender(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByText('Agent asked 2 questions')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new events/ })).not.toBeInTheDocument();
  });

  it('does not put a raw event count on the Timeline tab', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByRole('tab', { name: /Timeline/ })).toHaveTextContent(/^Timeline$/);
  });

  it('shows a filtered empty state with a way back', async () => {
    const user = userEvent.setup();
    mocks.events = [
      ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
    ];
    render(<IntentActivityPanel onClose={() => {}} />);
    await user.click(screen.getByRole('radio', { name: /Errors/ }));
    expect(screen.getByText('No errors in this run')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all events' }));
    expect(screen.getByText('Stage Intent Capture started')).toBeInTheDocument();
  });

  it('names the signed-in user "you" and keeps the e-mail in Details', async () => {
    const user = userEvent.setup();
    mocks.user = { userId: 'sub-hector', email: 'hectorsy@amazon.fr' };
    mocks.events = [ev('v2.execution.cancelled', 'Run cancelled', { actor: 'hectorsy@amazon.fr' })];
    render(<IntentActivityPanel onClose={() => {}} />);
    const line = screen.getByText('Run cancelled by you');
    expect(screen.queryByText(/hectorsy@amazon\.fr/)).not.toBeInTheDocument();
    const row = line.closest('.flex.gap-3.py-2') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Details' }));
    expect(within(row).getByText('hectorsy@amazon.fr')).toBeInTheDocument();
  });

  it("names a space member from the page's member list", () => {
    mocks.members = [{ userId: 'sub-jerome', email: 'jerome.vdl@example.com' }];
    mocks.events = [ev('v2.execution.cancelled', 'Run cancelled', { actor: 'sub-jerome' })];
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByText('Run cancelled by Jerome Vdl')).toBeInTheDocument();
  });

  it('lets a long stage name wrap instead of truncating it', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    const title = screen.getByText('Requirements Analysis', { selector: 'span' });
    expect(title).toHaveClass('whitespace-normal');
  });

  // N10: the unit lane under a stage title is the unit's readable name; the
  // slug only appears in an event's Details.
  it('names the unit lane of a per-unit stage instead of showing its slug', async () => {
    const user = userEvent.setup();
    mocks.events = [
      ev('v2.stage.running', 'Stage intent-capture running', {
        stageInstanceId: 'si-cap',
        unitSlug: 'cart-badge-template',
      }),
    ];
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByText('Unit Cart Badge Template · 1 event')).toBeInTheDocument();
    expect(screen.queryByText(/cart-badge-template/)).not.toBeInTheDocument();

    const item = screen.getByText('Stage Intent Capture started').closest('.flex.gap-3.py-2')!;
    await user.click(within(item as HTMLElement).getByRole('button', { name: 'Details' }));
    expect(within(item as HTMLElement).getByText('cart-badge-template')).toBeInTheDocument();
  });

  it('marks a stage that ran again with its attempt instead of repeating the name', () => {
    mocks.events = [
      ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
      ev('v2.stage.reset', 'Stage intent-capture reset for rewind (attempt 2)', {
        stageInstanceId: 'si-cap',
      }),
      ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
    ];
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(
      screen.getByRole('button', { name: /^Intent Capture\s*· attempt 2$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Attempt 2 · 1 event')).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+\)/)).not.toBeInTheDocument();
  });
});
