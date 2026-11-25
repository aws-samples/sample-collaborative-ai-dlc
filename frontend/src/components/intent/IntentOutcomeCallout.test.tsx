import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type {
  Intent,
  IntentArtifact,
  IntentDetail,
  IntentGate,
  IntentStage,
  IntentUnit,
} from '@/services/intents';
import {
  IntentOutcomeCallout,
  openDecisions,
  type IntentOutcomeCalloutProps,
} from './IntentOutcomeCallout';
import { countWorkProductDocuments } from './documentHelpers';

// Fixtures follow the audited staging intents (audit §5.1/§5.4): I1 one
// waiting gate, I3 two gates of 108/136 days, I5 hung RUNNING since July,
// I6 SUCCEEDED with PR #57, I8 FAILED not_implemented, I4 CANCELLED with
// two integrated units. The clock is fixed to 21 Nov 2026 15:00 UTC.
const NOW = new Date('2026-11-21T15:00:00Z');
const daysAgo = (days: number, hours = 0) =>
  new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: 'c9376317-0000-4000-8000-000000000001',
    executionId: 'exec-1',
    projectId: 'retail-v2',
    title: 'Add a low-stock warning badge',
    prompt: 'Add a low-stock warning badge to the catalog.',
    status: 'RUNNING',
    branch: 'aidlc/low-stock-badge',
    baseBranch: 'main',
    baseBranches: null,
    repos: ['eipasteur/retail-store-catalog'],
    gitProvider: 'github',
    workflowId: 'wf-1',
    workflowVersion: 3,
    scope: 'express',
    currentPhase: 'inception',
    currentStage: 'intent-capture',
    pendingHumanTaskId: null,
    failureReason: null,
    failure: null,
    cliModels: null,
    environment: null,
    parkReleaseSeconds: null,
    source: null,
    createdAt: daysAgo(130),
    updatedAt: daysAgo(122),
    completedAt: null,
    ...overrides,
  };
}

function makeStage(overrides: Partial<IntentStage> = {}): IntentStage {
  return {
    stageInstanceId: `si-${overrides.stageId ?? 'stage'}`,
    stageId: 'intent-capture',
    phase: 'inception',
    state: 'RUNNING',
    attempt: 1,
    cli: 'codex',
    runtimeError: null,
    startedAt: daysAgo(122),
    completedAt: null,
    updatedAt: daysAgo(122),
    ...overrides,
  };
}

function makeGate(overrides: Partial<IntentGate> = {}): IntentGate {
  return {
    humanTaskId: 'q-1',
    stageInstanceId: 'si-feasibility',
    kind: 'question',
    status: 'pending',
    prompt: null,
    options: null,
    questions: JSON.stringify([{ text: 'Which LLM router should the cart use?' }]),
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: daysAgo(108, 12),
    ...overrides,
  };
}

function makeDetail(overrides: Partial<IntentDetail> = {}): IntentDetail {
  return {
    intent: makeIntent(),
    stages: [],
    events: [],
    gates: [],
    steering: [],
    metrics: [],
    outputs: [],
    sensorRuns: [],
    artifacts: [],
    ...overrides,
  };
}

const unit = (slug: string, state: IntentUnit['state']): IntentUnit => ({
  slug,
  dependsOn: [],
  state,
  batchIndex: 0,
  branch: `aidlc/cart-badge/${slug}`,
  startedAt: daysAgo(40),
  mergedAt: state === 'MERGED' ? daysAgo(39) : null,
  failureReason: null,
  blockedOn: null,
  updatedAt: daysAgo(39),
});

// I1 — one question gate waiting for 108 days.
const I1_WAITING = makeDetail({
  intent: makeIntent({
    status: 'WAITING',
    title: 'Cart quantity stepper',
    currentStage: 'feasibility',
    pendingHumanTaskId: 'q-1',
    updatedAt: daysAgo(108, 12),
  }),
  stages: [
    makeStage({ stageId: 'intent-capture', state: 'SUCCEEDED', completedAt: daysAgo(109) }),
    makeStage({
      stageId: 'feasibility',
      state: 'WAITING_FOR_HUMAN',
      parkedAt: daysAgo(108, 12),
      pendingHumanTaskId: 'q-1',
    }),
  ],
  gates: [makeGate()],
});

// I3 — two gates on two stages, 108 and 136 days old.
const I3_TWO_GATES = makeDetail({
  intent: makeIntent({
    status: 'WAITING',
    title: 'LLM router',
    currentStage: 'feasibility',
    pendingHumanTaskId: 'q-1',
    updatedAt: daysAgo(108, 12),
  }),
  stages: [
    makeStage({
      stageId: 'scope-definition',
      state: 'WAITING_FOR_HUMAN',
      parkedAt: daysAgo(136, 10),
    }),
    makeStage({ stageId: 'feasibility', state: 'WAITING_FOR_HUMAN', parkedAt: daysAgo(108, 12) }),
  ],
  gates: [
    makeGate(),
    makeGate({
      humanTaskId: 'q-2',
      stageInstanceId: 'si-scope-definition',
      kind: 'validation',
      questions: null,
      createdAt: daysAgo(136, 10),
    }),
  ],
});

// I5 — RUNNING with the last event on 22 July (4 months).
const I5_STALLED = makeDetail({
  intent: makeIntent({ status: 'RUNNING', updatedAt: '2026-07-22T09:12:00Z' }),
  stages: [makeStage({ state: 'RUNNING', updatedAt: '2026-07-22T09:12:00Z' })],
  events: [
    {
      eventId: 'e-1',
      type: 'stage_started',
      stageInstanceId: 'si-intent-capture',
      actor: null,
      summary: 'intent-capture started',
      timestamp: '2026-07-22T09:12:00Z',
    },
  ],
});

// RUNNING-healthy fixture: last activity 3 minutes ago.
const RUNNING_HEALTHY = makeDetail({
  intent: makeIntent({
    status: 'RUNNING',
    currentStage: 'reverse-engineering',
    updatedAt: minutesAgo(3),
    createdAt: minutesAgo(20),
  }),
  stages: [
    makeStage({ stageId: 'reverse-engineering', state: 'RUNNING', updatedAt: minutesAgo(3) }),
  ],
});

// I6 — SUCCEEDED, one PR, 2 h 14 min wall clock, 7 documents.
const I6_SUCCEEDED = makeDetail({
  intent: makeIntent({
    status: 'SUCCEEDED',
    title: 'cf2-v2618-express',
    branch: 'aidlc/cf2-v2618-express',
    currentStage: null,
    createdAt: '2026-11-19T10:00:00Z',
    orchestratorStartedAt: '2026-11-19T10:01:00Z',
    completedAt: '2026-11-19T12:15:00Z',
    updatedAt: '2026-11-19T12:15:00Z',
  }),
  artifacts: Array.from({ length: 7 }, (_, i) => ({
    id: `a-${i}`,
    artifactType: 'document',
    title: `Document ${i + 1}`,
    createdByExecutionId: 'exec-1',
    createdByStageInstanceId: null,
    createdAt: '2026-11-19T11:00:00Z',
  })),
  pullRequests: [
    {
      id: 'pr-1',
      repository: 'eipasteur/retail-store-cart',
      prUrl: 'https://github.com/eipasteur/retail-store-cart/pull/57',
      prNumber: '57',
      branch: 'aidlc/cf2-v2618-express',
      baseBranch: 'main',
      createdAt: '2026-11-19T12:14:00Z',
    },
  ],
});

// I8 — FAILED in reverse-engineering with the legacy failureReason string.
const I8_FAILED = makeDetail({
  intent: makeIntent({
    status: 'FAILED',
    title: 'cf2-express',
    currentStage: 'reverse-engineering',
    failureReason: 'stage_failed: reverse-engineering: not_implemented: mode pipeline',
    failure: null,
    updatedAt: daysAgo(2),
  }),
  stages: [
    makeStage({ stageId: 'state-init', state: 'SUCCEEDED', completedAt: daysAgo(2, 1) }),
    makeStage({
      stageId: 'reverse-engineering',
      state: 'FAILED',
      runtimeError: 'not_implemented: mode pipeline',
      completedAt: daysAgo(2),
    }),
  ],
});

// I4 — CANCELLED after two units were integrated.
const I4_CANCELLED = makeDetail({
  intent: makeIntent({
    status: 'CANCELLED',
    title: 'Cart badge',
    branch: 'aidlc/cart-badge',
    completedAt: daysAgo(38),
  }),
  units: [unit('badge-ui', 'MERGED'), unit('badge-api', 'MERGED'), unit('badge-docs', 'BLOCKED')],
  unitCompletion: {
    state: 'aborted',
    total: 3,
    integrated: 2,
    skipped: 0,
    unresolved: [{ sectionIndex: 0, slug: 'badge-docs', state: 'BLOCKED' }],
    legacyPartial: false,
  },
});

function renderCallout(props: Partial<IntentOutcomeCalloutProps> & { detail: IntentDetail }) {
  return render(
    <MemoryRouter>
      <IntentOutcomeCallout now={NOW} links={{}} {...props} />
    </MemoryRouter>,
  );
}

const status = () => {
  const callout = screen.getAllByRole('status').find((node) => node.hasAttribute('data-outcome'));
  if (!callout) throw new Error('IntentOutcomeCallout did not render');
  return callout;
};

// I3 as staging actually serves it: one pending gate (108 days) and a second
// stage still WAITING_FOR_HUMAN since 136 days whose gate was answered but
// never resumed. Both rows are yellow in the stage list.
const I3_ORPHAN_STAGE = makeDetail({
  intent: I3_TWO_GATES.intent,
  stages: I3_TWO_GATES.stages,
  gates: [
    makeGate(),
    makeGate({
      humanTaskId: 'q-2',
      stageInstanceId: 'si-scope-definition',
      status: 'answered',
      answeredAt: daysAgo(136, 9),
      createdAt: daysAgo(136, 10),
    }),
  ],
});

describe('IntentOutcomeCallout — WAITING', () => {
  it('I1: names the one decision without repeating its age, and offers one Answer action', async () => {
    const onAnswer = vi.fn();
    renderCallout({ detail: I1_WAITING, onAnswer });
    expect(status()).toHaveTextContent('1 decision needs your answer');
    // The header pill carries the age; the callout never repeats it (R5-1).
    expect(status()).not.toHaveTextContent(/108 days/);
    const list = screen.getByRole('list', { name: 'Open decisions' });
    expect(list).toHaveTextContent('Feasibility');
    const answers = screen.getAllByRole('button', { name: /^Answer/ });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toHaveAccessibleName('Answer: Which LLM router should the cart use?');
    await userEvent.click(answers[0]);
    expect(onAnswer).toHaveBeenCalledWith('q-1');
  });

  it('I3: counts two decisions, oldest first, one action per gate and no ages', () => {
    renderCallout({
      detail: I3_TWO_GATES,
      links: { gate: (gate) => `/review/${gate.humanTaskId}` },
    });
    expect(status()).toHaveTextContent('2 decisions need your answer');
    expect(status()).not.toHaveTextContent(/days/);
    const list = screen.getByRole('list', { name: 'Open decisions' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Oldest first: the 136-day validation gate names its stage, not a slug.
    expect(items[0]).toHaveTextContent('Scope Definition');
    expect(within(items[0]).getByRole('link', { name: /^Review/ })).toHaveAttribute(
      'href',
      '/review/q-2',
    );
    expect(within(items[1]).getByRole('link', { name: /^Answer/ })).toHaveAttribute(
      'href',
      '/review/q-1',
    );
    expect(list.textContent).not.toMatch(/si-scope-definition|q-1|q-2/);
  });

  it('I3 (staging): a stage parked without an open question still counts', () => {
    renderCallout({
      detail: I3_ORPHAN_STAGE,
      links: { details: '/space/llm/intent/675', gate: () => '/review' },
    });
    expect(status()).toHaveTextContent('2 stages are waiting for input');
    const list = screen.getByRole('list', { name: 'Open decisions' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Scope Definition');
    // Announced and honest: there is no card for it on this page.
    expect(items[0]).toHaveTextContent('Parked with no open question');
    expect(
      within(items[0]).getByRole('link', { name: 'View activity: Scope Definition' }),
    ).toHaveAttribute('href', '/space/llm/intent/675');
    expect(within(items[1]).getByRole('link', { name: /^Answer/ })).toBeInTheDocument();
  });

  it('I3 (Work): the parked stage opens its activity in place when the page owns the panel', async () => {
    const onViewActivity = vi.fn();
    const onAnswer = vi.fn();
    renderCallout({ detail: I3_ORPHAN_STAGE, onAnswer, onViewActivity });
    const items = within(screen.getByRole('list', { name: 'Open decisions' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('Parked with no open question');
    await userEvent.click(
      within(items[0]).getByRole('button', { name: 'View activity: Scope Definition' }),
    );
    expect(onViewActivity).toHaveBeenCalledWith('si-scope-definition');
    await userEvent.click(within(items[1]).getByRole('button', { name: /^Answer/ }));
    expect(onAnswer).toHaveBeenCalledWith('q-1');
    expect(screen.queryByRole('link', { name: /View activity/ })).toBeNull();
  });

  it('openDecisions: oldest first, pending gates and parked stages, no double counting', () => {
    const decisions = openDecisions(I3_ORPHAN_STAGE);
    expect(decisions.map((d) => d.kind)).toEqual(['stage', 'gate']);
    expect(decisions[0].since).toBe(daysAgo(136, 10));
    expect(decisions[1].since).toBe(daysAgo(108, 12));
    expect(openDecisions(I3_TWO_GATES).map((d) => d.kind)).toEqual(['gate', 'gate']);
    expect(openDecisions(I1_WAITING)).toHaveLength(1);
  });

  it('stacks the action under the question below sm and keeps it inline above', () => {
    renderCallout({ detail: I1_WAITING, onAnswer: vi.fn() });
    const row = within(screen.getByRole('list', { name: 'Open decisions' })).getByRole('listitem');
    expect(row).toHaveClass('flex-col', 'sm:flex-row');
  });

  it('does not speculate about expiry: no "may not resume" without a backend signal', () => {
    renderCallout({ detail: I3_TWO_GATES });
    expect(status()).not.toHaveTextContent(/may not resume|expired|will fail/i);
  });

  it('resumeRequired: says the answer was saved and offers Resume when provided', async () => {
    const onClick = vi.fn();
    renderCallout({
      detail: makeDetail({
        intent: makeIntent({
          status: 'WAITING',
          resumeRequired: { humanTaskId: 'q-1', callbackId: 'cb-1', answeredAt: daysAgo(1) },
        }),
        gates: [makeGate({ status: 'answered', resumeAvailable: true, answeredAt: daysAgo(1) })],
      }),
      actions: { resume: { onClick } },
    });
    expect(status()).toHaveTextContent('Your answer was saved but the run did not continue');
    await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("resumeRequired in one lane keeps the other lane's open decision visible", async () => {
    const onAnswer = vi.fn();
    renderCallout({
      detail: makeDetail({
        intent: makeIntent({
          status: 'WAITING',
          pendingHumanTaskId: 'q-2',
          resumeRequired: { humanTaskId: 'q-1', callbackId: 'cb-1', answeredAt: daysAgo(1) },
        }),
        stages: [
          makeStage({ stageId: 'build-unit', unitSlug: 'badge-ui', stageInstanceId: 'si-ui' }),
          makeStage({
            stageId: 'build-unit',
            unitSlug: 'badge-api',
            stageInstanceId: 'si-api',
            state: 'WAITING_FOR_HUMAN',
          }),
        ],
        gates: [
          makeGate({
            humanTaskId: 'q-1',
            stageInstanceId: 'si-ui',
            unitSlug: 'badge-ui',
            status: 'answered',
            resumeAvailable: true,
            answeredAt: daysAgo(1),
          }),
          makeGate({
            humanTaskId: 'q-2',
            stageInstanceId: 'si-api',
            unitSlug: 'badge-api',
            questions: JSON.stringify([{ text: 'Which API version?' }]),
            createdAt: daysAgo(2),
          }),
        ],
      }),
      actions: { resume: { onClick: vi.fn() } },
      onAnswer,
    });
    const callout = status();
    expect(callout).toHaveTextContent('1 decision needs your answer');
    expect(callout).toHaveTextContent('Your answer was saved but the run did not continue');
    expect(screen.getByRole('button', { name: 'Resume run' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Open decisions' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('Which API version?');
    await userEvent.click(within(list).getByRole('button', { name: /^Answer/ }));
    expect(onAnswer).toHaveBeenCalledWith('q-2');
  });

  it('WAITING with no pending gate and no resume reads as automatic, not as a human task', () => {
    renderCallout({
      detail: makeDetail({
        intent: makeIntent({
          status: 'WAITING',
          pendingHumanTaskId: null,
          updatedAt: minutesAgo(5),
        }),
      }),
    });
    const callout = status();
    expect(callout).toHaveTextContent('Waiting on the engine — no action needed from you');
    expect(callout).not.toHaveTextContent(/your answer|someone answers/i);
    expect(callout).toHaveAttribute('data-outcome', 'waiting_engine');
    expect(screen.queryByRole('list', { name: 'Open decisions' })).toBeNull();
  });
});

describe('IntentOutcomeCallout — RUNNING', () => {
  it('healthy: says what it works on and when it was last active, running tone', () => {
    renderCallout({ detail: RUNNING_HEALTHY });
    expect(status()).toHaveTextContent('Working on Reverse Engineering · last activity 3 min ago');
    expect(status()).toHaveAttribute('data-outcome', 'running');
  });

  it('I5 stalled: warning, coarse age, no pulse, explains why Cancel is unavailable', () => {
    renderCallout({ detail: I5_STALLED, links: { details: '/space/retail-v2/intent/c93' } });
    const callout = status();
    expect(callout).toHaveTextContent('Stalled at Intent Capture — no activity for 4 months');
    expect(callout).toHaveAttribute('data-tone', 'warning');
    expect(callout).toHaveAttribute('data-outcome', 'stalled');
    expect(callout.querySelector('[data-pulse]')).toBeNull();
    expect(callout.querySelector('.animate-pulse, .motion-safe\\:animate-pulse')).toBeNull();
    expect(callout).toHaveTextContent(/cannot be cancelled/i);
    expect(screen.getByRole('link', { name: 'View activity' })).toHaveAttribute(
      'href',
      '/space/retail-v2/intent/c93',
    );
    expect(screen.queryByRole('link', { name: 'Open details' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });

  it('I5 stalled (Work): "activity" in the sentence opens the stalled stage output', async () => {
    const onViewActivity = vi.fn();
    renderCallout({ detail: I5_STALLED, onViewActivity });
    const activity = within(status()).getByRole('button', { name: 'View activity' });
    expect(activity).toHaveTextContent('activity');
    await userEvent.click(activity);
    expect(onViewActivity).toHaveBeenCalledWith(I5_STALLED.stages[0].stageInstanceId);
    expect(screen.queryByRole('link', { name: 'View activity' })).toBeNull();
  });

  it('I5 stalled: offers Restart from the current stage only when the callback is provided', async () => {
    const onClick = vi.fn();
    const { rerender } = renderCallout({ detail: I5_STALLED });
    expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull();
    rerender(
      <MemoryRouter>
        <IntentOutcomeCallout
          now={NOW}
          links={{}}
          detail={I5_STALLED}
          actions={{ restartFromStage: { onClick } }}
        />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Restart from Intent Capture' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Restart from Intent Capture?' });
    expect(dialog).toHaveTextContent(/new run|agents/i);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart from this stage' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('uses lastActivityAt from the caller over the intent timestamps', () => {
    renderCallout({ detail: I5_STALLED, lastActivityAt: minutesAgo(2) });
    expect(status()).toHaveTextContent('last activity 2 min ago');
    expect(status()).toHaveAttribute('data-outcome', 'running');
  });
});

describe('IntentOutcomeCallout — FAILED', () => {
  it('I8: names the failed stage, the plain reason, and keeps the raw code in Technical details', async () => {
    renderCallout({ detail: I8_FAILED });
    expect(status()).toHaveTextContent(
      'Failed at Reverse Engineering — This stage uses a mode this platform version does not support yet.',
    );
    expect(status()).toHaveAttribute('data-tone', 'danger');
    // The raw code is one deliberate action away, never the headline.
    expect(screen.queryByText('not_implemented', { exact: false })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Technical details/ }));
    expect(screen.getByText('not_implemented')).toBeInTheDocument();
    expect(
      screen.getByText('stage_failed: reverse-engineering: not_implemented: mode pipeline'),
    ).toBeInTheDocument();
  });

  it('I8: renders only the recovery actions that are provided, each behind a confirmation', async () => {
    const restart = vi.fn();
    const startAgain = vi.fn();
    renderCallout({
      detail: I8_FAILED,
      actions: { restartFromStage: { onClick: restart }, startAgain: { onClick: startAgain } },
      links: { logs: '/space/retail-v2/intent/56d#output', details: '/space/retail-v2/intent/56d' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Restart from Reverse Engineering' }));
    let dialog = await screen.findByRole('alertdialog', {
      name: 'Restart from Reverse Engineering?',
    });
    expect(dialog).toHaveTextContent(/completed stages are kept/i);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart from this stage' }));
    expect(restart).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    dialog = await screen.findByRole('alertdialog', {
      name: 'Restart this workflow from the beginning?',
    });
    expect(dialog).toHaveTextContent(/failed run stays in history/i);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart workflow' }));
    expect(startAgain).toHaveBeenCalledTimes(1);

    expect(screen.getByRole('link', { name: 'Open logs' })).toHaveAttribute(
      'href',
      '/space/retail-v2/intent/56d#output',
    );
    expect(screen.getByRole('link', { name: 'View activity' })).toHaveAttribute(
      'href',
      '/space/retail-v2/intent/56d',
    );
    expect(screen.queryByRole('button', { name: 'Start again' })).toBeNull();
  });

  it('Restart workflow: Keep run leaves the run untouched and quotes the previous cost', async () => {
    const startAgain = vi.fn();
    renderCallout({
      detail: makeDetail({
        intent: I8_FAILED.intent,
        metrics: [
          {
            metricId: 'm-1',
            stageInstanceId: 'si-reverse-engineering',
            metrics: { tokensInput: 1000, tokensOutput: 200 },
            timestamp: daysAgo(2),
            cost: {
              model: null,
              inputCost: 0.3,
              outputCost: 0.12,
              totalCost: 0.42,
              currency: 'USD',
              priced: true,
              estimated: false,
            },
          },
        ],
      }),
      actions: { startAgain: { onClick: startAgain } },
      links: { newVersion: '/space/retail-v2/intent/new?fromIntent=56d' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('$0.42');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep run' }));
    expect(startAgain).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Start on another AI-DLC version' })).toHaveAttribute(
      'href',
      '/space/retail-v2/intent/new?fromIntent=56d',
    );
  });

  it('Restart workflow: focus returns to the Restart button when the dialog is dismissed (WCAG 2.4.3)', async () => {
    renderCallout({
      detail: I8_FAILED,
      actions: { startAgain: { onClick: vi.fn() }, restartFromStage: { onClick: vi.fn() } },
    });
    const restart = screen.getByRole('button', { name: 'Restart workflow' });
    await userEvent.click(restart);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep run' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(restart).toHaveFocus());

    const restartStage = screen.getByRole('button', { name: 'Restart from Reverse Engineering' });
    await userEvent.click(restartStage);
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(restartStage).toHaveFocus());
  });

  it('shows a pending recovery action as busy', () => {
    renderCallout({
      detail: I8_FAILED,
      actions: { restartFromStage: { onClick: vi.fn(), pending: true } },
    });
    expect(
      screen.getByRole('button', { name: 'Restart from Reverse Engineering' }),
    ).toHaveAttribute('aria-busy', 'true');
  });

  it('prefers the structured failure over the legacy string and names the compiled stage', () => {
    renderCallout({
      detail: makeDetail({
        intent: makeIntent({
          status: 'FAILED',
          currentStage: null,
          failureReason: null,
          failure: { code: 'init_ws_failed', message: 'git clone exited 128' },
        }),
      }),
      stageNameOf: () => null,
    });
    expect(status()).toHaveTextContent(
      'Failed before the first stage — The workspace could not be prepared, for example the repository checkout failed.',
    );
  });
});

describe('IntentOutcomeCallout — SUCCEEDED', () => {
  it('I6: duration, PR link with number, branch, and the documents link', () => {
    renderCallout({
      detail: I6_SUCCEEDED,
      links: { documents: '/space/retail-v2/intent/8f0#intent-work-products' },
    });
    expect(status()).toHaveTextContent('Completed in 2 h 14 min');
    expect(status()).toHaveAttribute('data-tone', 'success');
    const pr = screen.getByRole('link', { name: 'PR #57 · retail-store-cart' });
    expect(pr).toHaveAttribute('href', 'https://github.com/eipasteur/retail-store-cart/pull/57');
    expect(pr).toHaveAttribute('target', '_blank');
    expect(status()).toHaveTextContent('aidlc/cf2-v2618-express');
    expect(screen.getByRole('link', { name: '7 documents' })).toHaveAttribute(
      'href',
      '/space/retail-v2/intent/8f0#intent-work-products',
    );
  });

  it('"N documents" is the shared work-products count: code and superseded artifacts are excluded', () => {
    const artifact = (over: Partial<IntentArtifact>): IntentArtifact => ({
      id: 'a',
      artifactType: 'document',
      title: 'Doc',
      createdByExecutionId: 'exec-1',
      createdByStageInstanceId: null,
      createdAt: '2026-11-19T11:00:00Z',
      ...over,
    });
    const artifacts = [
      artifact({ id: 'd1', title: 'Intent statement', artifactType: 'intent-statement' }),
      artifact({ id: 'd2', title: 'Design notes', artifactType: 'markdown' }),
      artifact({ id: 'd3', title: 'Code summary', artifactType: 'code-summary' }),
      artifact({
        id: 'c1',
        title: 'src/cart/Badge.tsx',
        artifactType: 'code',
        content: 'export {}',
      }),
      artifact({
        id: 'd0',
        title: 'Intent statement (old)',
        artifactType: 'document',
        supersededAt: '2026-11-19T11:30:00Z',
      }),
    ];
    const expected = countWorkProductDocuments(artifacts);
    expect(expected).toBe(3);
    renderCallout({
      detail: makeDetail({ intent: I6_SUCCEEDED.intent, artifacts }),
      links: { documents: '#intent-work-products' },
    });
    expect(screen.getByRole('link', { name: `${expected} documents` })).toBeInTheDocument();
    expect(status()).not.toHaveTextContent(/[45] documents/);
  });

  it('falls back to the delivery record when pullRequests is absent', () => {
    renderCallout({
      detail: makeDetail({
        intent: I6_SUCCEEDED.intent,
        delivery: {
          status: 'succeeded',
          repositories: [
            {
              repoId: 'eipasteur/retail-store-cart',
              provider: 'github',
              branch: 'aidlc/cf2-v2618-express',
              baseBranch: 'main',
              status: 'pr_opened',
              pr: {
                prUrl: 'https://github.com/eipasteur/retail-store-cart/pull/57',
                prNumber: 57,
                branch: 'aidlc/cf2-v2618-express',
                baseBranch: 'main',
              },
            },
          ],
        },
      }),
    });
    expect(screen.getByRole('link', { name: 'PR #57 · retail-store-cart' })).toBeInTheDocument();
  });

  it('offers Check delivery as a secondary action when provided', async () => {
    const onClick = vi.fn();
    renderCallout({ detail: I6_SUCCEEDED, actions: { checkDelivery: { onClick } } });
    await userEvent.click(screen.getByRole('button', { name: 'Check delivery' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('IntentOutcomeCallout — CANCELLED, DRAFT, CREATED', () => {
  it('I4: says what was delivered before the cancel', () => {
    renderCallout({ detail: I4_CANCELLED });
    expect(status()).toHaveTextContent('Cancelled 38 days ago');
    expect(status()).toHaveTextContent('2 of 3 units integrated');
    expect(status()).toHaveTextContent('aidlc/cart-badge');
    expect(status()).not.toHaveTextContent('Nothing was delivered');
  });

  it('cancelled with nothing integrated says so', () => {
    renderCallout({
      detail: makeDetail({ intent: makeIntent({ status: 'CANCELLED', completedAt: daysAgo(1) }) }),
    });
    expect(status()).toHaveTextContent('Nothing was delivered');
  });

  it('DRAFT points at the compose page', () => {
    renderCallout({
      detail: makeDetail({ intent: makeIntent({ status: 'DRAFT' }) }),
      links: { compose: '/space/retail-v2/intent/d1/compose' },
    });
    expect(status()).toHaveTextContent('Draft — not started yet');
    expect(screen.getByRole('link', { name: 'Continue composing' })).toHaveAttribute(
      'href',
      '/space/retail-v2/intent/d1/compose',
    );
  });

  it('CREATED reads as starting with its age', () => {
    renderCallout({
      detail: makeDetail({
        intent: makeIntent({
          status: 'CREATED',
          createdAt: minutesAgo(2),
          updatedAt: minutesAgo(2),
        }),
      }),
    });
    expect(status()).toHaveTextContent('Starting · requested 2 min ago');
    expect(status()).toHaveAttribute('data-outcome', 'created');
  });
});
