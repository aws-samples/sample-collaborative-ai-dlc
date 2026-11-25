import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/query';
import { UnitLaneBoardView, isBeforeConstructionPhase, isFanoutActive } from './UnitLaneBoard';
import type { IntentUnit, IntentUnitPlan, IntentUnitPr, UnitState } from '@/services/intents';
import type { PhaseNode } from '@/services/workflows';

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

const phases: PhaseNode[] = [
  {
    phaseId: 'inception',
    name: 'Inception',
    kind: 'phase',
    path: '01',
    parentPath: null,
    order: 1,
  },
  {
    phaseId: 'construction',
    name: 'Construction',
    kind: 'phase',
    path: '02',
    parentPath: null,
    order: 2,
  },
  {
    phaseId: 'operation',
    name: 'Operation',
    kind: 'phase',
    path: '03',
    parentPath: null,
    order: 3,
  },
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
  it.each(['partial', 'incomplete', 'unknown'] as const)(
    'shows the %s unit result in context',
    (state) => {
      renderView({
        completion: {
          state,
          total: 4,
          integrated: 3,
          skipped: state === 'partial' ? 1 : 0,
          legacyPartial: false,
          unresolved:
            state === 'partial'
              ? []
              : [
                  {
                    sectionIndex: 1,
                    slug: 'billing',
                    state: 'BLOCKED',
                    reason: 'repository_evidence_missing',
                  },
                ],
        },
        units: units.map((u) => ({ ...u, sectionIndex: 1 })),
      });
      if (state === 'partial') expect(screen.getByText('1 unit skipped by decision')).toBeVisible();
      else expect(screen.getByText(/changes reached every repository/)).toBeVisible();
      if (state === 'incomplete')
        expect(screen.getByText('1 unfinished unit: billing')).toBeVisible();
      // The wave summary gives way to the completion line once units ended unresolved.
      expect(Boolean(screen.queryByText(/^\d+ waves?\b/))).toBe(state === 'unknown');
    },
  );

  it('renders one column per wave with wave labels', () => {
    renderView();
    expect(screen.getByText('Wave 1')).toBeInTheDocument();
    expect(screen.getByText('Wave 2')).toBeInTheDocument();
    expect(screen.getByText('Wave 3')).toBeInTheDocument();
    expect(screen.getByText('· runs first')).toBeInTheDocument();
    expect(screen.getByText('· last')).toBeInTheDocument();
  });

  it('renders every unit with a human name and its state label', () => {
    renderView();
    // `Auth`/`Billing`/`UI` also appear as dependency refs, so assert presence
    // (>=1) rather than uniqueness; state labels are unique per fixture.
    expect(screen.getAllByText('Auth').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Reporting')).toBeInTheDocument();
    expect(screen.getByText('Integrated')).toBeInTheDocument();
    expect(screen.getByText('Building')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    // raw slugs never appear as labels
    expect(screen.queryByText('reporting')).not.toBeInTheDocument();
  });

  it('marks the walking skeleton', () => {
    renderView();
    expect(screen.getByText('Walking skeleton')).toBeInTheDocument();
  });

  it('shows dependencies and a blocked note', () => {
    renderView();
    // dependency refs
    expect(screen.getAllByText('Auth').length).toBeGreaterThan(1); // unit + dep refs
    expect(screen.getByText(/waiting for merge slot/)).toBeInTheDocument();
  });

  it('summarizes only the states that are present, in one line', () => {
    renderView();
    expect(screen.getByText('4 units')).toBeInTheDocument();
    expect(screen.getByText('1 of 4 integrated')).toBeInTheDocument();
    expect(screen.getByText('1 building')).toBeInTheDocument();
    expect(screen.getByText('1 blocked')).toBeInTheDocument();
    expect(screen.getByText('1 pending')).toBeInTheDocument();
    // no failed unit in the fixture → no failed segment
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  // W36 §1 P2: on a finished run the outcome callout already names the branch;
  // the Units line then says "both integrated" without repeating it.
  it('leaves the branch out of the summary when the callout above already names it', () => {
    renderView({
      intentBranch: 'aidlc/show-cart-badge',
      branchInSummary: false,
      units: [unit('auth', 'MERGED'), unit('billing', 'MERGED', { dependsOn: ['auth'] })],
      unitPlan: plan({
        units: [
          { slug: 'auth', dependsOn: [] },
          { slug: 'billing', dependsOn: ['auth'] },
        ],
        batches: [['auth'], ['billing']],
        unitCount: 2,
      }),
    });
    expect(screen.getByText('both integrated')).toBeInTheDocument();
    expect(screen.queryByText(/into/)).not.toBeInTheDocument();
    expect(screen.queryByText('aidlc/show-cart-badge')).not.toBeInTheDocument();
  });

  it('says "both integrated into <branch>" and links the final PR when everything is merged', () => {
    renderView({
      intentBranch: 'aidlc/show-cart-badge',
      units: [unit('auth', 'MERGED'), unit('billing', 'MERGED', { dependsOn: ['auth'] })],
      unitPlan: plan({
        units: [
          { slug: 'auth', dependsOn: [] },
          { slug: 'billing', dependsOn: ['auth'] },
        ],
        batches: [['auth'], ['billing']],
        unitCount: 2,
      }),
      pullRequests: [
        {
          id: 'pr-1',
          repository: 'eipasteur/retail-store-cart',
          prUrl: 'https://example.test/pull/57',
          prNumber: '57',
          branch: 'aidlc/show-cart-badge',
          baseBranch: 'main',
          createdAt: null,
        },
      ],
    });
    expect(screen.getByText('2 units')).toBeInTheDocument();
    expect(screen.getByText(/both integrated into/)).toBeInTheDocument();
    expect(screen.getByText('aidlc/show-cart-badge')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /PR #57/ })).toHaveAttribute(
      'href',
      'https://example.test/pull/57',
    );
    // Details are on demand once every unit is integrated.
    expect(screen.queryByText('Wave 1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Units/ }));
    expect(screen.getByText('Wave 1')).toBeInTheDocument();
    expect(screen.getByText('Wave 2')).toBeInTheDocument();
  });

  it('keeps the details open while any unit is still active', () => {
    renderView();
    expect(screen.getByRole('button', { name: /Units/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Wave 1')).toBeInTheDocument();
  });

  it('renders the autonomy mode and wave count in the details', () => {
    renderView();
    expect(screen.getByText(/Autonomous/)).toBeInTheDocument();
    expect(screen.getByText(/3 waves/)).toBeInTheDocument();
  });

  it('uses no text below 11 px', () => {
    const { container } = renderView();
    expect(container.innerHTML).not.toMatch(/text-\[(?:[0-9]|10)px\]/);
    expect(container.querySelector('details')).toBeNull();
  });

  it('excludes orphaned units (not in the plan) from the state counts', () => {
    // A stale row left behind after re-promotion — present in `units` but NOT
    // referenced by unitPlan.batches. It must not appear in the counts or board.
    const orphan = unit('legacy', 'FAILED', { failureReason: 'stale run' });
    renderView({ units: [...units, orphan] });
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
    expect(screen.queryByText('Legacy')).not.toBeInTheDocument();
    // real units still counted
    expect(screen.getByText('1 of 4 integrated')).toBeInTheDocument();
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

  it('offers Address feedback for an open review PR before any comment count is stored', () => {
    const onAddressFeedback = vi.fn();
    const pr: IntentUnitPr = {
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
    fireEvent.click(screen.getByRole('button', { name: 'Address feedback' }));
    expect(onAddressFeedback).toHaveBeenCalledWith(props.units[0]);

    const rerenderWith = (overrides: { units?: IntentUnit[]; unitPrs?: IntentUnitPr[] }) =>
      rerender(
        <UnitLaneBoardView
          unitPlan={props.unitPlan}
          units={overrides.units ?? props.units}
          streamsBySlug={{}}
          runningStageBySlug={{}}
          unitPrs={overrides.unitPrs ?? props.unitPrs}
          onAddressFeedback={onAddressFeedback}
        />,
      );

    // Outside active review, the feedback API refuses a batch.
    rerenderWith({ units: [unit('auth', 'MERGED', { sectionIndex: 1 })] });
    expect(screen.queryByRole('button', { name: 'Address feedback' })).not.toBeInTheDocument();

    // No open review PR: unchanged and closed repositories have nothing to review.
    rerenderWith({
      unitPrs: [
        { ...pr, state: 'UNCHANGED', number: null },
        { ...pr, repository: 'owner/web', state: 'CLOSED' },
      ],
    });
    expect(screen.queryByRole('button', { name: 'Address feedback' })).not.toBeInTheDocument();
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
    expect(screen.getAllByText('Auth')).toHaveLength(2);
    expect(screen.getByText('owner/api')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
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
          changedFileProvenance: { state: 'known', files: ['src/auth.ts'] },
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
    fireEvent.click(screen.getByRole('button', { name: /1 comment · Completed/ }));
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

describe('isBeforeConstructionPhase', () => {
  it('hides units during inception, then shows them from construction onward', () => {
    expect(isBeforeConstructionPhase('01', phases)).toBe(true);
    expect(isBeforeConstructionPhase('02', phases)).toBe(false);
    expect(isBeforeConstructionPhase('03', phases)).toBe(false);
  });

  it('uses nested zero-padded paths rather than sibling order', () => {
    const nestedPhases: PhaseNode[] = [
      {
        phaseId: 'discovery',
        name: 'Discovery',
        kind: 'phase',
        path: '01',
        parentPath: null,
        order: 1,
      },
      {
        phaseId: 'inception',
        name: 'Inception',
        kind: 'phase',
        path: '01.02',
        parentPath: '01',
        order: 2,
      },
      {
        phaseId: 'construction',
        name: 'Construction',
        kind: 'phase',
        path: '02',
        parentPath: null,
        order: 2,
      },
      {
        phaseId: 'implementation',
        name: 'Implementation',
        kind: 'phase',
        path: '02.01',
        parentPath: '02',
        order: 1,
      },
    ];

    expect(isBeforeConstructionPhase('01.02', nestedPhases)).toBe(true);
    expect(isBeforeConstructionPhase('02.01', nestedPhases)).toBe(false);
  });

  it('does not hide units when phase metadata is unavailable', () => {
    expect(isBeforeConstructionPhase('01', null)).toBe(false);
  });
});
