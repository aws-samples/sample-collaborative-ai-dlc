import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Routes, Route } from 'react-router';

vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: ({ entityType, entityTitle }: { entityType: string; entityTitle?: string }) => (
    <button
      type="button"
      data-testid="discuss"
      data-entity={entityType}
      data-entity-title={entityTitle}
      aria-label="Discuss"
    />
  ),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'U', email: 'u@x' } }),
}));

const mockProjectCache = vi.fn((): { project: { name: string; userRole?: string } | null } => ({
  project: { name: 'MySpace', userRole: 'owner' },
}));
const mockCachedSummary = vi.fn((): Record<string, unknown> | undefined => undefined);
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => mockProjectCache(),
  getCachedIntentSummary: (...a: unknown[]) => mockCachedSummary(...(a as [])),
}));

const get = vi.fn();
const cancel = vi.fn();
const deleteIntent = vi.fn();
const graph = vi.fn();
const rewind = vi.fn();
const resume = vi.fn();
const start = vi.fn();
const compiled = vi.fn();
const workflowGet = vi.fn();
const writeText = vi.fn();
const exportWorkflow = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    exportWorkflow: (...a: unknown[]) => exportWorkflow(...a),
    get: (...a: unknown[]) => get(...a),
    cancel: (...a: unknown[]) => cancel(...a),
    delete: (...a: unknown[]) => deleteIntent(...a),
    graph: (...a: unknown[]) => graph(...a),
    rewind: (...a: unknown[]) => rewind(...a),
    resume: (...a: unknown[]) => resume(...a),
    start: (...a: unknown[]) => start(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: (...a: unknown[]) => compiled(...a),
    get: (...a: unknown[]) => workflowGet(...a),
  },
}));
const mockReadOnly = vi.fn(() => false);
vi.mock('@/contexts/SpacePermissionsContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/SpacePermissionsContext')>();
  return {
    ...actual,
    useSpacePermissions: () => ({
      readOnly: mockReadOnly(),
      loading: false,
      documentEpoch: 0,
      canManage: undefined,
      role: mockReadOnly() ? 'viewer' : null,
      refresh: () => {},
      denyWrites: () => {},
    }),
  };
});
const getResponsibilities = vi.fn();
vi.mock('@/services/stageResponsibilities', () => ({
  stageResponsibilitiesService: { get: (...a: unknown[]) => getResponsibilities(...a) },
}));
const sharedChannels = vi.fn();
vi.mock('@/services/aidlcReleases', () => ({
  aidlcReleasesService: { sharedChannels: (...a: unknown[]) => sharedChannels(...a) },
}));

import IntentObservabilityPage from './IntentObservabilityPage';
import { ApiError } from '@/services/api';
import { IntentProvider, clearIntentCache } from '@/contexts/IntentContext';

function baseDetail(over: Record<string, unknown> = {}, detailOver: Record<string, unknown> = {}) {
  return {
    intent: {
      id: 'i1',
      executionId: 'i1',
      projectId: 'p1',
      title: 'Test Intent',
      prompt: 'x',
      status: 'RUNNING',
      branch: 'b',
      baseBranch: 'main',
      repos: ['o/r'],
      gitProvider: 'github',
      workflowId: 'w',
      workflowVersion: 1,
      scope: 'feature',
      currentPhase: null,
      currentStage: null,
      pendingHumanTaskId: null,
      cliModels: null,
      parkReleaseSeconds: 300,
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      ...over,
    },
    stages: [],
    metrics: [],
    stageMetrics: [],
    events: [],
    units: [],
    unitPlan: null,
    gates: [],
    artifacts: [],
    ...detailOver,
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

function gate(humanTaskId: string, over: Record<string, unknown> = {}) {
  return {
    humanTaskId,
    stageInstanceId: 'stage-1',
    kind: 'question',
    status: 'pending',
    prompt: 'Question?',
    options: null,
    questions: null,
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: null,
    ...over,
  };
}

function stage(stageId: string, over: Record<string, unknown> = {}) {
  return {
    stageInstanceId: `si-${stageId}`,
    stageId,
    phase: 'inception',
    state: 'SUCCEEDED',
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    attempt: 1,
    ...over,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1/intent/i1/observability']}>
      <Link to="/space/p1/intent/i2/observability">Switch intent</Link>
      <Routes>
        <Route
          path="/space/:projectId/intent/:intentId/observability"
          element={
            <IntentProvider>
              <IntentObservabilityPage />
            </IntentProvider>
          }
        />
        <Route path="/space/:projectId" element={<div data-testid="space-page" />} />
        <Route
          path="/space/:projectId/intent/:intentId"
          element={<div data-testid="intent-workbench" />}
        />
        <Route
          path="/space/:projectId/intent/:intentId/audit"
          element={<div data-testid="audit-page" />}
        />
        <Route
          path="/space/:projectId/intent/:intentId/review/:humanTaskId"
          element={<div data-testid="review-page" />}
        />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  clearIntentCache();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  writeText.mockResolvedValue(undefined);
  graph.mockResolvedValue({ nodes: [], edges: [] });
  compiled.mockResolvedValue({ graph: { nodes: [], edges: [] } });
  workflowGet.mockResolvedValue({ id: 'w', name: 'wf', version: 1, stages: [] });
  mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'owner' } });
  mockCachedSummary.mockReturnValue(undefined);
  sharedChannels.mockResolvedValue({ pinningEnabled: false });
  // Stage roles not enforced: every member may decide (unattributedAccess).
  getResponsibilities.mockResolvedValue({
    stages: [],
    unattributedAccess: { edit: true, decide: true },
  });
  mockReadOnly.mockReturnValue(false);
});

describe('IntentObservabilityPage — load recovery', () => {
  it('offers retry and a route back when the intent cannot be loaded', async () => {
    get.mockRejectedValueOnce(new Error('Temporary network failure'));
    renderPage();

    expect(await screen.findByText("Couldn't load this intent")).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 1, name: "Couldn't load this intent" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to space' })).toHaveAttribute(
      'href',
      '/space/p1',
    );

    get.mockResolvedValueOnce(baseDetail());
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Test Intent')).toBeVisible();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('R3-1: a 404 is "This intent no longer exists" with one way back and no Retry', async () => {
    get.mockRejectedValueOnce(new ApiError(404, 'Intent not found'));
    renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'This intent no longer exists' }),
    ).toBeVisible();
    expect(screen.getByText('It may have been deleted, or the link is out of date.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to space' })).toHaveAttribute(
      'href',
      '/space/p1',
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText(/check your connection/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names a missing intent as the page heading', async () => {
    get.mockResolvedValueOnce(null);
    renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Intent not found' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to space' })).toBeInTheDocument();
  });

  it('shows the cached title and status instantly while the detail loads', async () => {
    mockCachedSummary.mockReturnValue({
      id: 'i1',
      title: 'Cached title',
      status: 'WAITING',
      pendingHumanTaskId: 'gate-1',
      createdAt: agoIso(3 * DAY),
      updatedAt: agoIso(2 * DAY),
      completedAt: null,
      scope: 'bugfix',
    });
    let resolveDetail: (value: unknown) => void = () => {};
    get.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    renderPage();

    expect(await screen.findByRole('heading', { level: 1, name: 'Cached title' })).toBeVisible();
    // The row knows the status but not the oldest open gate: no age is guessed
    // from updatedAt before the detail answers (R3-5).
    expect(screen.getByText(/^Waiting for input$/)).toBeInTheDocument();
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(mockCachedSummary).toHaveBeenCalledWith('p1', 'i1');

    resolveDetail(baseDetail({ title: 'Loaded title', status: 'WAITING' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Loaded title' })).toBeVisible();
    expect(screen.queryByText('Cached title')).not.toBeInTheDocument();
  });
});

describe('IntentObservabilityPage — execution progress', () => {
  it('keeps the diagram, dependencies and list views', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();

    await screen.findByText('Execution progress');
    expect(screen.getByRole('group', { name: 'Execution view' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Diagram' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dependencies' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'List' })).toBeInTheDocument();
  });
});

describe('IntentObservabilityPage — Run cost and usage (O7)', () => {
  const usage = () => screen.getByRole('group', { name: 'Run cost and usage' });

  it('shows one metric row (Tokens · Cost · Elapsed · Stages run) with the breakdown behind Details', async () => {
    get.mockResolvedValue({
      ...baseDetail({
        status: 'SUCCEEDED',
        orchestratorStartedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T01:30:00Z',
      }),
      stages: [stage('reverse-engineering'), stage('requirements-analysis', { state: 'SKIPPED' })],
      metrics: [
        {
          metrics: {
            tokensInput: 5000,
            tokensOutput: 2000,
            contextWindowPct: 45,
            agentLaunchMs: 1200,
          },
          cost: { totalCost: 0, currency: 'USD', priced: false },
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    });
    compiled.mockResolvedValue({
      scopeGrid: {},
      graph: {
        nodes: [
          { stageId: 'reverse-engineering', phasePath: '01', order: 0 },
          { stageId: 'requirements-analysis', phasePath: '01', order: 1 },
        ],
        edges: [],
      },
    });
    renderPage();

    await screen.findByText('Run cost and usage', { selector: 'div' });
    expect(within(usage()).getByText('Tokens')).toBeInTheDocument();
    expect(within(usage()).getByText('7.0K')).toBeInTheDocument();
    expect(within(usage()).getByText('Unavailable')).toBeInTheDocument();
    expect(within(usage()).getByText('Elapsed')).toBeInTheDocument();
    expect(within(usage()).getByText('1h 30m')).toBeInTheDocument();
    expect(within(usage()).getByText('Stages run')).toBeInTheDocument();
    // The skipped stage did not run: it counts in neither figure.
    expect(within(usage()).getByText('1 of 1')).toBeInTheDocument();
    expect(screen.queryByText('Input')).not.toBeInTheDocument();
    expect(screen.queryByText('Peak dispatch delay')).not.toBeInTheDocument();

    const details = screen.getByRole('button', { name: 'Details' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(details);
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.queryByText('Peak dispatch delay')).not.toBeInTheDocument();
  });

  it('never shows a Total equal to its only component', async () => {
    get.mockResolvedValue({
      ...baseDetail(),
      metrics: [
        { metrics: { tokensInput: 0, tokensOutput: 500 }, timestamp: '2026-01-01T00:00:00Z' },
      ],
    });
    renderPage();

    await screen.findByText('Run cost and usage', { selector: 'div' });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
  });

  it('keeps zero token usage visible and labels an unpriced run clearly', async () => {
    get.mockResolvedValue({
      ...baseDetail(),
      metrics: [
        {
          metrics: { tokensInput: 0, tokensOutput: 0 },
          cost: { totalCost: 0, currency: 'USD', priced: false },
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderPage();

    await screen.findByText('Run cost and usage', { selector: 'div' });
    expect(within(usage()).getByText('Unavailable')).toBeInTheDocument();
    expect(within(usage()).getByText('0')).toBeVisible();
  });

  it('reports the share of tokens not attributed to any stage', async () => {
    get.mockResolvedValue({
      ...baseDetail(),
      metrics: [
        {
          stageInstanceId: 'si-1',
          metrics: { tokensInput: 1000, tokensOutput: 500 },
          timestamp: '2026-01-01T00:00:00Z',
        },
        {
          stageInstanceId: null,
          metrics: { tokensInput: 300, tokensOutput: 200 },
          timestamp: '2026-01-01T00:01:00Z',
        },
      ],
    });
    renderPage();

    await screen.findByText('Run cost and usage', { selector: 'div' });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
  });
});

describe('IntentObservabilityPage — Header', () => {
  it('does not render a duplicate phase badge', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();
    await screen.findByText('Test Intent');
    const badges = screen.queryAllByText('RUNNING');
    expect(badges.length).toBe(0);
  });

  it('shows a Running pill (never "Live") while the run has recent activity', async () => {
    get.mockResolvedValue(baseDetail({ status: 'RUNNING', updatedAt: agoIso(60_000) }));
    renderPage();
    const pill = await screen.findByText('Running');
    expect(pill.closest('[data-tone]')).toHaveAttribute('data-tone', 'running');
    expect(pill.closest('[data-tone]')).not.toHaveAttribute('data-stalled');
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('T1: a RUNNING intent without activity for over 30 min is shown as stalled, not live', async () => {
    get.mockResolvedValue(
      baseDetail({
        status: 'RUNNING',
        currentStage: 'intent-capture',
        createdAt: agoIso(3 * HOUR),
        updatedAt: agoIso(2 * HOUR),
      }),
    );
    renderPage();

    const pill = await screen.findByText('Stalled · no activity for 2 h');
    expect(pill.closest('[data-tone]')).toHaveAttribute('data-stalled', 'true');
    expect(pill.closest('[data-tone]')).toHaveAttribute('data-tone', 'warning');
    expect(document.querySelector('[data-pulse]')).toBeNull();
    expect(screen.getByText('Stalled at Intent Capture — no activity for 2 h')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('shows Completed, then how long ago, for a SUCCEEDED intent (never "Completed · 3 days")', async () => {
    const completedAt = agoIso(3 * DAY);
    get.mockResolvedValue(baseDetail({ status: 'SUCCEEDED', completedAt }));
    renderPage();
    await screen.findByText('Test Intent');
    const header = screen.getByRole('heading', { level: 1 }).closest('header') as HTMLElement;
    expect(within(header).getByText('Completed')).toBeInTheDocument();
    const when = within(header).getByText('3 days ago');
    expect(when.tagName).toBe('TIME');
    expect(when).toHaveAttribute('dateTime', completedAt);
    expect(screen.queryByText(/Completed · /)).not.toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });

  it('shows Failed with how long ago for a FAILED intent', async () => {
    get.mockResolvedValue(baseDetail({ status: 'FAILED', completedAt: agoIso(137 * DAY) }));
    renderPage();
    await screen.findByText('Test Intent');
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('137 days ago')).toBeInTheDocument();
  });

  it('header age for a waiting intent is the oldest open gate, not a stage parked beside it', async () => {
    get.mockResolvedValue(
      baseDetail(
        { status: 'WAITING', pendingHumanTaskId: 'gate-1' },
        {
          stages: [
            stage('feasibility', { state: 'WAITING_FOR_HUMAN', parkedAt: agoIso(109 * DAY) }),
            stage('scope-definition', {
              state: 'WAITING_FOR_HUMAN',
              parkedAt: agoIso(137 * DAY),
            }),
          ],
          gates: [
            gate('gate-1', { stageInstanceId: 'si-feasibility', createdAt: agoIso(109 * DAY) }),
            gate('gate-2', {
              stageInstanceId: 'si-scope-definition',
              status: 'answered',
              createdAt: agoIso(137 * DAY),
            }),
          ],
        },
      ),
    );
    renderPage();
    expect(await screen.findByText('Waiting for input · 109 days')).toBeInTheDocument();
  });

  it('shows the scope as a readable badge, never the raw slug', async () => {
    get.mockResolvedValue(baseDetail({ scope: 'mvp-recomposed' }));
    renderPage();
    await screen.findByText('Test Intent');
    expect(screen.getByText('MVP Recomposed')).toBeInTheDocument();
    expect(screen.queryByText('mvp-recomposed')).not.toBeInTheDocument();
  });

  it('wraps the title on small screens and keeps the actions on the title row', async () => {
    get.mockResolvedValue(baseDetail({ title: 'A very long intent title that wraps' }));
    renderPage();
    const heading = await screen.findByRole('heading', { level: 1 });
    const header = heading.closest('header');
    expect(header?.className).toMatch(/\[&_h1\]:max-sm:line-clamp-3/);
    expect(header?.className).toMatch(/max-sm:flex-row/);
  });

  it('O8: names the AI-DLC release next to the title', async () => {
    get.mockResolvedValue(
      baseDetail({
        methodologyRelease: {
          releaseId: 'rel-1',
          sourceSha: 'abcdef1234567',
          importerRevision: 1,
          closureDigest: 'digest-digest-digest',
          upstreamVersion: '1.4.0',
        },
      }),
    );
    renderPage();
    await screen.findByText('Test Intent');
    expect(screen.getByTestId('methodology-release-badge')).toHaveTextContent('AI-DLC 1.4.0');
  });

  it('O9: the title is the only h1 and the header carries no second back link', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();
    await screen.findByText('Test Intent');
    expect(screen.queryByText(/^Space:/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Test Intent' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'MySpace' })).toBeNull();
  });
});

describe('IntentObservabilityPage — Initial prompt', () => {
  it('shows the final user draft and copies it verbatim', async () => {
    const prompt = 'Add account recovery.\n\nKeep existing sessions active.';
    get.mockResolvedValue(baseDetail({ prompt }));
    renderPage();

    expect(
      await screen.findByText(
        (_, element) =>
          element?.classList.contains('select-text') === true && element.textContent === prompt,
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copy initial prompt' }));

    expect(writeText).toHaveBeenCalledWith(prompt);
    expect(screen.getByRole('button', { name: 'Initial prompt copied' })).toBeInTheDocument();
  });

  it('shows an empty state and disables copy when no prompt was recorded', async () => {
    get.mockResolvedValue(baseDetail({ prompt: null }));
    renderPage();

    expect(await screen.findByText('No initial prompt recorded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy initial prompt' })).toBeDisabled();
  });

  it('keeps a long prompt clamped to two lines until the user asks to see the full request', async () => {
    const prompt = `${'Build the account recovery flow. '.repeat(20)}Preserve active sessions.`;
    get.mockResolvedValue(baseDetail({ prompt }));
    renderPage();

    expect(await screen.findByText('Show full request')).toBeInTheDocument();
    const text = screen.getByText(/Preserve active sessions\.$/);
    expect(text).toHaveClass('line-clamp-2');
    expect(text).not.toHaveClass('whitespace-pre-wrap');

    await userEvent.click(screen.getByRole('button', { name: 'Show full request' }));
    expect(screen.getByText(/Preserve active sessions\.$/)).not.toHaveClass('line-clamp-2');
    expect(screen.getByText(/Preserve active sessions\.$/)).toHaveClass('whitespace-pre-wrap');
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('shows a short prompt whole, without a toggle', async () => {
    get.mockResolvedValue(baseDetail({ prompt: 'Add a quantity stepper to the cart.' }));
    renderPage();
    expect(await screen.findByText('Add a quantity stepper to the cart.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show full request' })).not.toBeInTheDocument();
  });

  it('resets expanded prompt and usage details when switching intents', async () => {
    const prompt = `${'Build the account recovery flow. '.repeat(20)}Preserve active sessions.`;
    get
      .mockResolvedValueOnce(
        baseDetail(
          {
            prompt,
          },
          {
            metrics: [
              {
                metrics: { tokensInput: 1000, tokensOutput: 500, agentLaunchMs: 800 },
                timestamp: '2026-01-01T00:00:00Z',
              },
            ],
          },
        ),
      )
      .mockResolvedValueOnce(
        baseDetail(
          { id: 'i2', executionId: 'i2', prompt },
          {
            metrics: [
              {
                metrics: { tokensInput: 2000, tokensOutput: 1000, agentLaunchMs: 900 },
                timestamp: '2026-01-02T00:00:00Z',
              },
            ],
          },
        ),
      );
    renderPage();

    await screen.findByText('Show full request');
    await userEvent.click(screen.getByRole('button', { name: 'Show full request' }));
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
    expect(screen.getByText('Input')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Switch intent' }));

    expect(await screen.findByRole('button', { name: 'Show full request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show less' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('Input')).not.toBeInTheDocument();
  });
});

describe('IntentObservabilityPage — outcome callout (answer first)', () => {
  it('names the open question above the prompt, with one Answer link', async () => {
    const question =
      'Which account recovery option should we support? Specifically: (a) email magic link, (b) SMS one-time code, (c) authenticator app, or (d) a combination of these? Please also say whether existing sessions must survive a recovery.';
    get.mockResolvedValue(
      baseDetail(
        { status: 'WAITING', pendingHumanTaskId: 'gate-1' },
        {
          stages: [stage('intent-capture', { state: 'WAITING_FOR_HUMAN' })],
          gates: [
            gate('gate-1', {
              stageInstanceId: 'si-intent-capture',
              prompt: question,
              createdAt: agoIso(108 * DAY),
            }),
          ],
        },
      ),
    );
    renderPage();

    const callout = await screen.findByText('1 question needs your answer');
    // N3: while someone has to act, the decision leads; the prompt follows it
    // (collapsed) and the progress list comes after both.
    const promptTitle = screen.getByText('Initial prompt');
    const progressTitle = screen.getByText('Execution progress');
    expect(
      callout.compareDocumentPosition(promptTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      promptTitle.compareDocumentPosition(progressTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText(question)).not.toBeInTheDocument();
    expect(screen.queryByText(/Intent Capture · waiting/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: `Answer: ${question}` }));
    expect(await screen.findByTestId('intent-workbench')).toBeInTheDocument();
  });

  it('O3: I3 — two open gates give one line and one link, to the oldest', async () => {
    get.mockResolvedValue(
      baseDetail(
        { status: 'WAITING', pendingHumanTaskId: 'gate-1' },
        {
          stages: [
            stage('feasibility', { state: 'WAITING_FOR_HUMAN' }),
            stage('scope-definition', { state: 'WAITING_FOR_HUMAN' }),
          ],
          gates: [
            gate('gate-1', {
              stageInstanceId: 'si-feasibility',
              prompt: 'What existing internal systems must the gateway integrate with?',
              createdAt: agoIso(108 * DAY),
            }),
            gate('gate-2', {
              stageInstanceId: 'si-scope-definition',
              prompt: 'Which pilot teams are in scope for the MVP?',
              createdAt: agoIso(136 * DAY),
            }),
          ],
        },
      ),
    );
    renderPage();

    expect(await screen.findByText('2 questions need your answer')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Open decisions' })).not.toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /^Answer: / });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('Answer: Which pilot teams are in scope for the MVP?');
    expect(links[0]).toHaveAttribute('href', '/space/p1/intent/i1');
    expect(screen.queryByText(/Open workbench/)).not.toBeInTheDocument();
  });

  it('O3 (staging I3): a stage parked beside an open question is neither counted nor listed', async () => {
    get.mockResolvedValue(
      baseDetail(
        { status: 'WAITING', pendingHumanTaskId: 'gate-1' },
        {
          stages: [
            stage('feasibility', { state: 'WAITING_FOR_HUMAN', parkedAt: agoIso(109 * DAY) }),
            stage('scope-definition', {
              state: 'WAITING_FOR_HUMAN',
              parkedAt: agoIso(137 * DAY),
            }),
          ],
          gates: [
            gate('gate-1', {
              stageInstanceId: 'si-feasibility',
              prompt: 'What existing internal systems must the gateway integrate with?',
              createdAt: agoIso(109 * DAY),
            }),
            gate('gate-2', {
              stageInstanceId: 'si-scope-definition',
              status: 'answered',
              createdAt: agoIso(137 * DAY),
            }),
          ],
        },
      ),
    );
    renderPage();

    expect(await screen.findByText('1 question needs your answer')).toBeInTheDocument();
    expect(screen.queryByText(/stages are waiting|Parked/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View activity/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Answer: / })).toBeInTheDocument();
  });

  it('O11: a review gate is summarised as "Review <stage> · N artifacts" and links to the review', async () => {
    const artifact = (id: string) => ({
      id,
      artifactType: 'document',
      title: `Doc ${id}`,
      createdByExecutionId: 'i1',
      createdByStageInstanceId: 'si-reverse-engineering',
      createdAt: null,
    });
    get.mockResolvedValue(
      baseDetail(
        { status: 'WAITING', pendingHumanTaskId: 'gate-validation' },
        {
          stages: [stage('reverse-engineering', { state: 'WAITING_FOR_HUMAN' })],
          artifacts: Array.from({ length: 9 }, (_, i) => artifact(`a${i}`)),
          gates: [
            gate('gate-validation', {
              kind: 'validation',
              stageInstanceId: 'si-reverse-engineering',
              prompt:
                'Review stage reverse-engineering. Produced artifacts: business-overview, architecture, data-model. Choose approve to continue.',
            }),
          ],
        },
      ),
    );
    renderPage();

    expect(await screen.findByText('1 review needs your answer')).toBeInTheDocument();
    expect(screen.queryByText(/Produced artifacts/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Review: Reverse Engineering' }));
    expect(await screen.findByTestId('review-page')).toBeInTheDocument();
  });

  it('does not guess why a WAITING run has no pending gate', async () => {
    get.mockResolvedValue(baseDetail({ status: 'WAITING' }));
    renderPage();

    await screen.findByRole('heading', { name: 'Test Intent' });
    const callout = document.querySelector('[data-outcome]') as HTMLElement;
    expect(callout).toHaveAttribute('data-outcome', 'waiting_engine');
    expect(callout).toHaveTextContent('no action needed from you');
    expect(screen.queryByRole('list', { name: 'Open decisions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Answer/ })).not.toBeInTheDocument();
  });

  it('T3: a failed run names the stage and the reason, offers the restart in place, and ignores stale gates', async () => {
    rewind.mockResolvedValue({});
    compiled.mockResolvedValue({
      scopeGrid: {},
      graph: {
        nodes: [{ stageId: 'reverse-engineering', phasePath: '01', order: 0 }],
        edges: [],
      },
    });
    get.mockResolvedValue(
      baseDetail(
        {
          status: 'FAILED',
          currentStage: 'reverse-engineering',
          failure: { code: 'not_implemented', message: 'not_implemented: mode pipeline' },
        },
        {
          stages: [stage('reverse-engineering', { state: 'FAILED' })],
          gates: [gate('stale-gate', { prompt: 'A stale question' })],
        },
      ),
    );
    renderPage();

    const callout = await screen.findByText(/^Failed at Reverse Engineering — /);
    expect(callout.closest('[data-outcome]')).toHaveAttribute('data-outcome', 'failed');
    expect(screen.queryByText('A stale question')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View activity' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restart from Reverse Engineering' }));
    expect(rewind).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Restart from Reverse Engineering?',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart from this stage' }));
    await waitFor(() => expect(rewind).toHaveBeenCalledWith('p1', 'i1', expect.anything()));
  });

  it('T3: I8 — names the stage from the legacy failureReason when failure.message lacks it', async () => {
    get.mockResolvedValue(
      baseDetail(
        {
          status: 'FAILED',
          currentStage: 'state-init',
          failure: { code: 'not_implemented', message: 'mode pipeline' },
          failureReason: 'stage_failed: reverse-engineering: not_implemented: mode pipeline',
        },
        { stages: [stage('state-init'), { ...stage('x'), stageId: null, state: 'FAILED' }] },
      ),
    );
    renderPage();

    expect(await screen.findByText(/^Failed at Reverse Engineering — /)).toBeInTheDocument();
    expect(screen.queryByText(/State Init/)).not.toBeInTheDocument();
  });

  it('T3: a run that failed before any stage offers "Restart workflow" behind a confirmation, then starts the intent', async () => {
    start.mockResolvedValue({});
    sharedChannels.mockResolvedValue({ pinningEnabled: true });
    get.mockResolvedValue(baseDetail({ status: 'FAILED', failureReason: 'workspace init failed' }));
    renderPage();

    await screen.findByText(/^Failed before the first stage/);
    expect(screen.queryByRole('button', { name: 'Start again' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    expect(start).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Restart this workflow from the beginning?',
    });
    expect(dialog).toHaveTextContent(/stays in history/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep run' }));
    expect(start).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Restart workflow',
      }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledWith('p1', 'i1'));
    expect(rewind).not.toHaveBeenCalled();
    // The other AI-DLC version is an item of the actions menu, not a second button here.
    expect(screen.queryByRole('link', { name: 'Start on another AI-DLC version' })).toBeNull();
  });

  it('shows the error when a restart is refused', async () => {
    start.mockRejectedValue(new Error('Run cannot be started right now'));
    get.mockResolvedValue(baseDetail({ status: 'FAILED' }));
    renderPage();

    await screen.findByText(/^Failed before the first stage/);
    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Restart workflow',
      }),
    );
    expect(await screen.findByText('Run cannot be started right now')).toBeInTheDocument();
  });

  it('O1: I6 — a completed run shows its duration and the pull request as its one action', async () => {
    get.mockResolvedValue(
      baseDetail(
        {
          status: 'SUCCEEDED',
          branch: 'aidlc/cf2-v2618-express',
          createdAt: '2026-07-01T10:00:00Z',
          completedAt: '2026-07-01T12:14:00Z',
        },
        {
          pullRequests: [
            {
              id: 'pr-1',
              repository: 'eipasteur/retail-store-cart',
              prUrl: 'https://github.com/eipasteur/retail-store-cart/pull/57',
              prNumber: '57',
              branch: 'aidlc/cf2-v2618-express',
              baseBranch: 'main',
              createdAt: null,
            },
          ],
          artifacts: Array.from({ length: 7 }, (_, i) => ({
            id: `a${i}`,
            artifactType: 'document',
            title: `Doc ${i}`,
            createdByExecutionId: 'i1',
            createdByStageInstanceId: null,
            createdAt: null,
          })),
        },
      ),
    );
    renderPage();

    const pr = await screen.findByRole('link', { name: 'PR #57 · retail-store-cart' });
    expect(pr).toHaveAttribute('href', 'https://github.com/eipasteur/retail-store-cart/pull/57');
    const promptTitle = screen.getByText('Initial prompt');
    const progressTitle = screen.getByText('Execution progress');
    expect(promptTitle.compareDocumentPosition(pr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      pr.compareDocumentPosition(progressTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('Completed in 2 h 14 min')).toBeInTheDocument();
    expect(pr.closest('[data-outcome]')).not.toHaveTextContent(
      /aidlc\/cf2-v2618-express|documents/,
    );
    expect(screen.queryByRole('button', { name: 'Check delivery' })).not.toBeInTheDocument();
  });

  it('N3: a failed run leads with the failure, the prompt follows', async () => {
    get.mockResolvedValue(
      baseDetail(
        {
          status: 'FAILED',
          currentStage: 'reverse-engineering',
          failureReason: 'stage_failed: reverse-engineering: unsupported_mode: x',
          updatedAt: agoIso(2 * DAY),
        },
        { stages: [stage('reverse-engineering', { state: 'FAILED' })] },
      ),
    );
    renderPage();
    const callout = await screen.findByText(/Failed at Reverse Engineering/);
    const promptTitle = screen.getByText('Initial prompt');
    expect(
      callout.compareDocumentPosition(promptTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('N3: a stalled run leads with the stall, the prompt follows', async () => {
    get.mockResolvedValue(
      baseDetail({
        status: 'RUNNING',
        currentStage: 'intent-capture',
        createdAt: agoIso(120 * DAY),
        updatedAt: agoIso(120 * DAY),
      }),
    );
    renderPage();
    const callout = await screen.findByText(/Stalled/, { selector: '[data-outcome] *' });
    const promptTitle = screen.getByText('Initial prompt');
    expect(
      callout.compareDocumentPosition(promptTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('O1: I4 — a cancelled run says what was integrated in its one line', async () => {
    get.mockResolvedValue(
      baseDetail(
        { status: 'CANCELLED', branch: 'aidlc/cart-badge', completedAt: agoIso(5 * DAY) },
        {
          units: [
            { slug: 'u1', state: 'MERGED' },
            { slug: 'u2', state: 'MERGED' },
            { slug: 'u3', state: 'PENDING' },
          ],
        },
      ),
    );
    renderPage();

    expect(
      await screen.findByText(
        'Cancelled 5 days ago · 2 of 3 units integrated before the run stopped',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('aidlc/cart-badge')).not.toBeInTheDocument();
  });

  it('I7: a draft points to the compose page', async () => {
    get.mockResolvedValue(baseDetail({ status: 'DRAFT' }));
    renderPage();

    expect(await screen.findByText('Draft — not started yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue composing' })).toHaveAttribute(
      'href',
      '/space/p1/intent/i1/compose',
    );
  });

  describe('for a member who cannot decide the stage', () => {
    beforeEach(() => {
      mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'member' } });
      getResponsibilities.mockResolvedValue({
        stages: [
          {
            stageId: 'reverse-engineering',
            stageInstanceId: 'si-reverse-engineering',
            access: { edit: false, decide: false },
          },
        ],
      });
    });

    it('disables the restart the backend would refuse', async () => {
      compiled.mockResolvedValue({
        scopeGrid: {},
        graph: {
          nodes: [{ stageId: 'reverse-engineering', phasePath: '01', order: 0 }],
          edges: [],
        },
      });
      get.mockResolvedValue(
        baseDetail(
          {
            status: 'FAILED',
            currentStage: 'reverse-engineering',
            failure: { code: 'not_implemented', message: 'not_implemented: mode pipeline' },
          },
          { stages: [stage('reverse-engineering', { state: 'FAILED' })] },
        ),
      );
      renderPage();
      await waitFor(() => expect(getResponsibilities).toHaveBeenCalled());
      expect(
        await screen.findByRole('button', { name: 'Restart from Reverse Engineering' }),
      ).toBeDisabled();
    });

    it('disables Resume when the answer to re-send is not theirs to give', async () => {
      get.mockResolvedValue(
        baseDetail(
          { status: 'WAITING', resumeRequired: true },
          {
            gates: [
              gate('gate-1', {
                stageInstanceId: 'si-reverse-engineering',
                status: 'answered',
                resumeAvailable: true,
              }),
            ],
          },
        ),
      );
      renderPage();
      expect(await screen.findByRole('button', { name: 'Resume run' })).toBeDisabled();
    });
  });

  it('offers Resume when a recorded answer still has to reach the run', async () => {
    resume.mockResolvedValue({});
    get.mockResolvedValue(baseDetail({ status: 'WAITING', resumeRequired: true }));
    renderPage();

    expect(
      await screen.findByText('Your answer was saved but the run did not continue'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith('p1', 'i1'));
  });
});

describe('IntentObservabilityPage — Actions', () => {
  it('shows action menu with Cancel for WAITING status', async () => {
    get.mockResolvedValue(baseDetail({ status: 'WAITING' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(screen.getByRole('menuitem', { name: 'Cancel run' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete intent' })).toBeInTheDocument();
  });

  it('RUNNING non-admin: Audit, Cancel run disabled with the reason, no Delete', async () => {
    mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'member' } });
    get.mockResolvedValue(baseDetail({ status: 'RUNNING' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(screen.getByRole('menuitem', { name: 'Audit' })).toBeInTheDocument();
    const cancelItem = screen.getByRole('menuitem', { name: /Cancel run/ });
    expect(cancelItem).toHaveAttribute('aria-disabled', 'true');
    expect(cancelItem).toHaveTextContent('The engine still reports this run as running');
    expect(screen.queryByRole('menuitem', { name: 'Delete intent' })).not.toBeInTheDocument();
  });

  it('O8: offers "Start a new intent on another AI-DLC version" like the Work header when pinning is enabled', async () => {
    sharedChannels.mockResolvedValue({ pinningEnabled: true });
    get.mockResolvedValue(baseDetail());
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(
      await screen.findByRole('menuitem', { name: 'Start a new intent on another AI-DLC version' }),
    ).toBeInTheDocument();
  });

  it('shows Delete for owner even when RUNNING is disallowed (shows for SUCCEEDED)', async () => {
    get.mockResolvedValue(baseDetail({ status: 'SUCCEEDED' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(screen.queryByRole('menuitem', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete intent' })).toBeInTheDocument();
  });

  it('Cancel asks for confirmation in a dialog (no native confirm) then calls the service', async () => {
    cancel.mockResolvedValue({ status: 'CANCELLED' });
    get.mockResolvedValue(baseDetail({ status: 'WAITING' }));
    window.confirm = vi.fn(() => true);
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this run?' });
    expect(dialog).toHaveTextContent('will stop and its pending questions will be retired');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('p1', 'i1'));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('Cancel on FAILED intent uses status-aware confirmation copy', async () => {
    cancel.mockResolvedValue({ status: 'CANCELLED' });
    get.mockResolvedValue(baseDetail({ status: 'FAILED' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Close failed run' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Close this failed run?' });
    expect(dialog).toHaveTextContent('failed run');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close failed run' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('p1', 'i1'));
  });

  it('Delete opens confirmation dialog then navigates to space on success', async () => {
    deleteIntent.mockResolvedValue(undefined);
    get.mockResolvedValue(baseDetail({ status: 'SUCCEEDED' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete intent' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this intent?' });
    expect(dialog).toHaveTextContent(/permanently removed/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete intent' }));
    await waitFor(() => expect(deleteIntent).toHaveBeenCalledWith('p1', 'i1'));
    expect(await screen.findByTestId('space-page')).toBeInTheDocument();
  });

  it('reports a failed delete and keeps the page', async () => {
    deleteIntent.mockRejectedValue(new Error('Delete refused'));
    get.mockResolvedValue(baseDetail({ status: 'SUCCEEDED' }));
    renderPage();
    await userEvent.click(await screen.findByLabelText('Intent actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete intent' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this intent?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete intent' }));

    expect(await screen.findByText('Delete refused')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Test Intent' })).toBeInTheDocument();
  });

  it('hides Delete for non-owner/admin users', async () => {
    mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'member' } });
    get.mockResolvedValue(baseDetail({ status: 'WAITING' }));
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    expect(screen.getByRole('menuitem', { name: 'Cancel run' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete intent' })).not.toBeInTheDocument();
  });

  it('N11: offers the same items as the Work header; Reshape is disabled with its reason while running', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems.slice(0, 4).map((item) => item.textContent?.trim())).toEqual([
      'Intent configuration',
      'Reshape remaining stagesOnly while the run is waiting or has failed',
      'Download workspace',
      'Audit',
    ]);
    expect(menuItems.slice(0, 4).map((item) => item.getAttribute('aria-disabled'))).toEqual([
      null,
      'true',
      null,
      null,
    ]);
  });

  it('N11: Reshape opens the reshape dialog on a waiting run; Download workspace asks for confirmation', async () => {
    get.mockResolvedValue(
      baseDetail(
        { status: 'WAITING', pendingHumanTaskId: 'gate-1' },
        {
          stages: [stage('intent-capture', { state: 'WAITING_FOR_HUMAN' })],
          gates: [gate('gate-1', { stageInstanceId: 'si-intent-capture' })],
        },
      ),
    );
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    const reshape = screen.getByRole('menuitem', { name: 'Reshape remaining stages' });
    expect(reshape).not.toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(reshape);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(await screen.findByLabelText('Intent actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download workspace' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Continue outside Collaborative AI-DLC?')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('explains a refused workspace download like the Work page', async () => {
    exportWorkflow.mockRejectedValue(
      new ApiError(409, 'edited', {
        code: 'export_edited_blocks',
        incompatibleBlocks: ['STAGE:custom-review'],
      }),
    );
    get.mockResolvedValue(baseDetail({ status: 'WAITING' }));
    renderPage();
    await userEvent.click(await screen.findByLabelText('Intent actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Download workspace' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Download workspace' }));
    expect(
      await screen.findByText(
        /methodology blocks customized in Collaborative AI-DLC: stage custom-review/,
      ),
    ).toBeInTheDocument();
  });

  it('N19: the header carries Discuss next to the actions menu, like the Work header', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    const discuss = screen.getByTestId('discuss');
    expect(discuss).toHaveAttribute('data-entity', 'intent');
    expect(discuss).toHaveAttribute('data-entity-title', 'Test Intent');
    // Same parent as the "…" trigger: one actions cluster, Discuss first.
    expect(discuss.parentElement).toBe(menu.parentElement);
    expect(discuss.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('clicking Audit in menu navigates to the audit route', async () => {
    get.mockResolvedValue(baseDetail());
    renderPage();
    const menu = await screen.findByLabelText('Intent actions');
    await userEvent.click(menu);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Audit' }));
    expect(await screen.findByTestId('audit-page')).toBeInTheDocument();
  });
});

describe('IntentObservabilityPage — spend and stages run', () => {
  it('quotes the intent spend so far, every attempt included, before a restart', async () => {
    const sample = (totalCost: number, timestamp: string) => ({
      stageInstanceId: 'si-a',
      metrics: { tokensInput: 1000, tokensOutput: 100 },
      timestamp,
      cost: { totalCost, currency: 'USD', priced: true },
    });
    get.mockResolvedValue(
      baseDetail(
        { status: 'FAILED', failureReason: 'workspace init failed' },
        { metrics: [sample(4, '2026-01-01T00:00:00Z'), sample(6, '2026-01-02T00:00:00Z')] },
      ),
    );
    renderPage();

    await screen.findByText(/^Failed before the first stage/);
    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('So far this intent has cost $10.00.');
    expect(dialog).not.toHaveTextContent(/previous run cost/);
  });
});

describe('IntentObservabilityPage — switching intents', () => {
  it("switching intents drops the previous intent's error and pending action", async () => {
    start.mockRejectedValueOnce(new Error('Run cannot be started right now'));
    let finishRestart: () => void = () => {};
    get.mockImplementation((_p: string, id: string) =>
      Promise.resolve(
        baseDetail({
          id,
          executionId: id,
          title: id === 'i1' ? 'First intent' : 'Second intent',
          status: 'FAILED',
        }),
      ),
    );
    renderPage();

    await screen.findByRole('heading', { name: 'First intent' });
    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Restart workflow',
      }),
    );
    expect(await screen.findByText('Run cannot be started right now')).toBeInTheDocument();

    // A restart still in flight on i1 when the reader moves on.
    start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRestart = resolve;
        }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Restart workflow',
      }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('link', { name: 'Switch intent' }));
    await screen.findByRole('heading', { name: 'Second intent' });
    expect(screen.queryByText('Run cannot be started right now')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restart workflow' })).toBeEnabled();
    finishRestart();
  });
});

describe('IntentObservabilityPage — restart target', () => {
  it('names the stage it rewinds when two stages failed', async () => {
    rewind.mockResolvedValue({});
    compiled.mockResolvedValue({
      scopeGrid: {},
      graph: {
        nodes: [
          { stageId: 'code-generation', phasePath: '03', order: 0 },
          { stageId: 'build-and-test', phasePath: '03', order: 1 },
        ],
        edges: [],
      },
    });
    get.mockResolvedValue(
      baseDetail(
        {
          status: 'FAILED',
          currentStage: 'build-and-test',
          failure: { code: 'agent_error', message: 'agent_error: boom' },
        },
        {
          // API order is the stage key order, not the plan order.
          stages: [
            stage('build-and-test', { state: 'FAILED' }),
            stage('code-generation', { state: 'FAILED' }),
          ],
        },
      ),
    );
    renderPage();

    expect(await screen.findByText(/^Failed at Code Generation — /)).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Restart from Code Generation' }),
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Restart from Code Generation?',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart from this stage' }));
    await waitFor(() =>
      expect(rewind).toHaveBeenCalledWith(
        'p1',
        'i1',
        expect.objectContaining({ fromStageId: 'code-generation' }),
      ),
    );
  });
});

describe('IntentObservabilityPage — stalled hand-off', () => {
  it('a stalled run the orchestrator claimed is not "never picked up"', async () => {
    get.mockResolvedValue(
      baseDetail({
        status: 'CREATED',
        orchestratorStartedAt: agoIso(45 * 60_000),
        createdAt: agoIso(46 * 60_000),
        updatedAt: agoIso(45 * 60_000),
      }),
    );
    renderPage();

    await screen.findByRole('heading', { name: 'Test Intent' });
    const callout = document.querySelector('[data-outcome]') as HTMLElement;
    expect(callout).toHaveTextContent('Stalled while preparing the workspace — no activity for');
    expect(callout).not.toHaveTextContent(/never picked up|requested/);
  });
});

describe('IntentObservabilityPage — viewer access (#777)', () => {
  const failedBeforeAnyStage = () =>
    baseDetail({ status: 'FAILED', failureReason: 'workspace init failed' });
  const resumeOwed = () =>
    baseDetail(
      { status: 'WAITING', resumeRequired: true },
      {
        gates: [gate('gate-1', { stageInstanceId: 'si-intent-capture', status: 'answered' })].map(
          (g) => ({ ...g, resumeAvailable: true }),
        ),
      },
    );

  it('a viewer gets the restart, resume, reshape, download and close disabled like on the Work page', async () => {
    mockReadOnly.mockReturnValue(true);
    mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'viewer' } });
    get.mockResolvedValue(failedBeforeAnyStage());
    renderPage();

    await screen.findByText(/^Failed before the first stage/);
    await waitFor(() => expect(getResponsibilities).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Restart workflow' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Intent actions'));
    const download = screen.getByRole('menuitem', { name: /Download workspace/ });
    expect(download).toHaveAttribute('aria-disabled', 'true');
    expect(download).toHaveTextContent('You have view-only access to this space.');
    const reshape = screen.getByRole('menuitem', { name: /Reshape remaining stages/ });
    expect(reshape).toHaveAttribute('aria-disabled', 'true');
    expect(reshape).toHaveTextContent('You have view-only access to this space.');
    expect(screen.queryByRole('menuitem', { name: /Close failed run|Cancel run/ })).toBeNull();
  });

  it('a viewer cannot resume a run even when the stage roles let everyone decide', async () => {
    mockReadOnly.mockReturnValue(true);
    mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'viewer' } });
    get.mockResolvedValue(resumeOwed());
    renderPage();

    await waitFor(() => expect(getResponsibilities).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Resume run' })).toBeDisabled();
  });

  it('a member gets the same actions enabled', async () => {
    mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'member' } });
    get.mockResolvedValue(failedBeforeAnyStage());
    renderPage();

    await screen.findByText(/^Failed before the first stage/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Restart workflow' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByLabelText('Intent actions'));
    expect(screen.getByRole('menuitem', { name: /Download workspace/ })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(screen.getByRole('menuitem', { name: /Reshape remaining stages/ })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Close failed run' })).toBeInTheDocument();
  });

  it('a member who may decide gets Resume enabled', async () => {
    mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'member' } });
    get.mockResolvedValue(resumeOwed());
    renderPage();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume run' })).toBeEnabled());
  });
});

describe('IntentObservabilityPage — readers who cannot answer', () => {
  describe('a question the reader cannot answer', () => {
    const waiting = () =>
      baseDetail(
        { status: 'WAITING', pendingHumanTaskId: 'gate-1' },
        {
          stages: [stage('intent-capture', { state: 'WAITING_FOR_HUMAN' })],
          gates: [gate('gate-1', { stageInstanceId: 'si-intent-capture', prompt: 'Which DB?' })],
        },
      );

    it('reads neutrally with a View link for a member without the decision', async () => {
      mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'member' } });
      getResponsibilities.mockResolvedValue({
        stages: [
          {
            stageId: 'intent-capture',
            stageInstanceId: 'si-intent-capture',
            access: { edit: true, decide: false },
          },
        ],
      });
      get.mockResolvedValue(waiting());
      renderPage();

      await waitFor(() => expect(getResponsibilities).toHaveBeenCalled());
      expect(await screen.findByText('1 question waiting for an answer')).toBeInTheDocument();
      expect(screen.queryByText(/needs your answer/)).toBeNull();
      expect(screen.queryByRole('link', { name: /^Answer/ })).toBeNull();
      expect(screen.getByRole('link', { name: 'View: Which DB?' })).toHaveAttribute(
        'href',
        '/space/p1/intent/i1',
      );
    });

    it('reads neutrally for a viewer', async () => {
      mockReadOnly.mockReturnValue(true);
      get.mockResolvedValue(waiting());
      renderPage();

      await waitFor(() => expect(getResponsibilities).toHaveBeenCalled());
      expect(await screen.findByText('1 question waiting for an answer')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /^Answer/ })).toBeNull();
    });

    it('still asks a member who may decide', async () => {
      mockProjectCache.mockReturnValue({ project: { name: 'MySpace', userRole: 'member' } });
      get.mockResolvedValue(waiting());
      renderPage();

      expect(await screen.findByText('1 question needs your answer')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Answer: Which DB?' })).toBeInTheDocument();
    });
  });
});

describe('IntentObservabilityPage — resume refusals', () => {
  describe('Resume refusals, like the Work page', () => {
    const owed = () =>
      baseDetail(
        { status: 'WAITING', resumeRequired: true },
        { gates: [{ ...gate('gate-1', { status: 'answered' }), resumeAvailable: true }] },
      );

    it('409: re-reads the run, drops Resume and points at rewind', async () => {
      get
        .mockResolvedValueOnce(owed())
        .mockResolvedValue(baseDetail({ status: 'FAILED', resumeRequired: null }));
      resume.mockRejectedValue(
        new ApiError(409, 'Durable execution expired before this answer could resume the run', {
          code: 'durable_execution_expired',
        }),
      );
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: 'Resume run' }));
      expect(await screen.findByText('This run can no longer be resumed')).toBeInTheDocument();
      expect(screen.getByText(/rewind to the stage you want to re-run/i)).toBeInTheDocument();
      expect(get).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
    });

    it('503: keeps Resume and says to try again', async () => {
      get.mockResolvedValue(owed());
      resume.mockRejectedValue(
        new ApiError(503, 'The durable callback could not be completed.', {
          code: 'durable_callback_resume_failed',
          retryable: true,
        }),
      );
      renderPage();

      await userEvent.click(await screen.findByRole('button', { name: 'Resume run' }));
      expect(await screen.findByText('Resume did not go through')).toBeInTheDocument();
      expect(screen.getByText(/try Resume again in a moment/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Resume run' })).toBeEnabled();
    });
  });
});
