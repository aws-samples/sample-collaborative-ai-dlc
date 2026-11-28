import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Intent, IntentDetail, IntentGate, IntentStage, IntentUnit } from '@/services/intents';
import {
  IntentOutcomeCallout,
  openDecisions,
  type IntentOutcomeCalloutProps,
} from './IntentOutcomeCallout';

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

// One line and at most one action: every test checks the title and that the
// callout never grows a list, a fact row or a second button.
const actionCount = () =>
  within(status()).queryAllByRole('button').length + within(status()).queryAllByRole('link').length;

describe('IntentOutcomeCallout — WAITING', () => {
  it('I1: names the one question without repeating its age, and offers one Answer action', async () => {
    const onAnswer = vi.fn();
    renderCallout({ detail: I1_WAITING, onAnswer });
    expect(status()).toHaveTextContent('1 question needs your answer');
    // The header pill carries the age; the callout never repeats it (R5-1).
    expect(status()).not.toHaveTextContent(/108 days/);
    expect(screen.queryByRole('list')).toBeNull();
    const answer = screen.getByRole('button', { name: /^Answer/ });
    expect(answer).toHaveAccessibleName('Answer: Which LLM router should the cart use?');
    expect(actionCount()).toBe(1);
    await userEvent.click(answer);
    expect(onAnswer).toHaveBeenCalledWith('q-1');
  });

  it('I3: counts two decisions and opens the oldest one through its link, no ages, no rows', () => {
    renderCallout({
      detail: I3_TWO_GATES,
      links: { gate: (gate) => `/review/${gate.humanTaskId}` },
    });
    expect(status()).toHaveTextContent('2 decisions need your answer');
    expect(status()).not.toHaveTextContent(/days|Scope Definition|Feasibility/);
    // Oldest first: the 136-day validation gate.
    expect(screen.getByRole('link', { name: 'Review: Scope Definition' })).toHaveAttribute(
      'href',
      '/review/q-2',
    );
    expect(actionCount()).toBe(1);
    expect(status().textContent).not.toMatch(/si-scope-definition|q-1|q-2/);
  });

  it('I3 (staging): a stage still parked next to an open question is not a second decision', () => {
    renderCallout({
      detail: I3_ORPHAN_STAGE,
      links: { details: '/space/llm/intent/675', gate: () => '/review' },
    });
    expect(status()).toHaveTextContent('1 question needs your answer');
    expect(status()).not.toHaveTextContent(/stages|Parked/);
    expect(screen.getByRole('link', { name: /^Answer/ })).toHaveAttribute('href', '/review');
    expect(screen.queryByRole('link', { name: /View activity/ })).toBeNull();
    expect(actionCount()).toBe(1);
  });

  it('a stage parked with nothing to answer says so and points at the activity', () => {
    renderCallout({
      detail: makeDetail({
        intent: I3_TWO_GATES.intent,
        stages: I3_TWO_GATES.stages,
        gates: [makeGate({ status: 'superseded' })],
      }),
      links: { details: '/space/llm/intent/675' },
    });
    expect(status()).toHaveTextContent('Parked at Scope Definition — nothing to answer');
    expect(screen.getByRole('link', { name: 'View activity' })).toHaveAttribute(
      'href',
      '/space/llm/intent/675',
    );
    expect(actionCount()).toBe(1);
  });

  it('openDecisions: pending gates oldest first; parked stages only when no gate is open', () => {
    const decisions = openDecisions(I3_ORPHAN_STAGE);
    expect(decisions.map((d) => d.kind)).toEqual(['gate']);
    expect(decisions[0].since).toBe(daysAgo(108, 12));
    expect(openDecisions(I3_TWO_GATES).map((d) => d.since)).toEqual([
      daysAgo(136, 10),
      daysAgo(108, 12),
    ]);
    expect(openDecisions(I1_WAITING)).toHaveLength(1);
    const parked = openDecisions({ stages: I3_TWO_GATES.stages, gates: [] });
    expect(parked.map((d) => d.kind)).toEqual(['stage', 'stage']);
    expect(parked[0].since).toBe(daysAgo(136, 10));
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
    expect(actionCount()).toBe(1);
  });

  it("resumeRequired in one lane names the other lane's open question and keeps Resume as the action", async () => {
    const resume = vi.fn();
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
      actions: { resume: { onClick: resume } },
      onAnswer: vi.fn(),
    });
    expect(status()).toHaveTextContent(
      '1 question needs your answer · a saved answer did not continue',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(actionCount()).toBe(1);
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
    expect(actionCount()).toBe(0);
  });
});

describe('IntentOutcomeCallout — RUNNING', () => {
  it('healthy: says what it works on and when it was last active, running tone, no action', () => {
    renderCallout({ detail: RUNNING_HEALTHY, links: { details: '/work' } });
    expect(status()).toHaveTextContent('Working on Reverse Engineering · last activity 3 min ago');
    expect(status()).toHaveAttribute('data-outcome', 'running');
    expect(actionCount()).toBe(0);
  });

  it('I5 stalled: warning, coarse age, no pulse, nothing more than the line without a restart', () => {
    renderCallout({ detail: I5_STALLED, links: { details: '/space/retail-v2/intent/c93' } });
    const callout = status();
    expect(callout).toHaveTextContent('Stalled at Intent Capture — no activity for 4 months');
    expect(callout).toHaveAttribute('data-tone', 'warning');
    expect(callout).toHaveAttribute('data-outcome', 'stalled');
    expect(callout.querySelector('[data-pulse]')).toBeNull();
    expect(callout.querySelector('.animate-pulse, .motion-safe\\:animate-pulse')).toBeNull();
    expect(actionCount()).toBe(0);
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
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
          actions={{ restartFromStage: { stageId: 'intent-capture', onClick } }}
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
  it('I8: names the failed stage and the plain reason, never the raw code', () => {
    renderCallout({ detail: I8_FAILED });
    expect(status()).toHaveTextContent(
      'Failed at Reverse Engineering — This stage uses a mode this platform version does not support yet.',
    );
    expect(status()).toHaveAttribute('data-tone', 'danger');
    expect(screen.queryByText('not_implemented', { exact: false })).toBeNull();
    expect(screen.queryByRole('button', { name: /Technical details/ })).toBeNull();
    expect(actionCount()).toBe(0);
  });

  it('I8: one recovery action — the stage restart when allowed, behind a confirmation', async () => {
    const restart = vi.fn();
    const startAgain = vi.fn();
    renderCallout({
      detail: I8_FAILED,
      actions: {
        restartFromStage: { stageId: 'reverse-engineering', onClick: restart },
        startAgain: { onClick: startAgain },
      },
      links: { logs: '/space/retail-v2/intent/56d#output', details: '/space/retail-v2/intent/56d' },
    });
    expect(actionCount()).toBe(1);
    expect(screen.queryByRole('button', { name: 'Restart workflow' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open logs' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Restart from Reverse Engineering' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Restart from Reverse Engineering?',
    });
    expect(dialog).toHaveTextContent(/completed stages are kept/i);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart from this stage' }));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(startAgain).not.toHaveBeenCalled();
  });

  it('falls back to Restart workflow, then to the logs link, when no stage restart is allowed', () => {
    const { rerender } = renderCallout({
      detail: I8_FAILED,
      actions: { startAgain: { onClick: vi.fn() } },
      links: { logs: '/space/retail-v2/intent/56d#output' },
    });
    expect(screen.getByRole('button', { name: 'Restart workflow' })).toBeInTheDocument();
    expect(actionCount()).toBe(1);
    rerender(
      <MemoryRouter>
        <IntentOutcomeCallout
          now={NOW}
          detail={I8_FAILED}
          links={{ logs: '/space/retail-v2/intent/56d#output' }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Open logs' })).toHaveAttribute(
      'href',
      '/space/retail-v2/intent/56d#output',
    );
    expect(actionCount()).toBe(1);
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
    });
    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('$0.42');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep run' }));
    expect(startAgain).not.toHaveBeenCalled();
  });

  it('Restart workflow: focus returns to the Restart button when the dialog is dismissed (WCAG 2.4.3)', async () => {
    renderCallout({ detail: I8_FAILED, actions: { startAgain: { onClick: vi.fn() } } });
    const restart = screen.getByRole('button', { name: 'Restart workflow' });
    await userEvent.click(restart);
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep run' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(restart).toHaveFocus());

    await userEvent.click(restart);
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(restart).toHaveFocus());
  });

  it('shows a pending recovery action as busy', () => {
    renderCallout({
      detail: I8_FAILED,
      actions: {
        restartFromStage: { stageId: 'reverse-engineering', onClick: vi.fn(), pending: true },
      },
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
  it('I6: the duration and the pull request as the one action; no branch, no document count', () => {
    renderCallout({ detail: I6_SUCCEEDED, actions: { checkDelivery: { onClick: vi.fn() } } });
    expect(within(status()).getByRole('heading')).toHaveTextContent(/^Completed in 2 h 14 min$/);
    expect(status()).toHaveAttribute('data-tone', 'success');
    const pr = screen.getByRole('link', { name: 'PR #57 · retail-store-cart' });
    expect(pr).toHaveAttribute('href', 'https://github.com/eipasteur/retail-store-cart/pull/57');
    expect(pr).toHaveAttribute('target', '_blank');
    expect(status()).not.toHaveTextContent(/aidlc\/cf2-v2618-express|documents/);
    expect(screen.queryByRole('button', { name: 'Check delivery' })).toBeNull();
    expect(actionCount()).toBe(1);
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

  it('offers Check delivery only without a pull request to open', async () => {
    const onClick = vi.fn();
    renderCallout({
      detail: makeDetail({ intent: I6_SUCCEEDED.intent }),
      actions: { checkDelivery: { onClick } },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Check delivery' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(actionCount()).toBe(1);
  });

  it('adds the partial integration to the line', () => {
    renderCallout({
      detail: makeDetail({
        intent: I6_SUCCEEDED.intent,
        unitCompletion: {
          state: 'partial',
          total: 3,
          integrated: 2,
          skipped: 1,
          unresolved: [],
          legacyPartial: false,
        },
      }),
    });
    expect(status()).toHaveTextContent('Completed in 2 h 14 min · 2 of 3 units integrated');
  });
});

describe('IntentOutcomeCallout — CANCELLED, DRAFT, CREATED', () => {
  it('I4: says what was delivered before the cancel, in the line', () => {
    renderCallout({ detail: I4_CANCELLED });
    expect(status()).toHaveTextContent(
      'Cancelled 38 days ago · 2 of 3 units integrated before the run stopped',
    );
    expect(status()).not.toHaveTextContent(/aidlc\/cart-badge|nothing was delivered/);
    expect(actionCount()).toBe(0);
  });

  it('cancelled with nothing integrated says so', () => {
    renderCallout({
      detail: makeDetail({ intent: makeIntent({ status: 'CANCELLED', completedAt: daysAgo(1) }) }),
    });
    expect(status()).toHaveTextContent('Cancelled 1 day ago · nothing was delivered');
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
    expect(actionCount()).toBe(1);
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

describe('IntentOutcomeCallout — restart target', () => {
  it('names the stage the caller rewinds, not the first FAILED row of the detail', async () => {
    const onClick = vi.fn();
    renderCallout({
      detail: makeDetail({
        intent: makeIntent({ status: 'FAILED', currentStage: 'build-and-test' }),
        stages: [
          makeStage({ stageId: 'build-and-test', state: 'FAILED' }),
          makeStage({ stageId: 'code-generation', state: 'FAILED' }),
        ],
      }),
      actions: { restartFromStage: { stageId: 'code-generation', onClick } },
    });
    expect(status()).toHaveTextContent(/^Failed at Code Generation — /);
    await userEvent.click(screen.getByRole('button', { name: 'Restart from Code Generation' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Restart from Code Generation?' }),
    ).toBeInTheDocument();
  });
});

describe('IntentOutcomeCallout — stalled hand-off', () => {
  const created = (over: Partial<Intent>) =>
    makeDetail({
      intent: makeIntent({
        status: 'CREATED',
        currentStage: null,
        createdAt: minutesAgo(46),
        updatedAt: minutesAgo(45),
        ...over,
      }),
    });

  it('a run the orchestrator claimed is preparing its workspace, not "never picked up"', () => {
    renderCallout({ detail: created({ orchestratorStartedAt: minutesAgo(45) }) });
    expect(status()).toHaveTextContent('Stalled while preparing the workspace — no activity for');
    expect(status()).not.toHaveTextContent(/never picked up|requested/);
  });

  it('an unclaimed run says it was never picked up, with the time since its last activity', () => {
    renderCallout({ detail: created({}) });
    expect(status()).toHaveTextContent(
      'Stalled before the first stage — never picked up, no activity for',
    );
    expect(status()).not.toHaveTextContent(/requested/);
  });
});

describe('IntentOutcomeCallout — a reader who cannot answer', () => {
  it('says what is open and offers View instead of Answer', () => {
    renderCallout({
      detail: I1_WAITING,
      canAnswer: () => false,
      links: { gate: (gate) => `/review/${gate.humanTaskId}` },
    });
    expect(status()).toHaveTextContent('1 question waiting for an answer');
    expect(status()).not.toHaveTextContent(/your answer/);
    expect(screen.queryByRole('link', { name: /^Answer/ })).toBeNull();
    expect(
      screen.getByRole('link', { name: 'View: Which LLM router should the cart use?' }),
    ).toHaveAttribute('href', '/review/q-1');
    expect(actionCount()).toBe(1);
  });

  it('counts and opens only the gates the reader may answer', () => {
    renderCallout({
      detail: I3_TWO_GATES,
      canAnswer: (gate) => gate.humanTaskId === 'q-1',
      links: { gate: (gate) => `/review/${gate.humanTaskId}` },
    });
    expect(status()).toHaveTextContent('1 question needs your answer');
    expect(screen.getByRole('link', { name: /^Answer: / })).toHaveAttribute('href', '/review/q-1');
  });
});
