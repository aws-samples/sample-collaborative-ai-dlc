import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UnitLaneBoardView, isFanoutActive } from './UnitLaneBoard';
import type { IntentUnit, IntentUnitPlan, UnitState } from '@/services/intents';

const unit = (slug: string, state: UnitState, over: Partial<IntentUnit> = {}): IntentUnit => ({
  slug,
  dependsOn: [],
  state,
  batchIndex: 0,
  branch: `intent--s1-unit-${slug}`,
  startedAt: null,
  mergedAt: null,
  failureReason: null,
  blockedOn: null,
  updatedAt: null,
  ...over,
});

const plan = (over: Partial<IntentUnitPlan> = {}): IntentUnitPlan => ({
  units: [
    { slug: 'auth', dependsOn: [] },
    { slug: 'billing', dependsOn: ['auth'] },
    { slug: 'ui', dependsOn: ['auth'] },
    { slug: 'reporting', dependsOn: ['billing', 'ui'] },
  ],
  batches: [['auth'], ['billing', 'ui'], ['reporting']],
  unitCount: 4,
  skipMatrix: {},
  walkingSkeleton: 'auth',
  autonomyMode: 'autonomous',
  promotedAt: '2026-01-01T00:00:00Z',
  ...over,
});

const units: IntentUnit[] = [
  unit('auth', 'MERGED'),
  unit('billing', 'RUNNING', { dependsOn: ['auth'], startedAt: '2026-01-01T00:00:00Z' }),
  unit('ui', 'BLOCKED', { dependsOn: ['auth'], blockedOn: 'waiting for merge slot' }),
  unit('reporting', 'PENDING', { dependsOn: ['billing', 'ui'] }),
];

const renderView = (over: Partial<React.ComponentProps<typeof UnitLaneBoardView>> = {}) =>
  render(
    <UnitLaneBoardView
      unitPlan={plan()}
      units={units}
      streamsBySlug={{}}
      runningStageBySlug={{}}
      {...over}
    />,
  );

describe('UnitLaneBoardView', () => {
  it('renders one column per wave with wave labels', () => {
    renderView();
    expect(screen.getByText('Wave 1')).toBeInTheDocument();
    expect(screen.getByText('Wave 2')).toBeInTheDocument();
    expect(screen.getByText('Wave 3')).toBeInTheDocument();
    expect(screen.getByText('· runs first')).toBeInTheDocument();
    expect(screen.getByText('· last')).toBeInTheDocument();
  });

  it('renders every unit slug and its state label', () => {
    renderView();
    // `auth`/`billing`/`ui` also appear as dependency refs, so assert presence
    // (>=1) rather than uniqueness; state labels are unique per fixture.
    expect(screen.getAllByText('auth').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('reporting')).toBeInTheDocument();
    expect(screen.getByText('Merged')).toBeInTheDocument();
    expect(screen.getByText('Building')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('marks the walking skeleton', () => {
    renderView();
    expect(screen.getByText('skeleton')).toBeInTheDocument();
  });

  it('shows dependencies and a blocked note', () => {
    renderView();
    // dependency chips
    expect(screen.getAllByText('auth').length).toBeGreaterThan(1); // unit + dep refs
    expect(screen.getByText(/waiting for merge slot/)).toBeInTheDocument();
  });

  it('summarizes only the states that are present', () => {
    renderView();
    expect(screen.getByText('1 merged')).toBeInTheDocument();
    expect(screen.getByText('1 building')).toBeInTheDocument();
    expect(screen.getByText('1 blocked')).toBeInTheDocument();
    expect(screen.getByText('1 pending')).toBeInTheDocument();
    // no failed unit in the fixture → no failed chip
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it('renders the autonomy mode and unit/wave counts', () => {
    renderView();
    expect(screen.getByText('autonomous')).toBeInTheDocument();
    expect(screen.getByText(/4 units · 3 waves/)).toBeInTheDocument();
  });

  it('excludes orphaned units (not in the plan) from the state counts', () => {
    // A stale row left behind after re-promotion — present in `units` but NOT
    // referenced by unitPlan.batches. It must not appear in the counts or board.
    const orphan = unit('legacy', 'FAILED', { failureReason: 'stale run' });
    renderView({ units: [...units, orphan] });
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
    expect(screen.queryByText('legacy')).not.toBeInTheDocument();
    // real units still counted
    expect(screen.getByText('1 merged')).toBeInTheDocument();
  });

  it('renders the live stream only when a running stage instance is provided', () => {
    const { rerender } = renderView({
      streamsBySlug: { billing: 'Editing invoice.ts…' },
      runningStageBySlug: { billing: null },
    });
    // stream text is gated on a running stageInstanceId, not just the buffer
    expect(screen.queryByText(/Editing invoice.ts/)).not.toBeInTheDocument();

    rerender(
      <UnitLaneBoardView
        unitPlan={plan()}
        units={units}
        streamsBySlug={{ billing: 'Editing invoice.ts…' }}
        runningStageBySlug={{ billing: 'si-billing' }}
      />,
    );
    expect(screen.getByText(/Editing invoice.ts/)).toBeInTheDocument();
  });

  it('shows a merging note for a MERGING unit (no transcript)', () => {
    render(
      <UnitLaneBoardView
        unitPlan={plan()}
        units={[unit('auth', 'MERGING', { branch: 'intent--s1-unit-auth' })]}
        streamsBySlug={{ auth: 'some transcript' }}
        runningStageBySlug={{ auth: null }}
      />,
    );
    expect(screen.getByText(/Merging back/)).toBeInTheDocument();
    expect(screen.queryByText('some transcript')).not.toBeInTheDocument();
  });

  it('renders a per-lane View live output link keyed by the lane stageInstanceId', () => {
    const onViewLiveOutput = vi.fn();
    // No running lane → no link, even with the callback.
    const { rerender } = renderView({ onViewLiveOutput });
    expect(screen.queryByText('View live output')).not.toBeInTheDocument();

    // A building lane exposes the link, wired to THAT lane's stageInstanceId.
    rerender(
      <UnitLaneBoardView
        unitPlan={plan()}
        units={units}
        streamsBySlug={{ billing: 'Editing invoice.ts…' }}
        runningStageBySlug={{ billing: 'si-billing' }}
        onViewLiveOutput={onViewLiveOutput}
      />,
    );
    fireEvent.click(screen.getByText('View live output'));
    expect(onViewLiveOutput).toHaveBeenCalledWith('si-billing');
  });

  it('renders an orphaned parked lane as needs recovery and freezes its timer', () => {
    renderView({
      units: [
        unit('auth', 'RUNNING', {
          sectionIndex: 1,
          startedAt: '2026-01-01T00:00:00Z',
        }),
      ],
      unitPlan: plan({
        units: [{ slug: 'auth', dependsOn: [] }],
        batches: [['auth']],
        unitCount: 1,
      }),
      laneWaitBySlug: {
        's1:auth': {
          kind: 'recovery',
          stageId: 'functional-design',
          stageInstanceId: 'si-auth',
          humanTaskId: null,
          since: '2026-01-01T00:01:00Z',
          blocker: 'functional-design is parked without a pending question. Repair is required.',
        },
      },
    });

    expect(screen.getAllByText('Needs recovery')).toHaveLength(1);
    expect(screen.getByText('1 needs recovery')).toBeInTheDocument();
    expect(screen.queryByText('Building')).not.toBeInTheDocument();
    expect(screen.queryByText('1 building')).not.toBeInTheDocument();
    expect(screen.getByText('1m 0s')).toBeInTheDocument();
    expect(screen.getByText(/parked without a pending question/)).toBeInTheDocument();
  });

  it('shows waiting for input only when the parked stage owns a pending gate', () => {
    renderView({
      units: [unit('auth', 'RUNNING', { sectionIndex: 1 })],
      unitPlan: plan({
        units: [{ slug: 'auth', dependsOn: [] }],
        batches: [['auth']],
        unitCount: 1,
      }),
      laneWaitBySlug: {
        's1:auth': {
          kind: 'input',
          stageId: 'functional-design',
          stageInstanceId: 'si-auth',
          humanTaskId: 'q-auth',
          since: '2026-01-01T00:01:00Z',
          blocker: 'functional-design: Choose the persistence model.',
        },
      },
    });

    expect(screen.getByText('Waiting for input')).toBeInTheDocument();
    expect(screen.getByText('1 waiting for input')).toBeInTheDocument();
    expect(screen.getByText(/Choose the persistence model/)).toBeInTheDocument();
  });

  it('hides Address feedback until at least one provider comment exists', () => {
    const onAddressFeedback = vi.fn();
    const pr = {
      sectionIndex: 1,
      unitSlug: 'auth',
      repository: 'owner/api',
      provider: 'github',
      providerId: '101',
      number: 7,
      url: 'https://example.test/pr/7',
      sourceBranch: 'unit',
      targetBranch: 'intent',
      headSha: 'a',
      readyHeadSha: null,
      targetSha: 'b',
      state: 'DRAFT' as const,
      mergeable: null,
      commentCount: 0,
      repositoryOutcome: null,
      createdAt: null,
      updatedAt: null,
      mergedAt: null,
      closedAt: null,
    };
    const props = {
      units: [unit('auth', 'PR_DRAFT', { sectionIndex: 1 })],
      unitPlan: plan({
        units: [{ slug: 'auth', dependsOn: [] }],
        batches: [['auth']],
        unitCount: 1,
      }),
      unitPrs: [pr],
      onAddressFeedback,
    };
    const { rerender } = renderView(props);
    expect(screen.queryByRole('button', { name: 'Address feedback' })).not.toBeInTheDocument();

    rerender(
      <UnitLaneBoardView
        unitPlan={props.unitPlan}
        units={props.units}
        streamsBySlug={{}}
        runningStageBySlug={{}}
        unitPrs={[{ ...pr, commentCount: 1 }]}
        onAddressFeedback={onAddressFeedback}
      />,
    );
    expect(screen.getByRole('button', { name: 'Address feedback' })).toBeInTheDocument();
  });

  it('keeps repeated unit slugs distinct across sections and shows repository PR state', () => {
    const repeated = [
      unit('auth', 'PR_DRAFT', { sectionIndex: 1 }),
      unit('auth', 'PR_READY', { sectionIndex: 2, integrationOwner: true }),
    ];
    renderView({
      units: repeated,
      unitPlan: plan({
        units: [{ slug: 'auth', dependsOn: [] }],
        batches: [['auth']],
        unitCount: 1,
      }),
      unitPrs: [
        {
          sectionIndex: 1,
          unitSlug: 'auth',
          repository: 'owner/api',
          provider: 'github',
          providerId: '101',
          number: 7,
          url: 'https://example.test/pr/7',
          sourceBranch: 'unit',
          targetBranch: 'intent',
          headSha: 'a',
          readyHeadSha: null,
          targetSha: 'b',
          state: 'DRAFT',
          mergeable: null,
          commentCount: 2,
          repositoryOutcome: null,
          createdAt: null,
          updatedAt: null,
          mergedAt: null,
          closedAt: null,
        },
      ],
    });
    expect(screen.getByText('Section 1')).toBeInTheDocument();
    expect(screen.getByText('Section 2')).toBeInTheDocument();
    expect(screen.getAllByText('auth')).toHaveLength(2);
    expect(screen.getByText('owner/api')).toBeInTheDocument();
    expect(screen.getByText('Integration turn')).toBeInTheDocument();
  });

  it('expands feedback history with revision output, changed files, and verification', () => {
    renderView({
      units: units.map((row) => ({ ...row, sectionIndex: 1 })),
      feedbackBatches: [
        {
          sectionIndex: 1,
          unitSlug: 'auth',
          batchId: 'batch-1',
          comments: [{} as never],
          state: 'SUCCEEDED',
          requestedBy: 'u1',
          requestedByName: 'Reviewer',
          stageInstanceId: 'stage-1',
          output: 'Handled the empty-token case.',
          changedFiles: ['src/auth.ts'],
          verification: 'npm test passed',
          commitSha: 'abcdef123456',
          failureReason: null,
          createdAt: null,
          updatedAt: null,
          completedAt: null,
        },
      ],
    });
    fireEvent.click(screen.getByText(/1 comment · succeeded/));
    expect(screen.getByText('Handled the empty-token case.')).toBeInTheDocument();
    expect(screen.getByText(/src\/auth.ts/)).toBeInTheDocument();
    expect(screen.getByText(/npm test passed/)).toBeInTheDocument();
  });
});

describe('isFanoutActive', () => {
  const ev = (type: string) => ({ type });

  it('is false with no fan-out events', () => {
    expect(isFanoutActive(null)).toBe(false);
    expect(isFanoutActive({ events: [ev('v2.stage.running')] })).toBe(false);
  });

  it('is true after the section starts and before fan-in', () => {
    expect(isFanoutActive({ events: [ev('v2.units.section_started')] })).toBe(true);
  });

  it('is false again once the section fans in', () => {
    expect(
      isFanoutActive({
        events: [ev('v2.units.section_started'), ev('v2.units.fan_in')],
      }),
    ).toBe(false);
  });

  it('stays active while a later section is still open (started > fanned in)', () => {
    expect(
      isFanoutActive({
        events: [
          ev('v2.units.section_started'),
          ev('v2.units.fan_in'),
          ev('v2.units.section_started'),
        ],
      }),
    ).toBe(true);
  });
});
