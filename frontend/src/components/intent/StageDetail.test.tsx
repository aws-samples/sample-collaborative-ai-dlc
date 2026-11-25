import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { StageDetail } from './StageDetail';

const mocks = vi.hoisted(() => ({
  openArtifactPreview: vi.fn(),
  rewindIntent: vi.fn(),
}));

type Globals = {
  intentDetail?: unknown;
  intentStageEdges?: unknown[];
  stageArtifacts?: unknown[];
  sensorDetail?: unknown;
  stageGates?: unknown[];
};
const g = globalThis as Globals;

vi.mock('@/contexts/IntentContext', () => ({
  stageRowKey: (row: { stageId: string; stageInstanceId: string | null }) =>
    row.stageInstanceId ?? row.stageId,
  useIntent: () => ({
    projectId: 'p1',
    intentId: 'i1',
    detail: g.intentDetail ?? null,
    mayControlStage: () => true,
    stageEdges: g.intentStageEdges ?? [],
    stageRows: [],
    gates: g.stageGates ?? [],
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
            detail: g.sensorDetail ?? null,
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      ],
    ]),
    artifactsByStage: new Map([['instance-1', g.stageArtifacts ?? []]]),
    outputBuffers: new Map(),
    setSelectedStageId: vi.fn(),
    focusOutput: vi.fn(),
    openArtifactPreview: mocks.openArtifactPreview,
    rewindIntent: mocks.rewindIntent,
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
    explanation: 'b.ts: type error on b',
  },
  {
    name: 'an earlier timeout',
    detail: {
      files: [
        { file: 'a.ts', result: 'INCONCLUSIVE', timedOut: true, detail: null },
        { file: 'b.ts', result: 'FAIL', detail: { reason: 'explained failure on b' } },
      ],
    },
    explanation: 'b.ts: explained failure on b',
  },
] as const;

const detailsButton = () => screen.getByRole('button', { name: /^Details/ });

beforeEach(() => {
  vi.clearAllMocks();
  g.intentDetail = null;
  g.intentStageEdges = [];
  g.stageArtifacts = [];
  g.sensorDetail = null;
  g.stageGates = [];
});

describe('StageDetail', () => {
  it('shows recorded artifacts from this stage without their shared suffix, expands the short list, and labels superseded history', async () => {
    const artifact = (id: string, supersededAt: string | null = null) => ({
      id,
      title: `Document ${id} — Retail Store Sample Application`,
      artifactType: 'design-document',
      createdByStageInstanceId: 'instance-1',
      supersededAt,
    });
    g.stageArtifacts = [
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => artifact(`doc-${n}`)),
      artifact('old-doc', '2026-01-02T00:00:00Z'),
    ];

    render(<StageDetail row={row} />);

    const documents = screen.getByRole('region', { name: 'Recorded documents' });
    expect(within(documents).getAllByRole('button', { name: /^Document doc-\d$/ })).toHaveLength(6);
    expect(documents).toHaveTextContent('Retail Store Sample Application');
    expect(within(documents).getAllByText(/Retail Store Sample Application/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Show 1 more document' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more document' }));
    expect(screen.getAllByRole('button', { name: /^Document doc-\d$/ })).toHaveLength(7);
    await userEvent.click(detailsButton());
    expect(screen.getByText('Superseded document history')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Document old-doc/ })).toHaveTextContent(
      'superseded',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Document doc-1' }));
    expect(mocks.openArtifactPreview).toHaveBeenCalledWith('doc-1');
  });

  it('does not treat a matching artifact from another stage as this stage output', async () => {
    g.intentDetail = {
      intent: { status: 'FAILED' },
      artifacts: [
        {
          id: 'upstream-document',
          title: 'Upstream document',
          artifactType: 'design-document',
          createdByStageInstanceId: 'another-instance',
        },
      ],
      metrics: [],
    };
    g.intentStageEdges = [
      { from: 'type-check', to: 'next-stage', kind: 'data', artifact: 'design-document' },
    ];

    render(<StageDetail row={row} />);

    expect(screen.queryByRole('region', { name: 'Recorded documents' })).not.toBeInTheDocument();
    await userEvent.click(detailsButton());
    expect(screen.getByText('Planned outputs')).toBeInTheDocument();
    expect(screen.getByText('Design Document')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upstream document/ })).not.toBeInTheDocument();
    expect(mocks.openArtifactPreview).not.toHaveBeenCalled();
  });

  // O4: readable model, labelled token parts, a Total that adds information.
  // D6: model, tokens and cost are history; the stage shows them on demand.
  it('keeps this stage instance model, token usage and cost under Details', async () => {
    g.intentDetail = {
      intent: { status: 'FAILED' },
      metrics: [
        {
          stageInstanceId: 'instance-1',
          model: 'us.anthropic.claude-sonnet-4-6',
          metrics: { tokensInput: 1200, tokensOutput: 300, promptBytes: 2048 },
          timestamp: '2026-01-01T00:00:00Z',
          cost: { totalCost: 0.42, currency: 'USD', priced: true },
        },
        {
          stageInstanceId: 'another-instance',
          model: 'unrelated-model',
          metrics: { tokensInput: 99_000, tokensOutput: 88_000 },
          timestamp: '2026-01-01T00:00:00Z',
          cost: { totalCost: 9, currency: 'USD', priced: true },
        },
      ],
    };

    render(<StageDetail row={{ ...row, cli: 'claude', resolvedModel: 'planned-model' }} />);

    expect(screen.queryByRole('region', { name: 'Recorded execution' })).not.toBeInTheDocument();
    expect(screen.queryByText('$0.42')).not.toBeInTheDocument();
    expect(detailsButton()).toHaveAccessibleDescription(/Usage/);
    await userEvent.click(detailsButton());

    const execution = screen.getByRole('region', { name: 'Recorded execution' });
    expect(within(execution).getByText('Claude Sonnet 4.6')).toBeInTheDocument();
    expect(execution).not.toHaveTextContent('us.anthropic');
    expect(within(execution).queryByText('planned-model')).not.toBeInTheDocument();
    expect(screen.queryByText('unrelated-model')).not.toBeInTheDocument();
    expect(within(execution).getByText('Input')).toBeInTheDocument();
    expect(within(execution).getByText('1.2K')).toBeInTheDocument();
    expect(within(execution).getByText('Output')).toBeInTheDocument();
    expect(within(execution).getByText('300')).toBeInTheDocument();
    expect(within(execution).getByText('Total')).toBeInTheDocument();
    expect(within(execution).getByText('1.5K')).toBeInTheDocument();
    expect(within(execution).getByText('$0.42')).toBeInTheDocument();
    expect(screen.queryByText('88K')).not.toBeInTheDocument();
    expect(screen.queryByText('Assembled prompts')).not.toBeInTheDocument();
  });

  it('never shows a Total that reads the same as one of its parts', async () => {
    g.intentDetail = {
      intent: { status: 'FAILED' },
      metrics: [
        {
          stageInstanceId: 'instance-1',
          model: 'claude-opus-4-6',
          metrics: { tokensInput: 27, tokensOutput: 2000 },
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    };

    render(<StageDetail row={row} />);
    await userEvent.click(detailsButton());

    const execution = screen.getByRole('region', { name: 'Recorded execution' });
    expect(within(execution).getByText('27')).toBeInTheDocument();
    expect(within(execution).getByText('2.0K')).toBeInTheDocument();
    expect(within(execution).queryByText('Total')).not.toBeInTheDocument();
  });

  it('labels input as uncached and counts cache reads when the sample has them', async () => {
    g.intentDetail = {
      intent: { status: 'FAILED' },
      metrics: [
        {
          stageInstanceId: 'instance-1',
          model: 'claude-opus-4-6',
          metrics: { tokensInput: 27, tokensOutput: 2000, tokensCacheRead: 150_000 },
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    };

    render(<StageDetail row={row} />);
    await userEvent.click(detailsButton());

    const execution = screen.getByRole('region', { name: 'Recorded execution' });
    expect(within(execution).getByText('Uncached input')).toBeInTheDocument();
    expect(within(execution).getByText('Cache reads')).toBeInTheDocument();
    expect(within(execution).getByText('150.0K')).toBeInTheDocument();
    expect(within(execution).getByText('Total')).toBeInTheDocument();
    expect(within(execution).getByText('152.0K')).toBeInTheDocument();
  });

  // O5: restart is a stage action, confirmed in a dialog; details keep only wiring.
  it('offers Restart from this stage outside Details and confirms it in a dialog', async () => {
    mocks.rewindIntent.mockResolvedValueOnce(undefined);
    g.intentDetail = {
      intent: { status: 'FAILED' },
      metrics: [
        {
          stageInstanceId: 'instance-1',
          model: 'claude-sonnet',
          metrics: { tokensInput: 1200, tokensOutput: 300 },
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    };

    render(<StageDetail row={{ ...row, cli: 'claude', resolvedModel: 'planned-model' }} />);

    expect(detailsButton()).toHaveAttribute('aria-expanded', 'false');
    const restart = screen.getByRole('button', { name: 'Restart from this stage' });
    expect(restart).toBeVisible();
    expect(screen.queryByText('Runtime')).not.toBeInTheDocument();

    await userEvent.click(restart);
    const dialog = await screen.findByRole('alertdialog', { name: /Restart from Type Check/ });
    expect(dialog).toHaveTextContent(/every stage after it will run again/i);
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /what should change/i }),
      'Use the SQS queues',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));

    expect(mocks.rewindIntent).toHaveBeenCalledWith('type-check', 'Use the SQS queues');

    await userEvent.click(detailsButton());
    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Restart from this stage' })).toHaveLength(1);
  });

  it('shows the dialog error and keeps it open when the restart is refused', async () => {
    mocks.rewindIntent.mockRejectedValueOnce(new Error('run is still active'));
    g.intentDetail = { intent: { status: 'WAITING' }, metrics: [] };

    render(<StageDetail row={{ ...row, state: 'SUCCEEDED' }} />);

    await userEvent.click(screen.getByRole('button', { name: 'Restart from this stage' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('run is still active');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows absent usage fields as not available rather than zero', async () => {
    g.intentDetail = {
      intent: { status: 'FAILED' },
      metrics: [
        {
          stageInstanceId: 'instance-1',
          model: 'claude-sonnet',
          metrics: { tokensInput: 1200 },
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    };

    render(<StageDetail row={row} />);
    await userEvent.click(detailsButton());

    const execution = screen.getByRole('region', { name: 'Recorded execution' });
    expect(within(execution).getByText('1.2K')).toBeInTheDocument();
    expect(within(execution).getAllByText('Not available')).toHaveLength(2);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows an inline error when one-click retry fails', async () => {
    mocks.rewindIntent.mockRejectedValueOnce(new Error('retry denied'));
    g.intentDetail = { intent: { status: 'FAILED' }, metrics: [] };

    render(<StageDetail row={row} />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry stage' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('retry denied');
  });

  // O4/O5: gates read as a status, away from the action row.
  // D6: a stage with four gates used to show four pills ("Question · Answered"
  // twice, "Question · Withdrawn", "Question · Waiting for answer") beside a
  // three-part duration. By default: the one thing to do, and its action.
  it('shows one line and one action for the open question, and counts the earlier ones under Details', async () => {
    const DAY = 86_400_000;
    const gate = (humanTaskId: string, status: string) => ({
      humanTaskId,
      stageInstanceId: 'instance-1',
      kind: 'question',
      status,
      prompt: null,
      options: null,
    });
    g.stageGates = [
      gate('q-1', 'answered'),
      gate('q-2', 'answered'),
      gate('q-3', 'superseded'),
      gate('q-4', 'pending'),
    ];
    g.intentDetail = { intent: { status: 'WAITING' }, metrics: [] };

    render(
      <MemoryRouter>
        <StageDetail
          row={{
            ...row,
            state: 'WAITING_FOR_HUMAN',
            startedAt: new Date(Date.now() - 110 * DAY - 96_000).toISOString(),
            parkedAt: new Date(Date.now() - 110 * DAY).toISOString(),
          }}
          durationInHeading
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('1 question waiting for you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Answer' })).toHaveAttribute(
      'href',
      '/space/p1/intent/i1/review/q-4',
    );
    for (const pill of ['Answered', 'Withdrawn', 'Waiting for answer', 'Question']) {
      expect(screen.queryByText(pill)).not.toBeInTheDocument();
    }
    // The row heading carries the one duration; no split by default.
    expect(screen.queryByText(/active/)).not.toBeInTheDocument();
    expect(screen.queryByText(/110/)).not.toBeInTheDocument();

    const details = detailsButton();
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(details).toHaveAccessibleDescription('Timing · Earlier questions · Check history');
    await userEvent.click(details);
    expect(screen.getByText('2 answered · 1 withdrawn')).toBeInTheDocument();
    expect(screen.getByText(/1m 36s active, 110d \d+h waiting on answers/)).toBeInTheDocument();
  });

  // Two lanes parked at once: each lane's Answer opens its own question, not
  // the one the Work page would select first.
  it("opens this lane's question when two lanes wait at once", () => {
    const gate = (humanTaskId: string, stageInstanceId: string) => ({
      humanTaskId,
      stageInstanceId,
      kind: 'question',
      status: 'pending',
      prompt: null,
      options: null,
    });
    g.stageGates = [gate('q-a', 'si-lane-a'), gate('q-b', 'si-lane-b')];
    g.intentDetail = { intent: { status: 'WAITING', pendingHumanTaskId: 'q-a' }, metrics: [] };

    render(
      <MemoryRouter>
        <StageDetail
          row={{ ...row, state: 'WAITING_FOR_HUMAN', stageInstanceId: 'si-lane-b', unitSlug: 'b' }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Answer' })).toHaveAttribute(
      'href',
      '/space/p1/intent/i1/review/q-b',
    );
  });

  it('sends a pending review to its review page', () => {
    g.stageGates = [
      {
        humanTaskId: 'v-1',
        stageInstanceId: 'instance-1',
        kind: 'validation',
        status: 'pending',
        prompt: null,
        options: null,
      },
    ];
    g.intentDetail = { intent: { status: 'WAITING' }, metrics: [] };

    render(
      <MemoryRouter>
        <StageDetail row={{ ...row, state: 'WAITING_FOR_HUMAN' }} />
      </MemoryRouter>,
    );

    expect(screen.getByText('1 review waiting for you')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      '/space/p1/intent/i1/review/v-1',
    );
  });

  it('keeps a finished stage quiet about its gates: no line, no pill, a count under Details', async () => {
    g.stageGates = [
      {
        humanTaskId: 'v-1',
        stageInstanceId: 'instance-1',
        kind: 'validation',
        status: 'approved',
        prompt: null,
        options: null,
      },
    ];
    g.intentDetail = { intent: { status: 'SUCCEEDED' }, metrics: [] };

    render(<StageDetail row={{ ...row, state: 'SUCCEEDED' }} />);

    expect(screen.queryByText(/waiting for you/)).not.toBeInTheDocument();
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
    expect(screen.queryByText('validation · approved')).not.toBeInTheDocument();

    await userEvent.click(detailsButton());
    expect(screen.getByText('Earlier reviews')).toBeInTheDocument();
    expect(screen.getByText('1 approved')).toBeInTheDocument();
  });

  it('gives one human duration when the heading has none', () => {
    const DAY = 86_400_000;
    g.stageGates = [
      {
        humanTaskId: 'q-1',
        stageInstanceId: 'instance-1',
        kind: 'question',
        status: 'pending',
        prompt: null,
        options: null,
      },
    ];
    g.intentDetail = { intent: { status: 'WAITING' }, metrics: [] };

    const { unmount } = render(
      <MemoryRouter>
        <StageDetail
          row={{
            ...row,
            state: 'WAITING_FOR_HUMAN',
            startedAt: new Date(Date.now() - 111 * DAY).toISOString(),
            parkedAt: new Date(Date.now() - 110 * DAY - 3_600_000).toISOString(),
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Waiting for an answer for 110 days')).toBeInTheDocument();
    unmount();

    g.stageGates = [];
    render(
      <StageDetail
        row={{
          ...row,
          state: 'SUCCEEDED',
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-03T02:00:00Z',
        }}
      />,
    );
    expect(screen.getByText('Took 2d 2h')).toBeInTheDocument();
  });

  // T3 / O4: the failure reads as a sentence; the raw code is one action away.
  it('explains a stage failure in plain words and keeps the raw error in technical details', async () => {
    g.intentDetail = { intent: { status: 'FAILED' }, metrics: [] };

    render(
      <StageDetail
        row={{
          ...row,
          runtimeError: 'stage_failed: type-check: not_implemented: mode pipeline',
          attempt: 2,
          startedAt: '2026-07-21T23:40:00.000Z',
          completedAt: '2026-07-21T23:41:00.000Z',
        }}
      />,
    );

    expect(
      screen.getByText('This stage uses a mode this platform version does not support yet.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/stage_failed/)).not.toBeInTheDocument();
    expect(screen.getByText('Attempt 2')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Technical details/ }));
    expect(
      screen.getByText('stage_failed: type-check: not_implemented: mode pipeline'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy Error' })).toBeInTheDocument();
  });

  // Rewinds bump `attempt` on rows that never ran: no counter for those.
  it('hides the attempt counter for a stage that never started', () => {
    g.intentDetail = { intent: { status: 'RUNNING' }, metrics: [] };

    render(<StageDetail row={{ ...row, state: 'PENDING', attempt: 3 }} />);

    expect(screen.queryByText(/Attempt/)).not.toBeInTheDocument();
  });

  // The Details disclosure names what is inside; the numbers are one click away.
  it('names what the details hold instead of counting rows', () => {
    g.intentDetail = { intent: { status: 'FAILED' }, metrics: [] };
    g.intentStageEdges = [
      { from: 'requirements-analysis', to: 'type-check', kind: 'data', artifact: 'requirements' },
      { from: 'type-check', to: 'code-generation', kind: 'data', artifact: 'typecheck-report' },
    ];

    render(<StageDetail row={{ ...row, cli: 'claude' }} />);

    const button = detailsButton();
    expect(button).toHaveAccessibleName('Details');
    expect(button).not.toHaveTextContent(/\(\d+\)/);
    expect(button).toHaveAccessibleDescription(
      'Runtime · Planned inputs and outputs · Check history',
    );
  });

  it.each(cases)(
    'keeps the inline explanation aligned with the chip for $name',
    async (testCase) => {
      g.sensorDetail = testCase.detail;

      render(<StageDetail row={row} />);

      expect(screen.getByText('Checks needing attention')).toBeInTheDocument();
      const flag = screen
        .getAllByRole('listitem')
        .find((item) => item.textContent?.startsWith('Type Check'));
      expect(flag).toBeTruthy();
      expect(flag!).toHaveTextContent('Blocking');
      expect(flag!).toHaveTextContent(testCase.explanation);
      expect(flag!).not.toHaveTextContent('type-check');

      await userEvent.click(detailsButton());
      fireEvent.focus(
        screen.getByText('Type Check', { selector: '[data-tone] *' }).closest('[data-tone]')!,
      );
      expect(await screen.findByRole('tooltip')).toHaveTextContent(testCase.explanation);
    },
  );
});
