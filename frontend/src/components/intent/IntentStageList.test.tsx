import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { IntentStageList } from './IntentStageList';

const mocks = vi.hoisted(() => ({
  rewindIntent: vi.fn(),
  setSelectedStageId: vi.fn(),
}));

type Globals = {
  intentStageRows?: unknown[];
  intentStageDetail?: unknown;
  intentCompiled?: unknown;
  intentArtifactsByStage?: Map<string, unknown[]>;
  intentSensorsByStage?: Map<string, unknown[]>;
  intentSelectedStageId?: string | null;
  intentLastActivityAt?: string | null;
  intentPhaseNames?: Record<string, string>;
  intentGates?: unknown[];
};
const g = globalThis as Globals;

vi.mock('@/contexts/IntentContext', () => ({
  stageRowKey: (row: { stageId: string; stageInstanceId: string | null }) =>
    row.stageInstanceId ?? row.stageId,
  useIntent: () => ({
    intentId: 'intent-1',
    stageRows: g.intentStageRows ?? [],
    detail: g.intentStageDetail ?? {
      intent: { status: 'FAILED', currentStage: null },
    },
    compiled: g.intentCompiled ?? null,
    workflowPhases: null,
    initializationPhasePaths: new Set<string>(),
    stageEdges: [],
    gates: g.intentGates ?? [],
    lastActivityAt: g.intentLastActivityAt ?? null,
    outputBuffers: new Map(),
    selectedStageId: g.intentSelectedStageId ?? null,
    setSelectedStageId: mocks.setSelectedStageId,
    sensorsByStage: g.intentSensorsByStage ?? new Map(),
    artifactsByStage: g.intentArtifactsByStage ?? new Map(),
    phaseNameOf: (phase: string) => {
      const name = g.intentPhaseNames?.[phase] ?? phase;
      return name.charAt(0).toUpperCase() + name.slice(1);
    },
    rewindIntent: mocks.rewindIntent,
    mayControlStage: () => true,
    focusOutput: vi.fn(),
    openArtifactPreview: vi.fn(),
  }),
}));

const row = (
  state: 'RUNNING' | 'WAITING_FOR_HUMAN' | 'FAILED' | 'SUCCEEDED' | 'PENDING',
  over: Record<string, unknown> = {},
) => ({
  stageId: 'build-stage',
  phase: 'build',
  state,
  stageInstanceId: 'build-stage-instance',
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
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  g.intentStageRows = [];
  g.intentStageDetail = { intent: { status: 'FAILED', currentStage: null }, metrics: [] };
  g.intentCompiled = null;
  g.intentArtifactsByStage = new Map();
  g.intentSensorsByStage = new Map();
  g.intentSelectedStageId = null;
  g.intentLastActivityAt = null;
  g.intentPhaseNames = undefined;
  g.intentGates = [];
});

describe('IntentStageList', () => {
  it.each([
    ['waiting', 'WAITING_FOR_HUMAN' as const],
    ['failed', 'FAILED' as const],
  ])('does not ping a %s phase', (_label, state) => {
    g.intentStageRows = [row(state)];

    const { container } = render(<IntentStageList />);

    expect(container.querySelector('.animate-ping')).not.toBeInTheDocument();
    if (state === 'WAITING_FOR_HUMAN') {
      expect(screen.getByLabelText('Waiting for a response')).toBeInTheDocument();
    } else {
      expect(screen.getByLabelText('Phase has a failed stage')).toBeInTheDocument();
    }
  });

  it('reads a parked stage\'s wait as an age ("110 days"), not a stopwatch ("110d 19h") — one grammar with the header (R3-17)', () => {
    const DAY = 86_400_000;
    const parkedAt = new Date(Date.now() - 110 * DAY - 19 * 3_600_000).toISOString();
    g.intentStageRows = [
      row('WAITING_FOR_HUMAN', {
        startedAt: new Date(Date.now() - 111 * DAY).toISOString(),
        parkedAt,
      }),
      row('SUCCEEDED', {
        stageId: 'done-stage',
        stageInstanceId: 'si-done',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-03T02:00:00Z',
      }),
    ];
    render(<IntentStageList />);
    expect(screen.getByText('110 days')).toBeInTheDocument();
    expect(screen.queryByText(/^11[01]d \d+h$/)).toBeNull();
    // How long a finished stage took is in its detail, not on its row.
    expect(screen.queryByText('2d 2h')).toBeNull();
  });

  // D6: what is open follows the run. The stage that needs the reader shows
  // its detail without a click; finished stages stay folded.
  it('opens the waiting stage by default, without scrolling to it, and keeps it folded once folded', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    g.intentStageRows = [
      row('SUCCEEDED', { stageId: 'reverse-engineering', stageInstanceId: 'si-re' }),
      row('FAILED', { stageId: 'code-generation', stageInstanceId: 'si-cg' }),
      row('WAITING_FOR_HUMAN', { stageId: 'requirements-analysis', stageInstanceId: 'si-ra' }),
    ];
    g.intentArtifactsByStage = new Map([
      ['si-ra', [{ id: 'a1', title: 'Requirements', supersededAt: null }]],
    ]);
    g.intentStageDetail = { intent: { status: 'WAITING', currentStage: null }, metrics: [] };

    render(<IntentStageList />);

    const waiting = screen.getByRole('button', { name: /^Requirements Analysis/ });
    expect(waiting).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Recorded documents' })).toBeVisible();
    expect(screen.getByRole('button', { name: /^Reverse Engineering/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: /^Code Generation/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(scrollIntoView).not.toHaveBeenCalled();

    await userEvent.click(waiting);
    expect(waiting).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Recorded documents' })).not.toBeInTheDocument();
  });

  // I3 (staging): Scope Definition still parked with its question answered,
  // Feasibility parked on the open question. The open question's stage opens.
  it('opens the waiting stage with an open question before one whose questions were answered (I3)', () => {
    const DAY = 86_400_000;
    g.intentStageRows = [
      row('WAITING_FOR_HUMAN', {
        stageId: 'scope-definition',
        stageInstanceId: 'si-scope',
        phase: 'ideation',
        parkedAt: new Date(Date.now() - 137 * DAY).toISOString(),
      }),
      row('WAITING_FOR_HUMAN', {
        stageId: 'feasibility',
        stageInstanceId: 'si-feas',
        phase: 'ideation',
        parkedAt: new Date(Date.now() - 109 * DAY).toISOString(),
      }),
    ];
    g.intentGates = [
      { humanTaskId: 'q-scope', kind: 'question', stageInstanceId: 'si-scope', status: 'answered' },
      { humanTaskId: 'q-feas', kind: 'question', stageInstanceId: 'si-feas', status: 'pending' },
    ];
    g.intentStageDetail = {
      intent: { status: 'WAITING', currentStage: 'feasibility', pendingHumanTaskId: 'q-feas' },
      metrics: [],
    };

    render(
      <MemoryRouter>
        <IntentStageList />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: /^Feasibility/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: /^Scope Definition/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens no stage of a run that finished', () => {
    g.intentStageRows = [
      row('SUCCEEDED', { stageId: 'reverse-engineering', stageInstanceId: 'si-re' }),
      row('SUCCEEDED', { stageId: 'requirements-analysis', stageInstanceId: 'si-ra' }),
    ];
    g.intentStageDetail = { intent: { status: 'SUCCEEDED', currentStage: null }, metrics: [] };

    render(<IntentStageList />);

    // The phase itself is folded: no stage row is on screen until it is opened.
    expect(screen.getByRole('button', { name: /^Build/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('button', { name: /^Reverse Engineering/ })).not.toBeInTheDocument();
  });

  it('uses a separate native retry button and reports retry failure', async () => {
    mocks.rewindIntent.mockRejectedValueOnce(new Error('service unavailable'));
    g.intentStageRows = [row('FAILED')];

    render(<IntentStageList />);

    // The failed stage is open by default and offers Retry in its detail; the
    // row's own retry button is for a folded row.
    expect(screen.getByRole('button', { name: 'Retry stage' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry stage Build Stage' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Build Stage/ }));

    const retry = screen.getByRole('button', { name: 'Retry stage Build Stage' });
    expect(retry.closest('button')).toBe(retry);
    await userEvent.click(retry);

    expect(mocks.rewindIntent).toHaveBeenCalledWith('build-stage');
    expect(await screen.findByRole('alert')).toHaveTextContent('service unavailable');
  });

  it('reserves the phase ping for a running stage', () => {
    g.intentStageRows = [row('RUNNING')];

    const { container } = render(<IntentStageList />);

    expect(container.querySelector('.animate-ping')).toBeInTheDocument();
  });

  // O4 / T3 / T5: the row is a human name plus the shared status pill.
  it('labels the row with the human stage name and the registry status, red when failed', () => {
    g.intentStageRows = [
      row('SUCCEEDED', { stageId: 'reverse-engineering', stageInstanceId: 'si-re' }),
      row('FAILED', { stageId: 'requirements-analysis', stageInstanceId: 'si-ra' }),
    ];

    render(<IntentStageList />);

    const done = screen.getByRole('button', { name: /^Reverse Engineering/ });
    expect(done).not.toHaveTextContent('reverse-engineering');
    expect(within(done).getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Succeeded')).not.toBeInTheDocument();

    const failed = screen.getByRole('button', { name: /^Requirements Analysis/ });
    const pill = within(failed).getByText('Failed').closest('[data-tone]');
    expect(pill).toHaveAttribute('data-tone', 'danger');
  });

  // O4 / D6: a folded row carries one fact about what the stage produced; the
  // model, tokens and cost are in its detail.
  it('gives a finished stage one fact on its row and keeps usage for its detail', () => {
    g.intentStageRows = [
      row('SUCCEEDED', { stageId: 'reverse-engineering', stageInstanceId: 'si-re' }),
      row('WAITING_FOR_HUMAN', { stageId: 'requirements-analysis', stageInstanceId: 'si-ra' }),
    ];
    g.intentArtifactsByStage = new Map([
      [
        'si-re',
        [
          { id: 'a1', title: 'Architecture — Retail Store', supersededAt: null },
          { id: 'a2', title: 'Code Structure — Retail Store', supersededAt: null },
          { id: 'old', title: 'Old', supersededAt: '2026-01-01T00:00:00Z' },
        ],
      ],
    ]);
    g.intentStageDetail = {
      intent: { status: 'WAITING', currentStage: null },
      metrics: [
        {
          stageInstanceId: 'si-re',
          model: 'us.anthropic.claude-opus-4-6-v1',
          metrics: { tokensInput: 27, tokensOutput: 2000, tokensCacheRead: 150_000 },
          timestamp: '2026-01-01T00:00:00Z',
          cost: { totalCost: 0.03, currency: 'USD', priced: true },
        },
      ],
    };

    render(<IntentStageList />);

    const rowButton = screen.getByRole('button', { name: /^Reverse Engineering/ });
    expect(rowButton).toHaveTextContent('2 documents');
    expect(rowButton).not.toHaveTextContent(/Claude|tokens|\$0\.03|us\.anthropic/);
    expect(screen.queryByText('Claude Opus 4.6')).not.toBeInTheDocument();
  });

  // T5: one denominator — in-scope stages — with the rest findable but folded.
  it('counts only in-scope stages and folds the others under one collapsed row', async () => {
    g.intentStageRows = [
      row('SUCCEEDED', { stageId: 'reverse-engineering', stageInstanceId: 'si-re', phase: '02' }),
      row('PENDING', { stageId: 'requirements-analysis', stageInstanceId: null, phase: '02' }),
    ];
    g.intentStageDetail = {
      intent: { status: 'WAITING', currentStage: null, scope: 'bugfix' },
      metrics: [],
    };
    g.intentCompiled = {
      scopeGrid: {
        bugfix: {
          'reverse-engineering': 'EXECUTE',
          'requirements-analysis': 'EXECUTE',
          'user-stories': 'SKIP',
          'domain-model': 'SKIP',
        },
      },
      graph: {
        nodes: [
          { stageId: 'reverse-engineering', phasePath: '02', order: 1 },
          { stageId: 'requirements-analysis', phasePath: '02', order: 2 },
          { stageId: 'user-stories', phasePath: '02', order: 3 },
          { stageId: 'domain-model', phasePath: '02', order: 4 },
        ],
        edges: [],
      },
    };

    render(<IntentStageList />);

    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.queryByText('1/4')).not.toBeInTheDocument();
    const fold = screen.getByRole('button', { name: /2 stages not selected/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('User Stories')).not.toBeInTheDocument();

    await userEvent.click(fold);
    expect(screen.getByText('User Stories')).toBeInTheDocument();
    expect(screen.getByText('Domain Model')).toBeInTheDocument();
  });

  // T3: a run that failed before its stage row existed still shows where.
  it('marks the stage named by the failure event as failed when no row carries FAILED', () => {
    g.intentStageRows = [
      row('SUCCEEDED', { stageId: 'state-init', stageInstanceId: 'si-init', phase: '00' }),
      row('PENDING', { stageId: 'reverse-engineering', stageInstanceId: null, phase: '02' }),
      row('PENDING', { stageId: 'requirements-analysis', stageInstanceId: null, phase: '02' }),
    ];
    g.intentStageDetail = {
      intent: { status: 'FAILED', currentStage: 'state-init', failureReason: 'not_implemented' },
      metrics: [],
      events: [
        { eventId: 'e1', type: 'stage_succeeded', summary: 'Stage state-init succeeded' },
        {
          eventId: 'e2',
          type: 'intent_failed',
          summary: 'stage_failed: reverse-engineering: not_implemented: mode pipeline',
        },
      ],
    };

    render(<IntentStageList />);

    const failed = screen.getByRole('button', { name: /^Reverse Engineering/ });
    expect(within(failed).getByText('Failed').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'danger',
    );
    // The failed stage is open: its detail explains the failure in plain words
    // and keeps the raw code behind the technical details.
    expect(failed).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText('This stage uses a mode this platform version does not support yet.'),
    ).toBeInTheDocument();
    expect(failed).not.toHaveTextContent('not_implemented');
    expect(failed).not.toHaveTextContent('stage_failed');
    expect(screen.getByLabelText('Phase has a failed stage')).toBeInTheDocument();
    expect(screen.getAllByText('Failed')).toHaveLength(1);
  });

  // I5: a rewind bumps `attempt` on every reset row, including stages that
  // never ran. "Attempt 3 · Not started" is a contradiction; only a stage that
  // actually ran shows its attempt (in its detail, not as a badge on the row),
  // and the stage the stalled engine is on says so with a date instead of
  // "Not started".
  it('shows attempts only for stages that ran and names the stalled stage with its date', async () => {
    g.intentStageRows = [
      row('PENDING', {
        stageId: 'workspace-scaffold',
        stageInstanceId: 'si-ws',
        phase: '01',
        attempt: 3,
      }),
      row('PENDING', {
        stageId: 'intent-capture',
        stageInstanceId: 'si-ic',
        phase: '02',
        attempt: 3,
      }),
      row('FAILED', {
        stageId: 'market-research',
        stageInstanceId: 'si-mr',
        phase: '02',
        attempt: 2,
        startedAt: '2026-07-21T23:40:00.000Z',
        completedAt: '2026-07-21T23:41:00.000Z',
      }),
    ];
    g.intentStageDetail = {
      intent: {
        status: 'RUNNING',
        currentStage: 'intent-capture',
        updatedAt: '2026-07-21T23:46:07.296Z',
        createdAt: '2026-07-21T23:09:45.595Z',
      },
      metrics: [],
      events: [],
    };
    g.intentLastActivityAt = '2026-07-22T01:46:55.019Z';
    g.intentPhaseNames = { '01': 'initialization', '02': 'ideation' };

    render(<IntentStageList />);

    // The phase holding the stalled stage opens by itself; the rest stays folded.
    expect(screen.getByRole('button', { name: /^Initialization/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: /^Initialization/ }));
    const scaffold = screen.getByRole('button', { name: /^Workspace Scaffold/ });
    expect(scaffold).not.toHaveTextContent('Attempt');
    expect(within(scaffold).getByText('Not started')).toBeInTheDocument();

    const stalled = screen.getByRole('button', { name: /^Intent Capture/ });
    expect(stalled).not.toHaveTextContent('Attempt');
    expect(stalled).not.toHaveTextContent('Not started');
    const pill = within(stalled).getByText('Stalled since 22 Jul 2026').closest('[data-tone]');
    expect(pill).toHaveAttribute('data-tone', 'warning');

    const ran = screen.getByRole('button', { name: /^Market Research/ });
    expect(ran).not.toHaveTextContent('Attempt');
    expect(ran).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Attempt 2')).toBeInTheDocument();
  });

  // 5f3847ee: live rows outside the plan arrive in arbitrary order, so one
  // phase can appear twice ("Initialization · Ideation · Initialization").
  it('merges non-contiguous rows of one phase into a single group', () => {
    g.intentStageRows = [
      row('PENDING', { stageId: 'workspace-detection', stageInstanceId: 'si-1', phase: '01' }),
      row('PENDING', { stageId: 'workspace-scaffold', stageInstanceId: 'si-2', phase: '01' }),
      row('PENDING', { stageId: 'intent-capture', stageInstanceId: 'si-3', phase: '02' }),
      row('PENDING', { stageId: 'state-init', stageInstanceId: 'si-4', phase: '01' }),
    ];
    g.intentPhaseNames = { '01': 'initialization', '02': 'ideation' };
    g.intentStageDetail = {
      intent: { status: 'RUNNING', currentStage: 'intent-capture' },
      metrics: [],
      events: [],
    };

    render(<IntentStageList />);

    const headers = screen.getAllByRole('button', { name: /^(Initialization|Ideation)/ });
    expect(headers.map((h) => h.textContent)).toEqual([
      expect.stringMatching(/^Initialization0\/3/),
      expect.stringMatching(/^Ideation0\/1/),
    ]);
    // Phase headers read in sentence case, not uppercase microtext.
    expect(screen.getByText('Initialization')).not.toHaveClass('uppercase');
  });

  // O6: the dependency graph is one action away from the list, not a toggle
  // that persists across intents.
  it('offers the stage dependency graph from the list', () => {
    g.intentStageRows = [row('SUCCEEDED')];

    render(<IntentStageList />);

    expect(screen.getByRole('button', { name: 'View stage dependencies' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores failure evidence from before the latest rewind and never overrides a settled row', () => {
    g.intentStageRows = [
      row('SUCCEEDED', { stageId: 'reverse-engineering', stageInstanceId: 'si-re', phase: '02' }),
      row('PENDING', { stageId: 'requirements-analysis', stageInstanceId: null, phase: '02' }),
    ];
    g.intentStageDetail = {
      intent: { status: 'FAILED', currentStage: null, failureReason: 'not_implemented' },
      metrics: [],
      events: [
        {
          eventId: 'e1',
          type: 'v2.execution.failed',
          summary: 'stage_failed: requirements-analysis: agent_crashed: old run',
        },
        { eventId: 'e2', type: 'v2.execution.rewound', summary: 'Ana retried the run' },
        {
          eventId: 'e3',
          type: 'v2.execution.failed',
          summary: 'stage_failed: reverse-engineering: agent_crashed: stale lane',
        },
      ],
    };

    render(<IntentStageList />);

    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(screen.queryByText(/old run/)).not.toBeInTheDocument();
    expect(screen.queryByText(/stale lane/)).not.toBeInTheDocument();
  });

  it('marks only the lane named by the failure, and no lane when it is ambiguous', () => {
    const lanes = () => [
      row('PENDING', { stageId: 'code-generation', stageInstanceId: 'si-a', unitSlug: 'unit-a' }),
      row('PENDING', { stageId: 'code-generation', stageInstanceId: 'si-b', unitSlug: 'unit-b' }),
    ];
    g.intentStageRows = lanes();
    g.intentStageDetail = {
      intent: { status: 'FAILED', currentStage: null },
      metrics: [],
      events: [
        {
          eventId: 'e1',
          type: 'v2.execution.failed',
          unitSlug: 'unit-b',
          stageInstanceId: null,
          summary: 'stage_failed: code-generation: agent_crashed: lane b',
        },
      ],
    };

    const { unmount } = render(<IntentStageList />);
    expect(screen.getAllByText('Failed')).toHaveLength(1);
    const laneB = screen.getByText('Unit B').parentElement!.parentElement!;
    expect(within(laneB).getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText(/lane b/)).not.toBeInTheDocument();
    unmount();

    g.intentStageRows = lanes();
    g.intentStageDetail = {
      intent: {
        status: 'FAILED',
        currentStage: null,
        failure: { code: 'stage_failed', message: 'stage_failed: code-generation: agent_crashed' },
      },
      metrics: [],
      events: [],
    };
    render(<IntentStageList />);
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  // Audit → Overview: the selected stage may live in a completed (folded) phase.
  it('opens the phase holding a selected completed stage and scrolls its detail into view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    g.intentStageRows = [
      row('SUCCEEDED', { stageId: 'reverse-engineering', stageInstanceId: 'si-re', phase: '02' }),
      row('RUNNING', { stageId: 'code-generation', stageInstanceId: 'si-cg', phase: '03' }),
    ];
    g.intentArtifactsByStage = new Map([
      ['si-re', [{ id: 'a1', title: 'Architecture', supersededAt: null }]],
    ]);
    g.intentStageDetail = { intent: { status: 'RUNNING', currentStage: null }, metrics: [] };
    g.intentSelectedStageId = 'si-re';

    render(<IntentStageList />);

    expect(screen.getByRole('button', { name: /^Reverse Engineering/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Recorded documents' })).toBeVisible();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  // AU2 / D6: a folded row flags only a check that holds the stage; an
  // advisory miss is named in the stage detail, not counted on the row.
  it('flags a blocking check on a folded row and names an advisory miss only in the detail', () => {
    g.intentStageRows = [
      row('WAITING_FOR_HUMAN', { stageId: 'reverse-engineering', stageInstanceId: 'si-re' }),
      row('FAILED', { stageId: 'build-and-test', stageInstanceId: 'si-bt' }),
    ];
    g.intentSensorsByStage = new Map([
      [
        'si-re',
        [
          {
            sensorRunId: 'sr-1',
            stageInstanceId: 'si-re',
            sensorId: 'upstream-coverage',
            result: 'INCONCLUSIVE',
            severity: 'advisory',
            held: false,
            detail: { reason: 'no upstream found' },
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
      ],
      [
        'si-bt',
        [
          {
            sensorRunId: 'sr-2',
            stageInstanceId: 'si-bt',
            sensorId: 'type-check',
            result: 'FAIL',
            severity: 'blocking',
            held: true,
            detail: null,
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
      ],
    ]);

    render(<IntentStageList />);

    expect(screen.queryByText(/advisory check/)).not.toBeInTheDocument();
    // The waiting stage is open: its detail names the advisory miss.
    expect(screen.getByText('Checks needing attention')).toBeInTheDocument();
    expect(screen.getByText('Upstream Coverage')).toBeInTheDocument();
    const blocking = screen.getByText('1 blocking check');
    expect(blocking.closest('[data-tone]')).toHaveAttribute('data-tone', 'danger');
  });
});
