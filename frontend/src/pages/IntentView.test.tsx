import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { formatTimelineTimestamp } from '@/lib/timeAgo';
import { invalidateIntentGraph } from '@/hooks/useIntentGraph';

const yjsMock = vi.hoisted(() => ({ docs: new Map<string, unknown>() }));
const projectCacheMock = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'member',
  name: 'Bookstore Tracker',
  // Space list row for the header placeholder while the detail loads.
  summary: null as Record<string, unknown> | null,
}));

// Heavy leaf components are stubbed to simple markers — these tests exercise
// IntentView's OWN rendering logic (DRAFT card, pipeline, gates, artifacts)
// through a real IntentProvider (mocked services), not Yjs/realtime.
vi.mock('@/components/QuestionEditor', () => ({
  default: ({ question }: { question: { id: string } }) => (
    <div data-testid="question-editor" data-gate={question.id} />
  ),
}));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: ({
    entityType,
    entityId,
    entityTitle,
  }: {
    entityType: string;
    entityId?: string;
    entityTitle?: string;
  }) => (
    <button
      data-testid="discuss"
      data-entity={entityType}
      data-entity-id={entityId}
      data-entity-title={entityTitle}
    />
  ),
}));
vi.mock('@/hooks/useYjsDocument', async () => {
  const Y = await import('yjs');
  return {
    useYjsDocument: (documentId: string | null) => {
      if (!documentId) {
        return { doc: null, synced: false, remoteUsers: new Map(), setCursor: vi.fn() };
      }
      let doc = yjsMock.docs.get(documentId);
      if (!doc) {
        doc = new Y.Doc();
        yjsMock.docs.set(documentId, doc);
      }
      return { doc, synced: true, remoteUsers: new Map(), setCursor: vi.fn() };
    },
  };
});
vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'U', email: 'u@x' } }),
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => ({
    project: { name: projectCacheMock.name, userRole: projectCacheMock.role },
  }),
  getCachedIntentSummary: () => projectCacheMock.summary ?? undefined,
}));

// Version pinning (issue #482) is off unless a test turns it on; the real
// service would hit the network and leave it off anyway.
const sharedChannels = vi.fn();
const pinningOff = () => sharedChannels.mockReset().mockResolvedValue({ pinningEnabled: false });
pinningOff();
vi.mock('@/services/aidlcReleases', () => ({
  aidlcReleasesService: { sharedChannels: (...a: unknown[]) => sharedChannels(...a) },
}));

const getResponsibilities = vi.fn();
vi.mock('@/services/stageResponsibilities', () => ({
  stageResponsibilitiesService: { get: (...args: unknown[]) => getResponsibilities(...args) },
}));
const get = vi.fn();
const start = vi.fn();
const rewind = vi.fn();
const answerGate = vi.fn();
const repair = vi.fn();
const exportWorkflow = vi.fn();
const cancel = vi.fn();
const resume = vi.fn();
const del = vi.fn();
const writeText = vi.fn();
const graph = vi.fn();
const compiled = vi.fn();
const workflowGet = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    start: (...a: unknown[]) => start(...a),
    rewind: (...a: unknown[]) => rewind(...a),
    answerGate: (...a: unknown[]) => answerGate(...a),
    repair: (...a: unknown[]) => repair(...a),
    exportWorkflow: (...a: unknown[]) => exportWorkflow(...a),
    cancel: (...a: unknown[]) => cancel(...a),
    resume: (...a: unknown[]) => resume(...a),
    delete: (...a: unknown[]) => del(...a),
    outputs: () => Promise.resolve({ outputs: [], cursor: 0, more: false }),
    // Knowledge graph feeding the popovers/derived-items section — empty
    // graph keeps those affordances out of these page-behavior tests.
    graph: (...a: unknown[]) => graph(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: (...a: unknown[]) => compiled(...a),
    get: (...a: unknown[]) => workflowGet(...a),
  },
}));

import IntentView from './IntentView';
import { ApiError } from '@/services/api';
import { IntentProvider, clearIntentCache, useIntent } from '@/contexts/IntentContext';

// Exposes which stage output the page last asked the activity panel to show.
function ActivityTabProbe() {
  const { agentFocus } = useIntent();
  return <span data-testid="activity-tab">{agentFocus?.key ?? ''}</span>;
}

// Several suites use the same synthetic p1/i1 identity but supply different
// graph fixtures. Reset the shared graph cache as well as IntentContext state.
beforeEach(() => invalidateIntentGraph('p1', 'i1'));

const renderAt = (initialEntry = '/space/p1/intent/i1') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/space/:projectId/intent/:intentId"
          element={
            <IntentProvider>
              <IntentView />
              <ActivityTabProbe />
            </IntentProvider>
          }
        />
        <Route
          path="/space/:projectId/intent/:intentId/review/:humanTaskId"
          element={
            <IntentProvider>
              <IntentView />
            </IntentProvider>
          }
        />
        <Route path="/space/:projectId/settings" element={<div data-testid="space-settings" />} />
        <Route path="/space/:projectId" element={<div data-testid="space-page" />} />
        <Route path="/account/settings" element={<div data-testid="account-settings" />} />
      </Routes>
    </MemoryRouter>,
  );

const openExportDialog = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Intent actions' }));
  await userEvent.click(screen.getByRole('menuitem', { name: /^Download workspace/ }));
  expect(await screen.findByText('Continue outside Collaborative AI-DLC?')).toBeInTheDocument();
};

const baseDetail = (over: Record<string, unknown> = {}) => ({
  intent: {
    id: 'i1',
    executionId: 'i1',
    projectId: 'p1',
    title: 'My intent',
    prompt: 'Build X',
    status: 'DRAFT',
    branch: 'aidlc/i1',
    baseBranch: 'main',
    repos: ['owner/repo'],
    gitProvider: 'github',
    workflowId: 'aidlc-v2',
    workflowVersion: 1,
    scope: 'feature',
    currentPhase: null,
    currentStage: null,
    pendingHumanTaskId: null,
    cliModels: null,
    environment: null,
    parkReleaseSeconds: 300,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    ...over,
  },
  stages: [],
  events: [],
  gates: [],
  metrics: [],
  outputs: [],
  sensorRuns: [],
  artifacts: [],
});

describe('IntentView', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    getResponsibilities.mockReset().mockResolvedValue({
      unattributedAccess: { decide: true, edit: true },
      stages: [
        { stageInstanceId: 'si-a', reason: 'unmapped', access: { decide: true, edit: true } },
      ],
    });
    start.mockReset();
    rewind.mockReset();
    answerGate.mockReset();
    repair.mockReset();
    exportWorkflow.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    writeText.mockReset().mockResolvedValue(undefined);
    window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    projectCacheMock.role = 'owner';
    projectCacheMock.name = 'Bookstore Tracker';
    projectCacheMock.summary = null;
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
    yjsMock.docs.clear();
  });

  it.each([true, false])(
    'uses the first non-automatic stage for Cancel run (decide=%s)',
    async (decide) => {
      projectCacheMock.role = 'member';
      get.mockResolvedValue(baseDetail({ status: 'CREATED', currentStage: null }));
      const stages = [
        {
          stageId: 'workspace-scaffold',
          permissions: { automatic: true },
          access: { edit: false, decide: false },
        },
        {
          stageId: 'workspace-detection',
          permissions: { automatic: true },
          access: { edit: false, decide: false },
        },
        {
          stageId: 'intent-capture',
          permissions: { automatic: false },
          access: { edit: decide, decide },
        },
        // Permission on a later stage must not grant permission to cancel.
        {
          stageId: 'code',
          permissions: { automatic: false },
          access: { edit: true, decide: true },
        },
      ];
      getResponsibilities.mockResolvedValue({ stages });
      compiled.mockResolvedValue({
        graph: {
          nodes: stages.map((stage, order) => ({ stageId: stage.stageId, phasePath: '01', order })),
          edges: [],
        },
      });
      renderAt();
      await userEvent.click(await screen.findByRole('button', { name: 'Intent actions' }));
      if (decide)
        expect(await screen.findByRole('menuitem', { name: 'Cancel run' })).toBeInTheDocument();
      else expect(screen.queryByRole('menuitem', { name: 'Cancel run' })).not.toBeInTheDocument();
    },
  );

  it('R3-1: a 404 reads "This intent no longer exists" with a way back, no Retry, no connection copy', async () => {
    get.mockRejectedValue(new ApiError(404, 'Intent not found'));
    renderAt();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This intent no longer exists' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to space' })).toHaveAttribute(
      'href',
      '/space/p1',
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText(/check your connection/i)).toBeNull();
  });

  it('R3-1: a network failure keeps the connection copy and a Retry', async () => {
    get.mockRejectedValueOnce(new Error('Temporary network failure'));
    renderAt();
    expect(
      await screen.findByRole('heading', { level: 1, name: "Couldn't load this intent" }),
    ).toBeVisible();
    expect(screen.getByText(/check your connection/i)).toBeVisible();
    get.mockResolvedValueOnce(baseDetail({ status: 'WAITING' }));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('DRAFT redirects to the collaborative compose page (one canonical draft UI)', async () => {
    get.mockResolvedValue(baseDetail());
    render(
      <MemoryRouter initialEntries={['/space/p1/intent/i1']}>
        <Routes>
          <Route
            path="/space/:projectId/intent/:intentId"
            element={
              <IntentProvider>
                <IntentView />
              </IntentProvider>
            }
          />
          <Route
            path="/space/:projectId/intent/:intentId/compose"
            element={<div data-testid="compose-page" />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('compose-page')).toBeInTheDocument();
  });

  it.each(['credential_unavailable', 'credential_quota_exhausted'])(
    'links %s to its pinned credential settings',
    async (code) => {
      get.mockResolvedValue(
        baseDetail({
          status: 'FAILED',
          agentCli: 'kiro',
          credentialSource: 'space',
          failureReason: 'stage_failed: backend wording may change independently',
          failure: {
            code,
            message:
              'The Space Kiro credential pinned to this run is no longer available. A Space owner or admin must restore or rotate it in Space Settings, then restart the run. Active runs do not fall back to Platform credentials.',
          },
        }),
      );
      renderAt();

      const title = await screen.findByText(/agent credential (ran out of quota|was available)/);
      expect(title.closest('[data-slot="intent-outcome"]')).toHaveAttribute(
        'data-outcome',
        'failed',
      );
      expect(screen.queryByText(/stage_failed:/)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/The Space Kiro credential pinned to this run is no longer available/),
      ).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Credential settings' }));
      expect(await screen.findByTestId('space-settings')).toBeInTheDocument();
    },
  );

  it.each(['workspace_restore_failed', 'resume_state_unavailable', 'resume_state_conflict'])(
    'offers targeted retry for a failed stage after %s',
    async (runtimeError) => {
      compiled.mockResolvedValue({
        graph: {
          nodes: [
            { stageId: 'requirements-analysis', phasePath: '01', order: 0 },
            { stageId: 'units-generation', phasePath: '01', order: 1 },
          ],
          edges: [],
        },
      });
      get.mockResolvedValue({
        ...baseDetail({
          status: 'FAILED',
          currentStage: 'units-generation',
          failureReason: 'stage_failed: units-generation',
        }),
        stages: [
          {
            stageInstanceId: 'si-requirements',
            stageId: 'requirements-analysis',
            state: 'SUCCEEDED',
            phase: 'inception',
          },
          {
            stageInstanceId: 'si-units',
            stageId: 'units-generation',
            state: 'FAILED',
            phase: 'inception',
            runtimeError,
          },
        ],
      });
      rewind.mockResolvedValue({});

      renderAt();

      expect(screen.queryByRole('link', { name: 'Run recovery details' })).not.toBeInTheDocument();
      // A rewind re-runs agents (and spends again), so the callout confirms
      // it first; nothing is called until the dialog is confirmed.
      await userEvent.click(
        await screen.findByRole('button', { name: 'Restart from Units Generation' }),
      );
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Restart from Units Generation?',
      });
      expect(rewind).not.toHaveBeenCalled();
      await userEvent.click(
        within(dialog).getByRole('button', { name: 'Restart from this stage' }),
      );
      expect(rewind).toHaveBeenCalledWith('p1', 'i1', { fromStageId: 'units-generation' });
      expect(start).not.toHaveBeenCalled();
    },
  );

  // Full restart from the callout: "Restart workflow" → confirm in the
  // AlertDialog → `intents.start`. Never a rewind.
  const confirmRestartWorkflow = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Restart workflow' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Restart this workflow from the beginning?',
    });
    expect(start).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart workflow' }));
  };

  it('restarts when the only failed stage row is no longer in the compiled plan', async () => {
    compiled.mockResolvedValue({
      graph: {
        nodes: [{ stageId: 'requirements-analysis', phasePath: '01', order: 0 }],
        edges: [],
      },
    });
    get.mockResolvedValue({
      ...baseDetail({
        status: 'FAILED',
        currentStage: 'units-generation',
        failureReason: 'stage_failed: units-generation',
      }),
      stages: [
        {
          stageInstanceId: 'si-units',
          stageId: 'units-generation',
          state: 'FAILED',
          phase: 'inception',
          runtimeError: 'workspace_restore_failed',
        },
      ],
    });
    start.mockResolvedValue({});

    renderAt();

    await confirmRestartWorkflow();
    expect(screen.queryByRole('button', { name: /^Restart from/ })).toBeNull();
    expect(start).toHaveBeenCalledWith('p1', 'i1');
    expect(rewind).not.toHaveBeenCalled();
  });

  it('restarts the workflow when a failed run has no failed stage row', async () => {
    get.mockResolvedValue(
      baseDetail({
        status: 'FAILED',
        failureReason: 'workspace_initialization_failed',
      }),
    );
    start.mockResolvedValue({});

    renderAt();

    await confirmRestartWorkflow();
    expect(start).toHaveBeenCalledWith('p1', 'i1');
    expect(rewind).not.toHaveBeenCalled();
  });

  it('restarts a stalled CREATED handoff even when a stale failed stage row remains', async () => {
    get.mockResolvedValue({
      ...baseDetail({
        status: 'CREATED',
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
      stages: [
        {
          stageInstanceId: 'si-old',
          stageId: 'units-generation',
          state: 'FAILED',
          phase: 'inception',
        },
      ],
    });
    start.mockResolvedValue({});

    renderAt();

    await confirmRestartWorkflow();
    expect(screen.queryByRole('button', { name: /^Restart from/ })).toBeNull();
    expect(start).toHaveBeenCalledWith('p1', 'i1');
    expect(rewind).not.toHaveBeenCalled();
  });

  it('does not call a claimed run stalled while its workspace is still initializing', async () => {
    // An orchestrator claimed the run 10 minutes ago and is still cloning a
    // large repository: CREATED is expected, and a restart would race the clone.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    get.mockResolvedValue(
      baseDetail({
        status: 'CREATED',
        updatedAt: tenMinutesAgo,
        orchestratorStartedAt: tenMinutesAgo,
      }),
    );

    renderAt();

    expect((await screen.findAllByText('My intent')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/never picked up/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart workflow' })).toBeNull();
    // The header pill says it is starting; nothing else is stacked above the work.
    expect(screen.getAllByText(/^Starting/).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-slot="intent-outcome"]')).toBeNull();
  });

  it('calls an unclaimed CREATED hand-off stalled past the shared stall threshold', async () => {
    get.mockResolvedValue(
      baseDetail({
        status: 'CREATED',
        updatedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
        orchestratorStartedAt: null,
      }),
    );

    renderAt();

    expect(
      await screen.findByText(
        'Stalled before the first stage — never picked up, no activity for 45 min',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart workflow' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Run recovery details' })).not.toBeInTheDocument();
    expect(screen.getByText('Stalled · no activity for 45 min')).toBeInTheDocument();
    expect(document.querySelector('[data-pulse]')).toBeNull();
  });

  it('calls a claimed run stalled while preparing its workspace once the init callback window has passed', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    get.mockResolvedValue(
      baseDetail({
        status: 'CREATED',
        updatedAt: threeHoursAgo,
        orchestratorStartedAt: threeHoursAgo,
      }),
    );

    renderAt();

    expect(
      await screen.findByText(/^Stalled while preparing the workspace — no activity for 3 h/),
    ).toBeInTheDocument();
  });

  it('renders one QuestionEditor for the active gate (exclusive expansion)', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'h1' }),
      gates: [
        {
          humanTaskId: 'h1',
          status: 'pending',
          kind: 'question',
          questions: '[{"text":"?","type":"single","options":[{"label":"Y"}]}]',
        },
        {
          humanTaskId: 'h2',
          status: 'pending',
          kind: 'question',
          questions: '[{"text":"Second?","type":"single","options":[{"label":"N"}]}]',
        },
      ],
    });
    renderAt();
    const editors = await screen.findAllByTestId('question-editor');
    expect(editors).toHaveLength(1);
    expect(editors[0].getAttribute('data-gate')).toBe('h1');
  });

  it('moves the immutable environment snapshot into the run configuration dialog', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue(
      baseDetail({
        status: 'RUNNING',
        agentCli: 'claude',
        credentialSource: 'space',
        cliModels: { claude: 'us.anthropic.claude-sonnet-4-6' },
        source: {
          bindingId: 'github',
          provider: 'github',
          instance: null,
          resourceType: 'issue',
          resourceId: '3',
          resourceUrl: 'https://github.com/example/repository/issues/3',
        },
        environment: {
          environmentId: 'polyglot',
          name: 'Polyglot',
          revisionId: 'r-7',
          imageDigest: `sha256:${'a'.repeat(64)}`,
          runtimeVersion: '3',
          runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/polyglot',
          runtimeEndpoint: 'revision_r_7',
          compatibilityVersion: '2',
          verification: { status: 'PASSED' },
        },
      }),
    );
    renderAt();

    expect(await screen.findByText('My intent')).toBeInTheDocument();
    expect(screen.queryByText('Polyglot')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
    expect(screen.queryByText('Source: Issue #3')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Intent actions'));
    await user.click(screen.getByText('Intent configuration'));

    expect(
      await screen.findByRole('heading', { name: 'Intent configuration' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Polyglot')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText(/us\.anthropic\.claude-sonnet-4-6/)).toBeInTheDocument();
    const sourceLabel = screen.getByText('Source: Issue #3');
    expect(sourceLabel).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      'https://github.com/example/repository/issues/3',
    );
    const executionHeading = screen.getByRole('heading', { name: 'Execution' });
    expect(
      sourceLabel.compareDocumentPosition(executionHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.getByText('r-7')).toBeInTheDocument();
    expect(screen.getByText('revision_r_7')).toBeInTheDocument();
    expect(screen.getAllByText('PASSED')).toHaveLength(1);
    const passedBadge = screen
      .getAllByText('PASSED')
      .find((element) => element.classList.contains('text-agent-success'));
    expect(passedBadge).toBeDefined();
    expect(passedBadge?.querySelector('svg')).toBeInTheDocument();
  });

  it('preserves Jira source keys in the intent configuration dialog', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue(
      baseDetail({
        status: 'RUNNING',
        source: {
          bindingId: 'jira',
          provider: 'jira-cloud',
          instance: 'cloud',
          resourceType: 'task',
          resourceId: 'TAS-01',
          resourceUrl: 'https://example.atlassian.net/browse/TAS-01',
        },
      }),
    );
    renderAt();

    await screen.findByText('My intent');
    await user.click(screen.getByLabelText('Intent actions'));
    await user.click(screen.getByText('Intent configuration'));

    expect(await screen.findByText('Source: task TAS-01')).toBeInTheDocument();
    expect(screen.queryByText(/#TAS-01/)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Jira' })).toBeInTheDocument();
  });

  it.each([
    { label: 'an autonomous grant', mode: 'autonomous' as const, shown: true },
    { label: 'a gated grant', mode: 'gated' as const, shown: false },
    { label: 'no grant at all', mode: null, shown: false },
  ])('shows the construction autonomy chip only for $label', async ({ mode, shown }) => {
    get.mockResolvedValue(baseDetail({ status: 'WAITING', constructionGateAutonomy: mode }));
    renderAt();

    await screen.findByText('My intent');
    const chip = screen.queryByTestId('construction-autonomy-badge');
    if (shown) {
      expect(chip).toHaveTextContent('Autonomous construction');
    } else {
      expect(chip).not.toBeInTheDocument();
    }
  });

  it('opens the reshape controls from the intent actions menu', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue(
      baseDetail({
        status: 'WAITING',
        constructionAutonomyMode: 'gated',
      }),
    );
    renderAt();

    expect(await screen.findByText('My intent')).toBeInTheDocument();
    expect(screen.queryByTestId('recompose-dialog')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Intent actions'));
    await user.click(screen.getByText('Reshape remaining stages'));

    expect(
      await screen.findByRole('heading', { name: 'Reshape remaining stages' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('recompose-dialog')).toBeInTheDocument();
  });

  it('N11: keeps Reshape in the menu on a running intent, disabled with the same reason as the Overview', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue(baseDetail({ status: 'RUNNING', constructionAutonomyMode: 'gated' }));
    renderAt();
    expect(await screen.findByText('My intent')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Intent actions'));
    const item = screen.getByRole('menuitem', { name: /Reshape remaining stages/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('Only while the run is waiting or has failed');
    expect(screen.getByRole('menuitem', { name: /Download workspace/ })).toBeInTheDocument();
  });

  it('switches from intent configuration to reshape', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue(
      baseDetail({
        status: 'WAITING',
        constructionAutonomyMode: 'gated',
      }),
    );
    renderAt();

    await screen.findByText('My intent');
    await user.click(screen.getByLabelText('Intent actions'));
    await user.click(screen.getByText('Intent configuration'));
    expect(
      await screen.findByRole('heading', { name: 'Intent configuration' }),
    ).toBeInTheDocument();
    const waitingBadge = screen.getByText('WAITING');
    expect(waitingBadge).toHaveClass('text-agent-waiting');
    expect(waitingBadge.querySelector('svg')).not.toBeNull();
    expect(waitingBadge.querySelector('.animate-spin')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Reshape' }));

    expect(
      await screen.findByRole('heading', { name: 'Reshape remaining stages' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Intent configuration' })).not.toBeInTheDocument();
  });

  it('opens reshape from the scope definition link', async () => {
    const user = userEvent.setup();
    compiled.mockResolvedValue({
      scopeGrid: {
        feature: {
          requirements: 'EXECUTE',
          optional: 'SKIP',
        },
      },
      graph: {
        nodes: [
          { stageId: 'requirements', phasePath: '01', order: 1 },
          { stageId: 'optional', phasePath: '01', order: 2 },
        ],
        edges: [],
      },
    });
    workflowGet.mockResolvedValue({
      phases: [
        {
          phaseId: 'inception',
          name: 'Inception',
          kind: 'phase',
          path: '01',
          parentPath: null,
          order: 1,
        },
      ],
    });
    get.mockResolvedValue(
      baseDetail({
        status: 'WAITING',
        currentPhase: 'inception',
        constructionAutonomyMode: 'gated',
      }),
    );
    renderAt();

    await user.click(await screen.findByRole('button', { name: /Inception/ }));
    await user.click(screen.getByRole('button', { name: 'Scope definition' }));

    expect(
      await screen.findByRole('heading', { name: 'Reshape remaining stages' }),
    ).toBeInTheDocument();
  });

  it('offers the workspace download from the intent actions menu, not a bare icon', async () => {
    get.mockResolvedValue(baseDetail({ status: 'WAITING', agentCli: 'codex' }));
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'My intent' });
    expect(screen.queryByRole('button', { name: /Download Codex workspace/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose workspace harness' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Intent actions' }));
    expect(screen.getByRole('menuitem', { name: /^Download workspace/ })).toBeEnabled();
    expect(screen.queryByText('Export')).not.toBeInTheDocument();
  });

  it('can export the workflow with a different native harness', async () => {
    get.mockResolvedValue(baseDetail({ status: 'WAITING', agentCli: 'codex' }));
    exportWorkflow.mockImplementation(() => new Promise(() => {}));
    renderAt();

    await openExportDialog();
    expect(exportWorkflow).not.toHaveBeenCalled();
    const harness = screen.getByRole('combobox', { name: 'Agent tool for the workspace' });
    expect(harness).toHaveTextContent('Codex');
    await userEvent.click(harness);
    await userEvent.click(await screen.findByRole('option', { name: 'Claude' }));
    expect(harness).toHaveTextContent('Claude');
    expect(screen.getByText(/will not be synchronized back to this intent/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download workspace' }));

    expect(exportWorkflow).toHaveBeenCalledWith('p1', 'i1', 'claude');
  });

  it('shows only the error message and allows dismissing it', async () => {
    get.mockResolvedValue(baseDetail({ status: 'WAITING', agentCli: 'codex' }));
    exportWorkflow.mockRejectedValue(new Error('{"error":"Workspace export is unavailable"}'));
    renderAt();

    await openExportDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Download workspace' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace export is unavailable');
    expect(
      screen.queryByText('{"error":"Workspace export is unavailable"}'),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the customized blocks and says export does not support them when refused', async () => {
    get.mockResolvedValue(baseDetail({ status: 'WAITING', agentCli: 'codex' }));
    exportWorkflow.mockRejectedValue(
      new ApiError(409, 'The workflow uses edited methodology blocks that cannot yet be exported', {
        error: 'The workflow uses edited methodology blocks that cannot yet be exported',
        code: 'export_edited_blocks',
        incompatibleBlocks: ['AGENT:acme-architect', 'RULE:acme-naming'],
      }),
    );
    renderAt();

    await openExportDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Download workspace' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('agent acme-architect, rule acme-naming');
    expect(alert).toHaveTextContent('Exporting these customizations is not yet supported.');
  });

  it('shows the legacy-ref warning even when no workspace setup is required', async () => {
    get.mockResolvedValue(baseDetail({ status: 'WAITING', agentCli: 'codex' }));
    exportWorkflow.mockResolvedValue({
      exportId: 'export-warning',
      filename: 'workspace.zip',
      downloadUrl: 'https://download.example/workspace.zip',
      expiresAt: '2026-08-12T12:15:00.000Z',
      warnings: [
        'This legacy intent did not pin a native upstream ref; the current deployment ref was used.',
      ],
      setup: {
        workspaceLayout: 'spaces',
        mode: 'extract-only',
        harnessDir: '.codex',
        launchCommand: 'codex',
        continueCommand: '$aidlc',
        showWorkspaceSetup: false,
        repositories: [],
      },
    });
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    renderAt();

    await openExportDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Download workspace' }));

    expect(downloadClick).toHaveBeenCalledOnce();
    expect(await screen.findByText('Workspace downloaded with warnings')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This legacy intent did not pin a native upstream ref; the current deployment ref was used.',
    );
    expect(screen.queryByText(/Create a project directory/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Workspace downloaded with warnings')).not.toBeInTheDocument();
    downloadClick.mockRestore();
  });

  it('keeps construction setup instructions open after starting the download', async () => {
    get.mockResolvedValue(
      baseDetail({
        status: 'WAITING',
        agentCli: 'codex',
        currentPhase: 'INCEPTION',
      }),
    );
    exportWorkflow.mockResolvedValue({
      exportId: 'export-1',
      filename: 'workspace.zip',
      downloadUrl: 'https://download.example/workspace.zip',
      expiresAt: '2026-08-12T12:15:00.000Z',
      warnings: [],
      setup: {
        workspaceLayout: 'spaces',
        mode: 'manual-workspace',
        harnessDir: '.codex',
        launchCommand: 'codex',
        continueCommand: '$aidlc',
        showWorkspaceSetup: true,
        repositories: [
          {
            id: 'org-a/api',
            directory: 'org-a_api',
            url: 'git@github.com:org-a/api.git',
            branch: 'aidlc/i1',
          },
          {
            id: 'org-b/api',
            directory: 'org-b_api',
            url: 'git@github.com:org-b/api.git',
            branch: 'aidlc/i1',
          },
        ],
        construction: {
          nextUnit: 'identify-plant',
          completedUnits: ['upload-image'],
          readyUnits: ['identify-plant'],
          perUnitIteration: true,
        },
      },
    });
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    renderAt();

    await openExportDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Download workspace' }));

    expect(downloadClick).toHaveBeenCalledOnce();
    expect(await screen.findByText('Set up your local workspace')).toBeInTheDocument();
    expect(screen.getByText(/mkdir 'Bookstore_Tracker'/)).toBeInTheDocument();
    expect(screen.getByText(/unzip "\$HOME\/Downloads\/workspace.zip" -d \./)).toBeInTheDocument();
    expect(screen.getByText('Fresh clone: org-a/api')).toBeInTheDocument();
    expect(screen.getByText('Fresh clone: org-b/api')).toBeInTheDocument();
    expect(
      screen.getByText(/git clone --branch 'aidlc\/i1' -- .*'\.\/org-a_api'/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/git clone --branch 'aidlc\/i1' -- .*'\.\/org-b_api'/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/aidlc-workspace-sync/)).not.toBeInTheDocument();
    expect(screen.getByText('Start the selected harness:')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('Then run inside the agent session:')).toBeInTheDocument();
    expect(screen.getByText('$aidlc')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copy AI-DLC command' }));
    expect(writeText).toHaveBeenCalledWith('$aidlc');
    expect(screen.getByRole('button', { name: 'Copy AI-DLC command copied' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Set up your local workspace')).not.toBeInTheDocument();
    downloadClick.mockRestore();
  });

  it('renders and copies workspace-sync setup instructions', async () => {
    get.mockResolvedValue(
      baseDetail({
        status: 'WAITING',
        agentCli: 'codex',
        currentPhase: 'CONSTRUCTION',
      }),
    );
    exportWorkflow.mockResolvedValue({
      exportId: 'export-sync',
      filename: 'workspace.zip',
      downloadUrl: 'https://download.example/workspace.zip',
      expiresAt: '2026-08-12T12:15:00.000Z',
      warnings: [],
      setup: {
        workspaceLayout: 'spaces',
        mode: 'workspace-sync',
        harnessDir: '.codex',
        launchCommand: 'codex',
        continueCommand: '$aidlc',
        syncCommand: 'bun .codex/tools/aidlc-workspace-sync.ts',
        showWorkspaceSetup: true,
        repositories: [
          {
            id: 'example/plant-finder',
            directory: 'plant-finder',
            url: 'git@github.com:example/plant-finder.git',
            branch: 'aidlc/intent-1',
          },
        ],
      },
    });
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    renderAt();

    await openExportDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Download workspace' }));

    expect(await screen.findByText('Set up your local workspace')).toBeInTheDocument();
    expect(screen.getByText('bun .codex/tools/aidlc-workspace-sync.ts')).toBeInTheDocument();
    expect(screen.getByText('repos.json').closest('p')).toHaveTextContent(
      'This reads repos.json and clones the repository on their declared intent branches.',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Copy workspace sync command' }));
    expect(writeText).toHaveBeenCalledWith('bun .codex/tools/aidlc-workspace-sync.ts');
    expect(
      screen.getByRole('button', { name: 'Copy workspace sync command copied' }),
    ).toBeInTheDocument();

    downloadClick.mockRestore();
  });

  it('shows clone and checkout commands for a legacy construction export', async () => {
    get.mockResolvedValue(
      baseDetail({
        status: 'WAITING',
        agentCli: 'claude',
        currentPhase: 'CONSTRUCTION',
      }),
    );
    exportWorkflow.mockResolvedValue({
      exportId: 'export-legacy',
      filename: 'legacy-claude.zip',
      downloadUrl: 'https://download.example/legacy-claude.zip',
      expiresAt: '2026-08-12T12:15:00.000Z',
      warnings: [
        'This workspace uses an older AI-DLC runtime with limited automatic per-unit iteration.',
      ],
      setup: {
        workspaceLayout: 'flat',
        mode: 'manual-clone',
        harnessDir: '.claude',
        launchCommand: 'claude',
        continueCommand: '/aidlc',
        showWorkspaceSetup: true,
        repositories: [
          {
            id: 'example/plant-finder',
            directory: 'plant-finder',
            url: 'git@github.com:example/plant-finder.git',
            branch: 'aidlc/intent-1',
          },
        ],
        construction: {
          nextUnit: 'identify-plant',
          completedUnits: ['upload-image'],
          readyUnits: ['identify-plant'],
          perUnitIteration: false,
        },
      },
    });
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    renderAt();

    await openExportDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Download workspace' }));

    expect(await screen.findByText('Set up your local workspace')).toBeInTheDocument();
    expect(screen.getByText(/git clone --branch 'aidlc\/intent-1'/)).toBeInTheDocument();
    expect(
      screen.getByText(/git fetch origin[\s\S]*git switch 'aidlc\/intent-1'/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/unzip "\$HOME\/Downloads\/legacy-claude.zip" -d \./),
    ).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(
      screen.getByText(
        '/aidlc Continue the construction phase. Completed units: upload-image. Continue with unit: identify-plant.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/older AI-DLC runtime/)).toBeInTheDocument();
    expect(screen.queryByText(/local\/aidlc-continuation/)).not.toBeInTheDocument();
    downloadClick.mockRestore();
  });

  it('shows export disabled while a created intent may still start running', async () => {
    get.mockResolvedValue(baseDetail({ status: 'CREATED', agentCli: 'codex' }));
    renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'Intent actions' }));
    const item = screen.getByRole('menuitem', { name: /^Download workspace/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('Not available before the workflow starts');
    expect(screen.queryByText('Export')).not.toBeInTheDocument();
  });

  it('allows downloading the latest completed checkpoint while the workflow is running', async () => {
    get.mockResolvedValue(baseDetail({ status: 'RUNNING', agentCli: 'codex' }));
    renderAt();

    await openExportDialog();
    expect(
      screen.getByRole('combobox', { name: 'Agent tool for the workspace' }),
    ).toHaveTextContent('Codex');
    expect(screen.getByText(/excludes the stage currently in progress/i)).toBeInTheDocument();
  });

  it('shows resume progress after a gate is answered but before the stage is running again', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'h1' }),
      stages: [
        {
          stageInstanceId: 'si-a',
          stageId: 'requirements-analysis',
          state: 'WAITING_FOR_HUMAN',
          phase: 'inception',
        },
      ],
      gates: [
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Scope?"}]',
          answer: { freeText: 'MVP' },
        },
      ],
      events: [
        {
          eventId: 'ev-resuming',
          type: 'v2.stage.resuming',
          stageInstanceId: 'si-a',
          actor: 'agentcore',
          summary: 'Resuming agent session...',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Resuming')).toBeInTheDocument();
    expect(screen.getByText('Resuming agent session...')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for your input')).not.toBeInTheDocument();
  });

  it('offers an owner repair action for orphaned parallel lane waits', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'RUNNING', pendingHumanTaskId: 'q-old' }),
      stages: [
        {
          stageInstanceId: 'si-asset',
          stageId: 'functional-design',
          unitSlug: 'asset-containment',
          sectionIndex: 1,
          state: 'WAITING_FOR_HUMAN',
          phase: 'construction',
          pendingHumanTaskId: 'q-old',
          parkedAt: '2026-01-01T00:01:00Z',
        },
      ],
      gates: [
        {
          humanTaskId: 'q-old',
          stageInstanceId: 'si-asset',
          unitSlug: 'asset-containment',
          sectionIndex: 1,
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Already answered"}]',
        },
      ],
      events: [{ eventId: 'fanout', type: 'v2.units.section_started' }],
      unitPlan: {
        units: [{ slug: 'asset-containment', dependsOn: [] }],
        batches: [['asset-containment']],
        unitCount: 1,
        skipMatrix: {},
        walkingSkeleton: 'asset-containment',
        autonomyMode: 'autonomous',
        promotedAt: null,
      },
      units: [
        {
          sectionIndex: 1,
          slug: 'asset-containment',
          dependsOn: [],
          state: 'RUNNING',
          batchIndex: 0,
          branch: 'unit',
          startedAt: '2026-01-01T00:00:00Z',
          mergedAt: null,
          failureReason: null,
          blockedOn: null,
          updatedAt: null,
        },
      ],
    });
    repair.mockResolvedValue({});

    renderAt();

    // Plain language first (R3-10); the engine sentence one action away.
    expect(await screen.findByText('One parallel unit is stuck')).toBeInTheDocument();
    expect(
      screen.getByText(/Repairing keeps the units that already finished, discards the draft/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/section boundary/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(screen.getByText(/replayed from the section boundary/)).toBeInTheDocument();
    expect(screen.getByText('Needs recovery')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Repair units' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Repair the stuck units?' });
    expect(dialog).toHaveTextContent('Finished units are kept.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Repair units' }));
    expect(repair).toHaveBeenCalledWith('p1', 'i1');
  });

  const laneDetail = (lanes: { slug: string; laneResuming?: boolean }[]) => ({
    ...baseDetail({ status: 'RUNNING' }),
    stages: lanes.map(({ slug, laneResuming = false }) => ({
      stageInstanceId: `si-${slug}`,
      stageId: 'functional-design',
      unitSlug: slug,
      sectionIndex: 1,
      state: 'WAITING_FOR_HUMAN',
      phase: 'construction',
      pendingHumanTaskId: `q-${slug}`,
      parkedAt: '2026-01-01T00:01:00Z',
      laneResuming,
    })),
    gates: lanes.map(({ slug }) => ({
      humanTaskId: `q-${slug}`,
      stageInstanceId: `si-${slug}`,
      unitSlug: slug,
      sectionIndex: 1,
      status: 'answered',
      kind: 'question',
      questions: '[{"text":"Already answered"}]',
    })),
    events: [{ eventId: 'fanout', type: 'v2.units.section_started' }],
  });

  it('does not offer repair for a lane that is resuming after its answer', async () => {
    get.mockResolvedValue(laneDetail([{ slug: 'asset-containment', laneResuming: true }]));

    renderAt();

    expect(
      await screen.findByRole('button', { name: /Past questions & corrections/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/parallel unit(s)? (is|are) stuck/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Repair units' })).not.toBeInTheDocument();
  });

  it('holds lane repair while a sibling lane is resuming', async () => {
    get.mockResolvedValue(
      laneDetail([{ slug: 'asset-containment' }, { slug: 'live-data', laneResuming: true }]),
    );

    renderAt();

    expect(await screen.findByText('One parallel unit is stuck')).toBeInTheDocument();
    expect(screen.getByText(/Another unit is restarting after an answer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Repair units' })).toBeDisabled();
  });

  it('renders a review-verdict gate with its options and answers through the gate endpoint', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING' }),
      gates: [
        {
          humanTaskId: 'h3',
          status: 'pending',
          kind: 'review-verdict',
          prompt: 'Ship it?',
          options: ['Accept', 'Reject'],
          questions: null,
        },
      ],
    });
    answerGate.mockResolvedValue({});
    renderAt();
    const questions = await screen.findByRole('region', { name: 'Pending questions' });
    expect(within(questions).getByText('Ship it?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'h3', {
      answer: 'Accept',
      status: 'answered',
    });
  });

  it('opens a validation gate review page and approves the stage', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-validation-si-a-0-run1' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'stage-a', state: 'WAITING_FOR_HUMAN', phase: 'build' },
      ],
      gates: [
        {
          humanTaskId: 'eg-validation-si-a-0-run1',
          stageInstanceId: 'si-a',
          unitSlug: null,
          kind: 'validation',
          status: 'pending',
          prompt: 'Review stage stage-a.',
          options: ['approve', 'request-changes'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
      sensorRuns: [
        {
          sensorRunId: 'sr-new',
          stageInstanceId: 'si-a',
          sensorId: 'reviewer:qa',
          result: 'PASS',
          detail: { verdict: 'READY', findings: 'Looks complete' },
          timestamp: '2026-03-01T12:00:00Z',
        },
        {
          sensorRunId: 'sr-old',
          stageInstanceId: 'si-a',
          sensorId: 'reviewer:qa',
          result: 'FAIL',
          detail: { verdict: 'NOT-READY', findings: 'Earlier finding' },
          timestamp: '2026-02-01T12:00:00Z',
        },
      ],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: '# hi',
          summaryGist: 'Captures login requirements and MFA acceptance criteria.',
          summaryClaims: ['Users must authenticate with MFA.', 'Lockout rules are defined.'],
          enrichmentModel: 'claude-sonnet',
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    graph.mockResolvedValue({
      nodes: [
        {
          id: 'req-1',
          type: 'Requirement',
          label: 'MFA is required for sign in',
          graphLayer: 'derived',
          artifactId: 'a1',
          slug: 'REQ-1',
        },
      ],
      edges: [],
    });
    answerGate.mockResolvedValue({});
    renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'Review stage' }));
    expect(await screen.findByText('Review: Stage a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve stage/i })).toBeInTheDocument();
    const reviewDiscuss = screen
      .getAllByTestId('discuss')
      .find((b) => b.getAttribute('data-entity') === 'review');
    expect(reviewDiscuss).toBeInTheDocument();
    expect(reviewDiscuss).toHaveAttribute('data-entity-id', 'eg-validation-si-a-0-run1');
    expect(reviewDiscuss).toHaveAttribute('data-entity-title', 'Review Stage a');
    const glance = screen.getByRole('button', { name: /At a glance/i });
    expect(glance).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText('Captures login requirements and MFA acceptance criteria.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Users must authenticate with MFA.')).toBeInTheDocument();
    const identified = screen
      .getAllByRole('button', { name: /Identified items/i })
      .find((b) => b.hasAttribute('aria-expanded'))!;
    expect(identified).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(identified);
    expect(await screen.findByText('MFA is required for sign in')).toBeInTheDocument();
    const itemDiscuss = screen
      .getAllByTestId('discuss')
      .find((button) => button.getAttribute('data-entity') === 'item');
    expect(itemDiscuss).toHaveAttribute('data-entity-id', 'req-1');
    expect(itemDiscuss).toHaveAttribute('data-entity-title', 'MFA is required for sign in');
    expect(screen.getByRole('button', { name: /Reviewer Agent findings/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: /Reviewer Agent findings/i })).toHaveTextContent(
      'READY',
    );
    await userEvent.click(screen.getByRole('button', { name: /Reviewer Agent findings/i }));
    const reviewerRunTriggers = screen.getAllByTestId(/^reviewer-run-trigger-/);
    expect(reviewerRunTriggers.map((trigger) => trigger.dataset.testid)).toEqual([
      'reviewer-run-trigger-sr-new',
      'reviewer-run-trigger-sr-old',
    ]);
    expect(reviewerRunTriggers[0]).toHaveAttribute('aria-expanded', 'true');
    expect(reviewerRunTriggers[1]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(formatTimelineTimestamp('2026-03-01T12:00:00Z'))).toBeInTheDocument();
    expect(screen.getByText(formatTimelineTimestamp('2026-02-01T12:00:00Z'))).toBeInTheDocument();
    expect(screen.getAllByText('READY')).not.toHaveLength(0);
    expect(screen.getByText('NOT-READY')).toBeInTheDocument();
    expect(screen.getByText('Looks complete')).toBeInTheDocument();
    expect(screen.queryByText('Earlier finding')).not.toBeInTheDocument();
    await userEvent.click(reviewerRunTriggers[1]);
    expect(await screen.findByText('Earlier finding')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Approve stage' }));
    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'eg-validation-si-a-0-run1', {
      answer: { decision: 'approve' },
      status: 'approved',
    });
  });

  // Empty-state consistency: sections with nothing to show are hidden entirely
  // (no "No … recorded" placeholders), and their stat cards are not clickable.
  it('hides empty evidence sections and disables their stat cards on the review gate', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-validation-si-a-0-run1' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'stage-a', state: 'WAITING_FOR_HUMAN', phase: 'build' },
      ],
      gates: [
        {
          humanTaskId: 'eg-validation-si-a-0-run1',
          stageInstanceId: 'si-a',
          unitSlug: null,
          kind: 'validation',
          status: 'pending',
          prompt: 'Review stage stage-a.',
          options: ['approve', 'request-changes'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
      sensorRuns: [],
      artifacts: [],
    });
    graph.mockResolvedValue({ nodes: [], edges: [] });
    renderAt('/space/p1/intent/i1/review/eg-validation-si-a-0-run1');
    expect(await screen.findByText('Review: Stage a')).toBeInTheDocument();

    // Accordion triggers carry aria-expanded; the empty categories render none.
    const expandable = (label: RegExp) =>
      screen.queryAllByRole('button', { name: label }).find((b) => b.hasAttribute('aria-expanded'));
    expect(expandable(/^Artifacts/)).toBeUndefined();
    expect(expandable(/Reviewer Agent findings/i)).toBeUndefined();
    expect(expandable(/Identified items/i)).toBeUndefined();
    // Only "At a glance" is always present.
    expect(expandable(/At a glance/i)).toBeDefined();

    // No placeholder copy for the hidden sections.
    expect(screen.queryByText(/No graph artifacts were produced/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No reviewer agent findings were recorded/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/were derived\s+from this stage/i)).not.toBeInTheDocument();

    // Stat cards for empty categories are plain (rendered as <div>, not <button>).
    const statCardButton = (label: string) =>
      screen
        .queryAllByRole('button')
        .find((b) => !b.hasAttribute('aria-expanded') && b.textContent?.startsWith(label));
    expect(statCardButton('Artifacts')).toBeUndefined();
    expect(statCardButton('Identified items')).toBeUndefined();
    expect(statCardButton('Reviewer verdict')).toBeUndefined();
  });

  // Positive counterpart: when a category has data, its stat card is a button
  // that expands the matching accordion section.
  it('expands the matching section when a populated stat card is clicked', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-validation-si-a-0-run1' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'stage-a', state: 'WAITING_FOR_HUMAN', phase: 'build' },
      ],
      gates: [
        {
          humanTaskId: 'eg-validation-si-a-0-run1',
          stageInstanceId: 'si-a',
          unitSlug: null,
          kind: 'validation',
          status: 'pending',
          prompt: 'Review stage stage-a.',
          options: ['approve', 'request-changes'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
      sensorRuns: [
        {
          sensorRunId: 'sr-1',
          stageInstanceId: 'si-a',
          sensorId: 'reviewer:qa',
          result: 'PASS',
          detail: { verdict: 'READY', findings: 'Looks complete' },
        },
      ],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: '# hi',
          summaryGist: null,
          summaryClaims: [],
          enrichmentModel: 'claude-sonnet',
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    graph.mockResolvedValue({ nodes: [], edges: [] });
    renderAt('/space/p1/intent/i1/review/eg-validation-si-a-0-run1');
    expect(await screen.findByText('Review: Stage a')).toBeInTheDocument();

    const trigger = (label: RegExp) =>
      screen.getAllByRole('button', { name: label }).find((b) => b.hasAttribute('aria-expanded'))!;
    const statCard = (label: string) =>
      screen
        .getAllByRole('button')
        .find((b) => !b.hasAttribute('aria-expanded') && b.textContent?.startsWith(label))!;

    // Artifacts section starts collapsed; clicking its stat card expands it.
    expect(trigger(/^Artifacts/)).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(statCard('Artifacts'));
    expect(trigger(/^Artifacts/)).toHaveAttribute('aria-expanded', 'true');
  });

  // Upstream 2.2.6: the approve action names the COMPUTED next stage verbatim
  // ("Complete workflow" when the gate is the final stage). Legacy gates
  // without the field keep the generic label (previous test).
  it('names the computed next stage on the approve button when the gate carries it', async () => {
    const validationDetail = (nextStageId: string | null) => ({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-validation-si-a-0-run1' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'stage-a', state: 'WAITING_FOR_HUMAN', phase: 'build' },
      ],
      gates: [
        {
          humanTaskId: 'eg-validation-si-a-0-run1',
          stageInstanceId: 'si-a',
          unitSlug: null,
          kind: 'validation',
          status: 'pending',
          prompt: 'Review stage stage-a.',
          options: ['approve', 'request-changes'],
          nextStageId,
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
      sensorRuns: [],
      artifacts: [],
    });
    graph.mockResolvedValue({ nodes: [], edges: [] });
    answerGate.mockResolvedValue({});

    get.mockResolvedValue(validationDetail('stage-b'));
    const { unmount } = renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'Review stage' }));
    expect(
      await screen.findByRole('button', { name: 'Approve — continue to Stage B' }),
    ).toBeInTheDocument();
    unmount();
    clearIntentCache();

    // Final stage: null = approving completes the workflow.
    get.mockResolvedValue(validationDetail(null));
    renderAt();
    await userEvent.click(await screen.findByRole('button', { name: 'Review stage' }));
    expect(
      await screen.findByRole('button', { name: 'Approve — complete workflow' }),
    ).toBeInTheDocument();
  });

  it('submits the collaborative review feedback value when requesting changes', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-validation-si-a-0-run1' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'stage-a', state: 'WAITING_FOR_HUMAN', phase: 'build' },
      ],
      gates: [
        {
          humanTaskId: 'eg-validation-si-a-0-run1',
          stageInstanceId: 'si-a',
          unitSlug: null,
          kind: 'validation',
          status: 'pending',
          prompt: 'Review stage stage-a.',
          options: ['approve', 'request-changes'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
    });
    answerGate.mockResolvedValue({});
    renderAt('/space/p1/intent/i1/review/eg-validation-si-a-0-run1');

    const feedback = await screen.findByLabelText('Feedback for the agent');
    await userEvent.type(feedback, 'Please tighten the acceptance criteria');
    await userEvent.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'eg-validation-si-a-0-run1', {
      answer: {
        decision: 'request-changes',
        feedback: 'Please tighten the acceptance criteria',
      },
      status: 'rejected',
    });
  });

  it('renders artifacts with provenance and a per-artifact DiscussButton', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [{ stageInstanceId: 'si-a', stageId: 'stage-a', state: 'SUCCEEDED', phase: 'p' }],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: `# Requirements\n\n${'Long-form requirements body. '.repeat(40)}`,
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    // The provenance tree renders phases and stages expanded by default.
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    expect(await screen.findByText('Reqs')).toBeInTheDocument();
    const buttons = screen.getAllByTestId('discuss');
    expect(buttons.some((b) => b.getAttribute('data-entity') === 'artifact')).toBe(true);
    expect(buttons.some((b) => b.getAttribute('data-entity') === 'intent')).toBe(true);
  });

  it('groups answered questions with artifacts in work products', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      events: [
        {
          eventId: 'human-answer-h1',
          type: 'v2.question.answered',
          stageInstanceId: 'si-a',
          actor: 'U',
          summary: 'U answered',
          timestamp: '2026-01-01T00:00:00Z',
          humanTaskId: 'h1',
          artifacts: [{ id: 'a1', title: 'Reqs' }],
        },
      ],
      gates: [
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Which provider?","type":"single","options":[{"label":"Cognito"}]}]',
          answer: { answers: [{ selectedOptions: [0], freeText: '' }] },
          answeredByName: 'U',
          answeredAt: '2026-01-01T00:00:00Z',
        },
      ],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: `# Requirements\n\n${'Long-form requirements body. '.repeat(40)}`,
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: /Past questions & corrections/ });
    await userEvent.click(trigger);
    // Expand the question row to see answer details
    await userEvent.click(await screen.findByText('Which provider?'));
    expect(screen.getByText('Cognito')).toBeInTheDocument();
    expect(screen.getByText('Influenced:')).toBeInTheDocument();
  });

  it('groups documents by phase (latest first) then stage order then date desc', async () => {
    // Compiled plan: two phases (01 Inception, 02 Construction), two stages
    // each, with canonical plan `order`. Grouping/ordering must follow the plan
    // vocabulary (phasePath + stage order), NOT raw dates — an earlier stage
    // whose document was produced LATER must still sort below a later stage.
    compiled.mockResolvedValue({
      graph: {
        nodes: [
          { stageId: 'intent-capture', phasePath: '01', order: 1 },
          { stageId: 'requirements-analysis', phasePath: '01', order: 2 },
          { stageId: 'domain-entities', phasePath: '02', order: 3 },
          { stageId: 'code-gen', phasePath: '02', order: 4 },
        ],
        edges: [],
      },
    });
    workflowGet.mockResolvedValue({
      phases: [
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
      ],
    });

    const doc = (id: string, title: string, si: string, createdAt: string) => ({
      id,
      artifactType: 'requirements',
      title,
      content: `# ${title}\n\n${'Long-form body. '.repeat(40)}`,
      createdByStageInstanceId: si,
      createdByExecutionId: 'i1',
      createdAt,
    });

    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [
        {
          stageInstanceId: 'si-ic',
          stageId: 'intent-capture',
          state: 'SUCCEEDED',
          phase: 'inception',
        },
        {
          stageInstanceId: 'si-ra',
          stageId: 'requirements-analysis',
          state: 'SUCCEEDED',
          phase: 'inception',
        },
        {
          stageInstanceId: 'si-de',
          stageId: 'domain-entities',
          state: 'SUCCEEDED',
          phase: 'construction',
        },
        {
          stageInstanceId: 'si-cg',
          stageId: 'code-gen',
          state: 'SUCCEEDED',
          phase: 'construction',
        },
      ],
      artifacts: [
        // Intentionally shuffled input order + dates that fight the plan order.
        doc('d-ic', 'Intent Capture Doc', 'si-ic', '2026-01-01T10:00:00Z'),
        // code-gen (order 4) produced EARLIER than domain-entities (order 3):
        // plan order must still put code-gen above domain-entities.
        doc('d-cg', 'Code Gen Doc', 'si-cg', '2026-01-02T08:00:00Z'),
        doc('d-de', 'Domain Entities Doc', 'si-de', '2026-01-02T20:00:00Z'),
        // Two requirements-analysis docs: newest must appear first (date desc
        // WITHIN a stage).
        doc('d-ra-old', 'Requirements Doc Old', 'si-ra', '2026-01-01T11:00:00Z'),
        doc('d-ra-new', 'Requirements Doc New', 'si-ra', '2026-01-01T18:00:00Z'),
      ],
    });

    renderAt();
    // Phases are the tree's top branches, in workflow order; only the stage
    // holding the newest document opens by default, so open the other stages.
    expect((await screen.findAllByText('Construction')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Domain Entities Doc')).toBeInTheDocument();
    for (const trigger of screen
      .getAllByRole('button', { name: /\d+ documents?$/ })
      .filter((b) => b.getAttribute('aria-expanded') === 'false')) {
      await userEvent.click(trigger);
    }
    expect(await screen.findByText('Code Gen Doc')).toBeInTheDocument();

    // Collect phase headers + document titles in DOM order and assert the full
    // top-to-bottom sequence.
    const labels = [
      'Construction',
      'Inception',
      'Code Gen Doc',
      'Domain Entities Doc',
      'Intent Capture Doc',
      'Requirements Doc Old',
      'Requirements Doc New',
    ];
    const positions = labels.map((t) => {
      const matches = screen.getAllByText(t);
      return { t, el: matches[matches.length - 1] };
    });
    const domOrder = positions
      .toSorted((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )
      .map((p) => p.t);

    expect(domOrder).toEqual([
      'Inception', //               earliest phase first (workflow order)
      'Intent Capture Doc', //      stage order 1 first
      'Requirements Doc Old', //    stage order 2, chronological within stage
      'Requirements Doc New', //    stage order 2, newer second
      'Construction', //            later phase second
      'Domain Entities Doc', //     stage order 3
      'Code Gen Doc', //            stage order 4 last
    ]);
  });

  it('strips the intent-name suffix from document titles (dash and parenthetical forms)', async () => {
    const doc = (id: string, title: string) => ({
      id,
      artifactType: 'requirements',
      title,
      content: `# ${title}\n\n${'Long-form body. '.repeat(40)}`,
      createdByStageInstanceId: 'si-a',
      createdByExecutionId: 'i1',
      createdAt: '2026-01-01T00:00:00Z',
    });
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED', title: 'Plant Identifier MVP' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'build-and-test', state: 'SUCCEEDED', phase: 'c' },
      ],
      artifacts: [
        doc('d1', 'Build and Test Results — Plant Identifier MVP'),
        doc('d2', 'Code Summary — Infrastructure (Plant Identifier MVP)'),
        doc('d3', 'Plant Identifier MVP'),
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    // Stages render expanded by default — documents are directly visible.
    expect(await screen.findByText('Build and Test Results')).toBeInTheDocument();
    // Only the trailing parenthetical stripped; the meaningful "— Infrastructure" stays.
    expect(screen.getByText('Code Summary — Infrastructure')).toBeInTheDocument();
    // A title that IS just the intent name is left untouched (not blanked): it
    // appears both as the page heading and as the d3 row — so > 1 occurrence.
    expect(screen.getAllByText('Plant Identifier MVP').length).toBeGreaterThan(1);
    // The redundant full form no longer appears in a row.
    expect(
      screen.queryByText('Build and Test Results — Plant Identifier MVP'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Code Summary — Infrastructure (Plant Identifier MVP)'),
    ).not.toBeInTheDocument();
  });

  it('renders a PR entry (number, link, source → target) once the PR is recorded', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      pullRequests: [
        {
          id: 'pr:i1:owner/repo',
          repository: 'owner/repo',
          prUrl: 'https://github.com/owner/repo/pull/9',
          prNumber: '9',
          branch: 'aidlc/i1',
          baseBranch: 'main',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Code'));
    expect(screen.getByText('owner/repo')).toBeInTheDocument();
    expect(screen.getAllByText('PR #9')).toHaveLength(1);
    const branchLink = screen.getByRole('link', { name: 'aidlc/i1' });
    expect(branchLink).toHaveAttribute('href', 'https://github.com/owner/repo/tree/aidlc/i1');
    expect(screen.getByText('main')).toBeInTheDocument();
    // The Code section's entry (the outcome callout links the same PR as "PR #9 · repo").
    const link = screen.getByRole('link', { name: 'PR #9 for owner/repo' });
    expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/9');
    expect(link).toHaveTextContent('PR #9');
  });

  it('shows the branch (name + link, no base) once code is pushed, before any PR', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'RUNNING' }),
      events: [{ eventId: 'e1', type: 'v2.git.pushed', summary: 'owner/repo@abc12345' }],
      pullRequests: [],
    });
    renderAt();
    await userEvent.click(await screen.findByText('Code'));
    expect(screen.getByText('owner/repo')).toBeInTheDocument();
    const branchLink = screen.getByRole('link', { name: 'aidlc/i1' });
    expect(branchLink).toHaveAttribute('href', 'https://github.com/owner/repo/tree/aidlc/i1');
    expect(screen.queryByText(/PR #/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^PR\b/i })).not.toBeInTheDocument();
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });

  it('hides the Code section until code has actually been pushed', async () => {
    // Mid-run, branch created locally but nothing pushed yet (no v2.git.pushed,
    // no PR): the Code section must not appear.
    get.mockResolvedValue({
      ...baseDetail({ status: 'RUNNING' }),
      events: [],
      pullRequests: [],
    });
    renderAt();
    // The workbench renders; the Code section does not.
    await screen.findByText('My intent');
    expect(screen.queryByText('Code')).not.toBeInTheDocument();
  });

  it('shows only the repos that pushed code (multi-repo, per-repo gating)', async () => {
    const base = baseDetail({ status: 'RUNNING' });
    get.mockResolvedValue({
      ...base,
      intent: { ...base.intent, repos: ['owner/api', 'owner/web'] },
      // Only owner/api pushed; owner/web has no code yet.
      events: [{ eventId: 'e1', type: 'v2.git.pushed', summary: 'owner/api@abc12345' }],
      pullRequests: [],
    });
    renderAt();
    await userEvent.click(await screen.findByText('Code'));
    expect(screen.getByText('owner/api')).toBeInTheDocument();
    expect(screen.queryByText('owner/web')).not.toBeInTheDocument();
  });
});

// ── WP7: engine approval gates + the unit lane board ─────────────────────────

describe('IntentView — WP7 construction UI', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    start.mockReset();
    answerGate.mockReset();
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
  });

  it('renders an engine approval gate with its options and submits { decision } answers', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'eg-halt-s1-r0-run1' }),
      gates: [
        {
          humanTaskId: 'eg-halt-s1-r0-run1',
          stageInstanceId: null,
          unitSlug: 'billing',
          kind: 'approval',
          status: 'pending',
          prompt: 'Lane failure in section 1 (1 unit(s) failed). Choose:',
          options: ['retry', 'skip', 'abort'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
    });
    answerGate.mockResolvedValue({});
    renderAt();
    // Prompt + lane attribution + every option rendered.
    const questions = await screen.findByRole('region', { name: 'Pending questions' });
    expect(within(questions).getByText(/Lane failure in section 1/)).toBeInTheDocument();
    expect(screen.getByText('unit billing')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'retry' });
    expect(screen.getByRole('button', { name: 'skip' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'abort' })).toBeInTheDocument();
    // Clicking an option submits the { decision } shape the orchestrator parses.
    await userEvent.click(retry);
    expect(answerGate).toHaveBeenCalledWith(
      'p1',
      'i1',
      'eg-halt-s1-r0-run1',
      expect.objectContaining({ answer: { decision: 'retry' }, status: 'answered' }),
    );
  });

  it('maps approve/request-changes options to approved/rejected statuses and carries feedback', async () => {
    get.mockResolvedValue({
      ...baseDetail({
        status: 'WAITING',
        pendingHumanTaskId: 'eg-skeleton-s1-run1',
        gitProvider: 'bitbucket',
        repos: ['acme/repo'],
      }),
      gates: [
        {
          humanTaskId: 'eg-skeleton-s1-run1',
          stageInstanceId: null,
          unitSlug: 'auth',
          sectionIndex: 1,
          kind: 'approval',
          status: 'pending',
          prompt:
            'Walking skeleton "auth" completed.\nReview generated code (branch aidlc/i1--s1-unit-auth).',
          options: ['approve', 'request-changes'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
      units: [
        {
          sectionIndex: 1,
          slug: 'auth',
          dependsOn: [],
          state: 'MERGED',
          batchIndex: 0,
          branch: 'aidlc/i1--s1-unit-auth',
          startedAt: null,
          mergedAt: null,
          failureReason: null,
          blockedOn: null,
          updatedAt: null,
        },
      ],
    });
    answerGate.mockResolvedValue({});
    renderAt();
    // Gates offering request-changes render the free-text feedback field; the
    // feedback rides the answer so the engine can revise the increment and
    // re-ask instead of failing the run.
    const branchLink = await screen.findByRole('link', { name: 'aidlc/i1--s1-unit-auth' });
    expect(branchLink).toHaveAttribute(
      'href',
      'https://bitbucket.org/acme/repo/src/aidlc/i1--s1-unit-auth',
    );
    expect(branchLink).toHaveAttribute('target', '_blank');
    const feedback = await screen.findByPlaceholderText(/What should change/);
    await userEvent.type(feedback, 'wire real auth');
    await userEvent.click(screen.getByRole('button', { name: 'request-changes' }));
    expect(answerGate).toHaveBeenCalledWith(
      'p1',
      'i1',
      'eg-skeleton-s1-run1',
      expect.objectContaining({
        answer: { decision: 'request-changes', feedback: 'wire real auth' },
        status: 'rejected',
      }),
    );
  });

  it('shows plain branch text when a walking-skeleton branch URL cannot be built', async () => {
    get.mockResolvedValue({
      ...baseDetail({
        status: 'WAITING',
        pendingHumanTaskId: 'eg-skeleton-s1-run1',
        gitProvider: null,
      }),
      gates: [
        {
          humanTaskId: 'eg-skeleton-s1-run1',
          stageInstanceId: null,
          unitSlug: 'auth',
          sectionIndex: 1,
          kind: 'approval',
          status: 'pending',
          prompt: 'Walking skeleton "auth" completed.',
          options: ['approve'],
          questions: null,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: null,
        },
      ],
      units: [
        {
          sectionIndex: 1,
          slug: 'auth',
          dependsOn: [],
          state: 'MERGED',
          batchIndex: 0,
          branch: 'aidlc/i1--s1-unit-auth',
          startedAt: null,
          mergedAt: null,
          failureReason: null,
          blockedOn: null,
          updatedAt: null,
        },
      ],
    });

    renderAt();

    expect(await screen.findByText('aidlc/i1--s1-unit-auth')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'aidlc/i1--s1-unit-auth' })).not.toBeInTheDocument();
  });
});

// ── Scalable UX: questions queue, question history, work products header ─────

describe('IntentView — pending questions tabs', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    start.mockReset();
    answerGate.mockReset();
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
    yjsMock.docs.clear();
  });

  const makeGates = (count: number, activeId?: string) => ({
    ...baseDetail({
      status: 'WAITING',
      pendingHumanTaskId: activeId ?? 'h1',
    }),
    gates: Array.from({ length: count }, (_, i) => ({
      humanTaskId: `h${i + 1}`,
      stageInstanceId: `si-${i + 1}`,
      status: 'pending',
      kind: 'question',
      questions: `[{"text":"Question ${i + 1}?","type":"single","options":[{"label":"Yes"}]}]`,
      createdAt: `2026-01-0${i + 1}T00:00:00Z`,
    })),
  });

  it('renders only the active gate selected by default (6 gates, tabs with overflow)', async () => {
    get.mockResolvedValue(makeGates(6, 'h3'));
    renderAt();
    expect(await screen.findByText('Questions for you')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Review 6 pending actions' })).toBeNull();
    // The questions are the page: no block above them repeats that they are waiting.
    expect(document.querySelector('[data-slot="intent-outcome"]')).toBeNull();
    expect(screen.queryByText(/need your answer/)).toBeNull();
    expect(document.getElementById('pending-human-gates')).toBeInTheDocument();
    // Only one gate panel is mounted at a time (the selected tab)
    const panel = screen.getByTestId('gate-panel-h3');
    expect(panel.querySelector('[data-testid="question-editor"]')).toBeInTheDocument();
    // Other gates are tabs, not panels
    expect(screen.queryByTestId('gate-panel-h1')).not.toBeInTheDocument();
  });

  it('switches tab selection when another tab is clicked', async () => {
    get.mockResolvedValue(makeGates(3, 'h1'));
    renderAt();
    await screen.findByText('Questions for you');
    expect(
      screen.getByTestId('gate-panel-h1').querySelector('[data-testid="question-editor"]'),
    ).toBeInTheDocument();
    // Click the second tab
    const h2Tab = screen.getByRole('tab', { name: /Question 2/ });
    await userEvent.click(h2Tab);
    expect(screen.queryByTestId('gate-panel-h1')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('gate-panel-h2').querySelector('[data-testid="question-editor"]'),
    ).toBeInTheDocument();
  });

  it('preserves single-question behavior (1 gate expands immediately in queue)', async () => {
    get.mockResolvedValue(makeGates(1));
    renderAt();
    expect(await screen.findByTestId('question-editor')).toBeInTheDocument();
  });
});

describe('IntentView — compact history section', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    answerGate.mockReset();
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
    yjsMock.docs.clear();
  });

  it('groups questions by stage and shows stage headers when 2+ stages', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'requirements', state: 'SUCCEEDED', phase: '01' },
        { stageInstanceId: 'si-b', stageId: 'design', state: 'SUCCEEDED', phase: '02' },
      ],
      gates: [
        // Later-phase gate arrives FIRST — the section must still order groups
        // by plan position (Requirements before Design), not arrival order.
        {
          humanTaskId: 'h3',
          stageInstanceId: 'si-b',
          status: 'superseded',
          kind: 'question',
          questions: '[{"text":"Pattern?"}]',
          answer: null,
          answeredByName: null,
          answeredAt: null,
        },
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Scope?"}]',
          answer: { freeText: 'MVP' },
          answeredByName: 'U',
          answeredAt: '2026-01-01T00:00:00Z',
        },
        {
          humanTaskId: 'h2',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Priority?"}]',
          answer: { freeText: 'High' },
          answeredByName: 'U',
          answeredAt: '2026-01-01T01:00:00Z',
        },
      ],
    });
    renderAt();
    const trigger = await screen.findByRole('button', { name: /Past questions & corrections/ });
    await userEvent.click(trigger);
    const scopeElements = await screen.findAllByText('Scope?');
    expect(scopeElements.length).toBeGreaterThanOrEqual(1);
    const reqHeader = screen.getAllByText('Requirements')[0];
    const designHeader = screen.getAllByText('Design')[0];
    expect(
      reqHeader.compareDocumentPosition(designHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('does not render status filter pills (removed from simpler UX)', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [
        { stageInstanceId: 'si-a', stageId: 'requirements', state: 'SUCCEEDED', phase: '01' },
      ],
      gates: [
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Scope?"}]',
          answer: { freeText: 'MVP' },
          answeredByName: 'U',
          answeredAt: '2026-01-01T00:00:00Z',
        },
        {
          humanTaskId: 'h2',
          stageInstanceId: 'si-a',
          status: 'superseded',
          kind: 'question',
          questions: '[{"text":"Priority?"}]',
          answer: null,
          answeredByName: null,
          answeredAt: null,
        },
      ],
    });
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: /Past questions & corrections/ }),
    );
    expect(screen.getAllByText('Scope?').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Priority?').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.queryByRole('group', { name: /Filter questions by status/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answered' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Superseded' })).not.toBeInTheDocument();
  });
});

describe('IntentView — provenance tree and absence of rejected UI', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
    yjsMock.docs.clear();
  });

  it('does not render artifact count navigation chips (removed from simpler UX)', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [{ stageInstanceId: 'si-a', stageId: 'build', state: 'SUCCEEDED', phase: '01' }],
      gates: [
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Q?"}]',
          answer: { freeText: 'A' },
          answeredByName: 'U',
          answeredAt: '2026-01-01T00:00:00Z',
        },
      ],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: `# Reqs\n\n${'body '.repeat(200)}`,
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View work products' })).toBeNull();
    expect(document.getElementById('intent-work-products')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /1 doc/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /1 question/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\d+ code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\d+ item/ })).not.toBeInTheDocument();
  });
});

describe('IntentView — tabs overflow and roving tabindex', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    answerGate.mockReset();
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
    yjsMock.docs.clear();
  });

  const makeGates = (count: number, activeId?: string) => ({
    ...baseDetail({
      status: 'WAITING',
      pendingHumanTaskId: activeId ?? 'h1',
    }),
    gates: Array.from({ length: count }, (_, i) => ({
      humanTaskId: `h${i + 1}`,
      stageInstanceId: `si-${i + 1}`,
      status: 'pending',
      kind: 'question',
      questions: `[{"text":"Question ${i + 1}?","type":"single","options":[{"label":"Yes"}]}]`,
      createdAt: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
    })),
  });

  it('renders 20 gates with overflow menu and exactly one editor', async () => {
    get.mockResolvedValue(makeGates(20, 'h1'));
    renderAt();
    expect(await screen.findByText('Questions for you')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeLessThanOrEqual(5);
    expect(screen.getByLabelText(/more questions/)).toBeInTheDocument();
    const editors = screen.getAllByTestId('question-editor');
    expect(editors).toHaveLength(1);
  });

  it('selecting from overflow moves the gate into visible tabs', async () => {
    get.mockResolvedValue(makeGates(10, 'h1'));
    renderAt();
    await screen.findByText('Questions for you');
    expect(screen.getByTestId('gate-panel-h1')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/more questions/));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Question 8\?/ }));
    expect(screen.getByTestId('gate-panel-h8')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Question 8?' })).toBeInTheDocument();
  });

  it('applies roving tabindex: selected tab has tabIndex=0, others -1', async () => {
    get.mockResolvedValue(makeGates(3, 'h2'));
    renderAt();
    await screen.findByText('Questions for you');
    const tabs = screen.getAllByRole('tab');
    const selected = tabs.find((t) => t.getAttribute('aria-selected') === 'true')!;
    const others = tabs.filter((t) => t.getAttribute('aria-selected') !== 'true');
    expect(selected.tabIndex).toBe(0);
    others.forEach((t) => expect(t.tabIndex).toBe(-1));
  });

  it('initializes to activeGateId when it differs from first gate', async () => {
    get.mockResolvedValue(makeGates(4, 'h3'));
    renderAt();
    await screen.findByText('Questions for you');
    expect(screen.getByTestId('gate-panel-h3')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Question 3?' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('IntentView — provenance tree structure', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
    yjsMock.docs.clear();
  });

  it('document with no stage does not crash and appears under Other last', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [],
      artifacts: [
        {
          id: 'orphan-doc',
          artifactType: 'document',
          title: 'Orphan Doc',
          content: `# Orphan\n\n${'body '.repeat(200)}`,
          createdByStageInstanceId: null,
          createdByExecutionId: 'i1',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('items linked to rendered docs appear under them; hidden types not counted', async () => {
    graph.mockResolvedValue({
      nodes: [
        {
          id: 'req-1',
          type: 'Requirement',
          label: 'MFA Required',
          graphLayer: 'derived',
          artifactId: 'a1',
        },
        {
          id: 'sme-1',
          type: 'StoryMapEntry',
          label: 'Hidden Entry',
          graphLayer: 'derived',
          artifactId: 'a1',
        },
      ],
      edges: [],
    });
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [{ stageInstanceId: 'si-a', stageId: 'reqs', state: 'SUCCEEDED', phase: '01' }],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: `# Reqs\n\n${'body '.repeat(200)}`,
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    await userEvent.click(await screen.findByLabelText(/Expand items for Reqs/));
    expect(await screen.findByText('MFA Required')).toBeInTheDocument();
    expect(screen.queryByText('Hidden Entry')).not.toBeInTheDocument();
  });

  it('item with artifactId pointing to a non-document artifact appears in Other items', async () => {
    graph.mockResolvedValue({
      nodes: [
        {
          id: 'item-x',
          type: 'Component',
          label: 'AuthService',
          graphLayer: 'derived',
          artifactId: 'non-doc',
        },
      ],
      edges: [],
    });
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [{ stageInstanceId: 'si-a', stageId: 'code', state: 'SUCCEEDED', phase: '01' }],
      artifacts: [
        {
          id: 'non-doc',
          artifactType: 'short-marker',
          title: 'marker',
          content: 'x',
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    await userEvent.click(await screen.findByText('Other items'));
    expect(await screen.findByText('AuthService')).toBeInTheDocument();
  });

  it('pending gates are absent from history section', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'h1' }),
      gates: [
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          status: 'pending',
          kind: 'question',
          questions: '[{"text":"Open?"}]',
        },
        {
          humanTaskId: 'h2',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Closed?"}]',
          answer: { freeText: 'Done' },
          answeredAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderAt();
    await screen.findByText('Questions for you');
    const historySection = screen.queryByTestId('history-section');
    if (historySection) {
      expect(historySection).not.toHaveTextContent('Open?');
    }
  });

  it('compact history row has no nested interactive button', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      gates: [
        {
          humanTaskId: 'h1',
          stageInstanceId: 'si-a',
          status: 'answered',
          kind: 'question',
          questions: '[{"text":"Scope?"}]',
          answer: { freeText: 'MVP' },
          answeredAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: /Past questions & corrections/ }),
    );
    const row = await screen.findByTestId('history-row-h1');
    const toggleButton = row.querySelector('[aria-expanded]');
    expect(toggleButton?.tagName).toBe('BUTTON');
    const discussButton = row.querySelector('[data-testid="discuss"]');
    expect(discussButton).toBeInTheDocument();
    expect(toggleButton?.contains(discussButton!)).toBe(false);
  });

  it('does not render search input, Active hero, flat queue, filter chips, or category accordion', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'SUCCEEDED' }),
      stages: [{ stageInstanceId: 'si-a', stageId: 'build', state: 'SUCCEEDED', phase: '01' }],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: `# Reqs\n\n${'body '.repeat(200)}`,
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();
    expect(await screen.findByText('Work products')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Active question/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Filter/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /1 doc/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\d+ item/ })).not.toBeInTheDocument();
  });
});

describe('IntentView — resume after a failed gate callback', () => {
  const marker = { humanTaskId: 'h1', callbackId: 'cb-h1', answeredAt: null };

  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    projectCacheMock.role = 'owner';
    getResponsibilities.mockReset().mockResolvedValue({
      unattributedAccess: { decide: true, edit: true },
      stages: [],
    });
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
  });

  const answered = (over: Record<string, unknown> = {}) => ({
    humanTaskId: 'h1',
    stageInstanceId: 'si-1',
    unitSlug: null,
    sectionIndex: null,
    kind: 'question',
    status: 'answered',
    resumeAvailable: true,
    prompt: null,
    options: null,
    questions: '[]',
    answer: { ok: 1 },
    answeredBy: 'u1',
    answeredByName: 'U',
    answeredAt: null,
    createdAt: null,
    ...over,
  });

  it('offers the resume while the intent waits on the answered gate', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'h1', resumeRequired: marker }),
      gates: [answered()],
    });
    renderAt();

    expect(
      await screen.findByText('Your answer was saved but the run did not continue'),
    ).toBeInTheDocument();
  });

  it('offers it on the answered review page too', async () => {
    resume.mockReset().mockResolvedValue(undefined);
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'h1', resumeRequired: marker }),
      gates: [answered()],
    });
    renderAt('/space/p1/intent/i1/review/h1');

    expect(await screen.findByText('This review is no longer pending')).toBeInTheDocument();
    expect(screen.getByText('Your answer was saved but the run did not continue')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Resume run' }));
    expect(resume).toHaveBeenCalledWith('p1', 'i1');
  });

  // #838: Resume re-sends a decision, so it follows the stage's permissions.
  it('disables Resume for a member who may not decide the stage', async () => {
    projectCacheMock.role = 'member';
    getResponsibilities.mockResolvedValue({
      stages: [{ stageInstanceId: 'si-1', access: { edit: true, decide: false } }],
    });
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'h1', resumeRequired: marker }),
      gates: [answered()],
    });
    renderAt();

    await waitFor(() => expect(getResponsibilities).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Resume run' })).toBeDisabled();
  });

  it('does not offer it once the intent is no longer waiting', async () => {
    get.mockResolvedValue(baseDetail({ status: 'CANCELLED', resumeRequired: marker }));
    renderAt();

    expect(await screen.findByText('My intent')).toBeInTheDocument();
    expect(
      screen.queryByText('Your answer was saved but the run did not continue'),
    ).not.toBeInTheDocument();
  });

  it('offers the resume of a lane question while the intent keeps running', async () => {
    get.mockResolvedValue({
      ...baseDetail({
        status: 'RUNNING',
        resumeRequired: { ...marker, humanTaskId: 'h-lane', callbackId: 'cb-lane' },
      }),
      gates: [answered({ humanTaskId: 'h-lane', unitSlug: 'billing', sectionIndex: 1 })],
    });
    renderAt();

    expect(
      await screen.findByText('Your answer was saved but the run did not continue'),
    ).toBeInTheDocument();
  });

  it('does not offer it when the server says no resume is owed', async () => {
    get.mockResolvedValue({
      ...baseDetail({ status: 'RUNNING', resumeRequired: marker }),
      gates: [answered({ resumeAvailable: false })],
    });
    renderAt();

    expect(await screen.findByText('My intent')).toBeInTheDocument();
    expect(
      screen.queryByText('Your answer was saved but the run did not continue'),
    ).not.toBeInTheDocument();
  });
});

describe('terminal completion diagnostics without terminal recovery', () => {
  it.each(['incomplete', 'unknown', 'partial'] as const)(
    'shows %s evidence without offering preservation recovery',
    async (state) => {
      graph.mockResolvedValue({ nodes: [], edges: [] });
      get.mockResolvedValue({
        ...baseDetail({ status: 'SUCCEEDED' }),
        unitCompletion: {
          state,
          reason: state === 'unknown' ? 'unit_plan_missing' : null,
          total: 2,
          integrated: 1,
          skipped: state === 'partial' ? 1 : 0,
          unresolved:
            state === 'partial'
              ? []
              : [
                  {
                    sectionIndex: 1,
                    slug: 'remaining',
                    state: 'BLOCKED',
                    reason: 'unit_unfinished',
                  },
                ],
          legacyPartial: false,
        },
      });
      renderAt();
      expect(
        await screen.findByText(
          state === 'incomplete'
            ? 'Incomplete work'
            : state === 'unknown'
              ? 'Completion unverified'
              : 'Partial delivery',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Preview recovery|Confirm and continue/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/units verified integrated/)).toBeNull();
      if (state === 'unknown')
        expect(screen.getByText('The list of planned units is missing.')).toBeVisible();
      if (state === 'incomplete')
        expect(screen.getByText('Unfinished units: remaining.')).toBeVisible();
      expect(repair).not.toHaveBeenCalled();
    },
  );
});

// Audit T4 (P0): the /review/:humanTaskId deep link told the truth about the
// gate only when it WAS a validation gate. A question gate opened an empty
// approval form with "Approve stage" live; an empty-but-real review invited a
// blind approval; a retired task showed a generic "not found".
describe('IntentView — /review deep link truth (T4)', () => {
  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    start.mockReset();
    answerGate.mockReset().mockResolvedValue({});
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
    yjsMock.docs.clear();
  });

  const questionGate = (status: 'pending' | 'answered' = 'pending') => ({
    humanTaskId: 'q-e8d7011b',
    stageInstanceId: 'si-feas',
    unitSlug: null,
    kind: 'question',
    status,
    prompt: null,
    options: null,
    questions:
      '[{"text":"Which payment provider should the MVP target?","type":"single","options":[{"label":"Stripe"},{"label":"Adyen"}]}]',
    answer: null,
    answeredBy: status === 'answered' ? 'ada' : null,
    answeredByName: status === 'answered' ? 'Ada' : null,
    answeredAt: status === 'answered' ? '2026-03-01T12:00:00Z' : null,
    createdAt: '2026-03-01T10:00:00Z',
  });

  const withGate = (gate: Record<string, unknown>, status = 'WAITING') => ({
    ...baseDetail({
      status,
      pendingHumanTaskId: status === 'WAITING' ? (gate.humanTaskId as string) : null,
    }),
    stages: [
      {
        stageInstanceId: 'si-feas',
        stageId: 'feasibility',
        state: status === 'WAITING' ? 'WAITING_FOR_HUMAN' : 'SUCCEEDED',
        phase: 'inception',
      },
    ],
    gates: [gate],
  });

  it('renders the question experience, never an approval form, for a question gate', async () => {
    get.mockResolvedValue(withGate(questionGate()));
    renderAt('/space/p1/intent/i1/review/q-e8d7011b');

    // The title names the stage, without a count (the card numbers its
    // questions); the question text belongs to the card (R5-4).
    expect(
      await screen.findByRole('heading', { name: 'Feasibility — question' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Which payment provider should the MVP target?')).toBeNull();
    // The same editor the Work page mounts for pending questions.
    expect(screen.getByTestId('question-editor')).toHaveAttribute('data-gate', 'q-e8d7011b');
    expect(
      screen.getByText(/The agent needs an answer before this stage can continue\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/nothing to approve/)).not.toBeInTheDocument();
    // No approval affordance of any kind.
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request changes/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Review: /)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to intent' })).toBeInTheDocument();
  });

  it.each([
    ['approval', 'This stage needs your approval to continue.'],
    ['review-verdict', 'A reviewer verdict is needed before this stage can continue.'],
  ])('explains what a pending %s gate needs', async (kind, intro) => {
    get.mockResolvedValue(
      withGate({ ...questionGate(), humanTaskId: 'g-1', kind, questions: null, prompt: 'Go?' }),
    );
    renderAt('/space/p1/intent/i1/review/g-1');

    expect(await screen.findByText(new RegExp(intro.replace('.', '\\.')))).toBeInTheDocument();
    expect(screen.queryByText(/nothing to approve/)).not.toBeInTheDocument();
    expect(screen.queryByText(/needs an answer/)).not.toBeInTheDocument();
  });

  it('says a real review has nothing to show and demotes Approve to an outline button', async () => {
    get.mockResolvedValue(
      withGate({
        humanTaskId: 'eg-validation-si-feas-0-run1',
        stageInstanceId: 'si-feas',
        unitSlug: null,
        kind: 'validation',
        status: 'pending',
        prompt: 'Review stage feasibility.',
        options: ['approve', 'request-changes'],
        questions: null,
        answer: null,
        answeredBy: null,
        answeredAt: null,
        createdAt: null,
      }),
    );
    renderAt('/space/p1/intent/i1/review/eg-validation-si-feas-0-run1');

    expect(
      await screen.findByText('No documents or extracted items to review for Feasibility.'),
    ).toBeInTheDocument();
    // The zero tiles are gone — the sentence replaces them.
    expect(screen.queryByText('Identified items')).not.toBeInTheDocument();
    expect(screen.queryByText('Reviewer verdict')).not.toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve stage' });
    expect(approve).toHaveClass('border-input');
    expect(approve).not.toHaveClass('bg-primary');
    // Still available: the action is demoted, not removed.
    await userEvent.click(approve);
    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'eg-validation-si-feas-0-run1', {
      answer: { decision: 'approve' },
      status: 'approved',
    });
  });

  it('keeps Approve as the primary action when the review has content', async () => {
    get.mockResolvedValue({
      ...withGate({
        humanTaskId: 'eg-validation-si-feas-0-run1',
        stageInstanceId: 'si-feas',
        unitSlug: null,
        kind: 'validation',
        status: 'pending',
        prompt: 'Review stage feasibility.',
        options: ['approve', 'request-changes'],
        questions: null,
        answer: null,
        answeredBy: null,
        answeredAt: null,
        createdAt: null,
      }),
      artifacts: [
        {
          id: 'a1',
          artifactType: 'feasibility',
          title: 'Feasibility study',
          content: '# Feasibility',
          summaryGist: null,
          summaryClaims: [],
          enrichmentModel: null,
          createdByStageInstanceId: 'si-feas',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt('/space/p1/intent/i1/review/eg-validation-si-feas-0-run1');

    expect(await screen.findByRole('button', { name: 'Approve stage' })).toHaveClass('bg-primary');
    expect(screen.queryByText(/No documents or extracted items/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Artifacts').length).toBeGreaterThan(0);
  });

  it('returns to the intent after answering on the review page, not to "no longer pending"', async () => {
    const pending = withGate({
      ...questionGate(),
      humanTaskId: 'g-1',
      kind: 'approval',
      questions: null,
      prompt: 'Go?',
    });
    const done = withGate(
      {
        ...questionGate('answered'),
        humanTaskId: 'g-1',
        kind: 'approval',
        questions: null,
        prompt: 'Go?',
      },
      'RUNNING',
    );
    get.mockResolvedValueOnce(pending).mockResolvedValue(done);
    getResponsibilities.mockReset().mockResolvedValue({
      unattributedAccess: { decide: true, edit: true },
      stages: [
        { stageInstanceId: 'si-feas', reason: 'unmapped', access: { decide: true, edit: true } },
      ],
    });
    renderAt('/space/p1/intent/i1/review/g-1');

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(answerGate).toHaveBeenCalledWith('p1', 'i1', 'g-1', expect.anything());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Back to intent' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('This review is no longer pending')).not.toBeInTheDocument();
  });

  it('tells the reader an answered task is no longer pending and links back', async () => {
    get.mockResolvedValue(withGate(questionGate('answered'), 'RUNNING'));
    renderAt('/space/p1/intent/i1/review/q-e8d7011b');

    expect(await screen.findByText('This review is no longer pending')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('question-editor')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to intent' })).toBeInTheDocument();
  });

  it('treats an unknown task id the same way', async () => {
    get.mockResolvedValue(withGate(questionGate()));
    renderAt('/space/p1/intent/i1/review/q-does-not-exist');

    expect(await screen.findByText('This review is no longer pending')).toBeInTheDocument();
    expect(screen.queryByText('Review gate not found')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to intent' })).toBeInTheDocument();
  });
});

// Audit W3/W7/O8/X7 + T1/T2/T3/O1 on Work: answer first (outcome callout),
// one labelled actions menu, no anchor band, no window.confirm, no "live" dot.
describe('IntentView — Work header, recovery line and actions', () => {
  const DAY = 24 * 60 * 60_000;

  beforeEach(() => {
    clearIntentCache();
    get.mockReset();
    projectCacheMock.role = 'owner';
    getResponsibilities.mockReset().mockResolvedValue({
      unattributedAccess: { decide: true, edit: true },
      stages: [],
    });
    cancel.mockReset();
    del.mockReset();
    start.mockReset();
    rewind.mockReset();
    answerGate.mockReset();
    pinningOff();
    graph.mockReset().mockResolvedValue({ nodes: [], edges: [] });
    compiled.mockReset().mockResolvedValue({ graph: { nodes: [], edges: [] } });
    workflowGet.mockReset().mockResolvedValue({ phases: [] });
    projectCacheMock.role = 'owner';
    projectCacheMock.summary = null;
    yjsMock.docs.clear();
  });

  const waitingGate = (id: string, ageDays: number, text = `Question ${id}?`) => ({
    humanTaskId: id,
    stageInstanceId: `si-${id}`,
    status: 'pending',
    kind: 'question',
    questions: `[{"text":"${text}","type":"single","options":[{"label":"Yes"}]}]`,
    createdAt: new Date(Date.now() - ageDays * DAY).toISOString(),
  });

  it('shows one h1, a status pill with the wait age, and no unlabelled live dot (T2, W7)', async () => {
    get.mockResolvedValue({
      ...baseDetail({
        status: 'WAITING',
        pendingHumanTaskId: 'h1',
        updatedAt: new Date(Date.now() - 108 * DAY).toISOString(),
        methodologyRelease: {
          releaseId: 'rel-1',
          upstreamVersion: '2.9.0',
          sourceSha: 'abcdef1234567',
          closureDigest: 'sha256:0123456789abcdef',
        },
      }),
      stages: [
        {
          stageInstanceId: 'si-h1',
          stageId: 'feasibility',
          state: 'WAITING_FOR_HUMAN',
          phase: 'inception',
        },
      ],
      gates: [waitingGate('h1', 108)],
    });
    renderAt();

    expect(await screen.findByRole('heading', { level: 1, name: 'My intent' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Waiting for input · 108 days')).toBeInTheDocument();
    expect(screen.queryByLabelText('live')).toBeNull();
    expect(document.querySelector('[data-pulse]')).toBeNull();
    expect(screen.getByTestId('methodology-release-badge')).toHaveTextContent('AI-DLC 2.9.0');
    expect(screen.queryByRole('navigation', { name: 'Intent work shortcuts' })).toBeNull();
    expect(screen.queryByRole('link', { name: /pending action/ })).toBeNull();

    // D4: no outcome block on the Work page. The questions follow the header.
    expect(document.querySelector('[data-slot="intent-outcome"]')).toBeNull();
    expect(screen.queryByText(/needs your answer|Parked/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Pending questions' })).toBeInTheDocument();
  });

  it('shares the Overview header: back to the space, status pill, scope badge, method version (W2 §4–5)', async () => {
    get.mockResolvedValue({
      ...baseDetail({
        status: 'WAITING',
        pendingHumanTaskId: 'h1',
        scope: 'mvp-recomposed',
        methodologyRelease: {
          releaseId: 'rel-1',
          upstreamVersion: '2.9.0',
          sourceSha: 'abcdef1234567',
          closureDigest: 'sha256:0123456789abcdef',
        },
      }),
      gates: [waitingGate('h1', 3)],
    });
    renderAt();

    const header = (await screen.findByRole('heading', { level: 1, name: 'My intent' })).closest(
      'header',
    ) as HTMLElement;
    // The breadcrumb links back to the space; the header does not repeat it (R5-31).
    expect(within(header).queryByRole('link', { name: 'Bookstore Tracker' })).toBeNull();
    expect(within(header).getByText('Waiting for input · 3 days')).toBeInTheDocument();
    expect(within(header).getByLabelText('Scope: MVP Recomposed')).toHaveTextContent(
      'MVP Recomposed',
    );
    expect(within(header).queryByText('mvp-recomposed')).toBeNull();
    expect(within(header).getByTestId('methodology-release-badge')).toHaveTextContent(
      'AI-DLC 2.9.0',
    );
    expect(within(header).getByRole('button', { name: 'Intent actions' })).toBeInTheDocument();
  });

  it('keeps the header while the detail loads, from the cached space row', async () => {
    projectCacheMock.summary = {
      id: 'i1',
      title: 'Cached title',
      status: 'RUNNING',
      scope: 'bugfix',
      createdAt: null,
      updatedAt: new Date().toISOString(),
      completedAt: null,
    };
    get.mockReturnValue(new Promise(() => {}));
    renderAt();

    const header = screen
      .getByRole('heading', { level: 1, name: 'Cached title' })
      .closest('header') as HTMLElement;
    expect(within(header).getByLabelText('Scope: Bugfix')).toBeInTheDocument();
  });

  it('shows a terminal pill alone with "how long ago" beside it, never "Failed · 137 days"', async () => {
    const completedAt = new Date(Date.now() - 137 * DAY).toISOString();
    get.mockResolvedValue(
      baseDetail({
        status: 'FAILED',
        completedAt,
        failureReason: 'workspace_initialization_failed',
      }),
    );
    renderAt();

    const header = (await screen.findByRole('heading', { level: 1, name: 'My intent' })).closest(
      'header',
    ) as HTMLElement;
    expect(within(header).getByText('Failed')).toBeInTheDocument();
    const when = within(header).getByText('137 days ago');
    expect(when.tagName).toBe('TIME');
    expect(when).toHaveAttribute('dateTime', completedAt);
    expect(screen.queryByText(/Failed · /)).toBeNull();
  });

  it('marks a months-old RUNNING run as stalled, without animation or a Cancel it cannot honour (T1)', async () => {
    const fourMonthsAgo = new Date(Date.now() - 122 * DAY).toISOString();
    get.mockResolvedValue({
      ...baseDetail({
        status: 'RUNNING',
        currentStage: 'intent-capture',
        createdAt: fourMonthsAgo,
        updatedAt: fourMonthsAgo,
      }),
      stages: [
        {
          stageInstanceId: 'si-ic',
          stageId: 'intent-capture',
          state: 'RUNNING',
          phase: 'inception',
          startedAt: fourMonthsAgo,
          updatedAt: fourMonthsAgo,
        },
      ],
      events: [
        {
          eventId: 'e1',
          type: 'v2.stage.running',
          stageInstanceId: 'si-ic',
          actor: 'orchestrator',
          summary: 'Stage intent-capture running',
          timestamp: fourMonthsAgo,
        },
      ],
    });
    renderAt();

    expect(await screen.findByText('Stalled · no activity for 4 months')).toBeInTheDocument();
    expect(document.querySelector('[data-pulse]')).toBeNull();
    expect(screen.queryByLabelText('live')).toBeNull();
    // The header pill says it; the engine offers no restart for a running run,
    // so no block repeats it above the work.
    expect(document.querySelector('[data-slot="intent-outcome"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull();
    expect(
      screen.queryByText('Setting up workspace (cloning repositories, preparing the run)…'),
    ).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Intent actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Cancel run' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete intent' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Audit' })).toBeInTheDocument();
  });

  it('keeps a live pulse for a run with recent activity', async () => {
    const justNow = new Date().toISOString();
    get.mockResolvedValue({
      ...baseDetail({ status: 'RUNNING', currentStage: 'intent-capture', updatedAt: justNow }),
      stages: [
        {
          stageInstanceId: 'si-ic',
          stageId: 'intent-capture',
          state: 'RUNNING',
          phase: 'inception',
          startedAt: justNow,
        },
      ],
    });
    renderAt();

    expect((await screen.findAllByText('Running')).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-slot="intent-outcome"]')).toBeNull();
    expect(document.querySelector('[data-pulse]')).not.toBeNull();
  });

  it('names the failed stage and the cause in one sentence, with one Restart (T3)', async () => {
    compiled.mockResolvedValue({
      graph: {
        nodes: [
          { stageId: 'state-init', phasePath: '00', order: 0 },
          { stageId: 'reverse-engineering', phasePath: '01', order: 1 },
        ],
        edges: [],
      },
    });
    get.mockResolvedValue({
      ...baseDetail({
        status: 'FAILED',
        currentStage: 'reverse-engineering',
        failureReason: 'stage_failed: reverse-engineering: not_implemented: mode pipeline',
      }),
      stages: [
        {
          stageInstanceId: 'si-init',
          stageId: 'state-init',
          state: 'SUCCEEDED',
          phase: 'initialization',
        },
        {
          stageInstanceId: 'si-re',
          stageId: 'reverse-engineering',
          state: 'FAILED',
          phase: 'inception',
          runtimeError: 'not_implemented: mode pipeline',
        },
      ],
    });
    rewind.mockResolvedValue({});
    renderAt();

    expect(
      await screen.findByText(
        'Failed at Reverse Engineering — This stage uses a mode this platform version does not support yet.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText('Run failed')).toBeNull();
    expect(screen.queryByText('mode pipeline')).toBeNull();
    // One action: restart from the failed stage.
    expect(screen.queryByRole('button', { name: 'Restart workflow' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Restart from Reverse Engineering' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Restart from Reverse Engineering?',
    });
    expect(rewind).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restart from this stage' }));
    expect(rewind).toHaveBeenCalledWith('p1', 'i1', { fromStageId: 'reverse-engineering' });
  });

  // #838: the recovery line keeps the rule of the failure box it replaces.
  it('disables the restart for a member who may not decide the failed stage', async () => {
    projectCacheMock.role = 'member';
    getResponsibilities.mockResolvedValue({
      stages: [
        {
          stageId: 'reverse-engineering',
          stageInstanceId: 'si-re',
          access: { edit: false, decide: false },
        },
      ],
    });
    compiled.mockResolvedValue({
      graph: { nodes: [{ stageId: 'reverse-engineering', phasePath: '01', order: 0 }], edges: [] },
    });
    get.mockResolvedValue({
      ...baseDetail({ status: 'FAILED', currentStage: 'reverse-engineering' }),
      stages: [
        {
          stageInstanceId: 'si-re',
          stageId: 'reverse-engineering',
          state: 'FAILED',
          phase: 'inception',
          runtimeError: 'not_implemented: mode pipeline',
        },
      ],
    });
    renderAt();

    await waitFor(() => expect(getResponsibilities).toHaveBeenCalled());
    expect(
      await screen.findByRole('button', { name: 'Restart from Reverse Engineering' }),
    ).toBeDisabled();
  });

  // I8 (staging): the failing stage never got a row — the only FAILED row has
  // no stageId. The pipeline bar must still paint Inception red from the
  // failure event, the one recovery is "Restart workflow" (the other AI-DLC
  // version stays in the actions menu), and it confirms before anything is
  // posted (T3).
  it('I8: red failed phase from the inferred stage, one Restart, confirmed', async () => {
    sharedChannels.mockResolvedValue({ pinningEnabled: true });
    compiled.mockResolvedValue({
      graph: {
        nodes: [
          { stageId: 'state-init', phasePath: '00', order: 0 },
          { stageId: 'reverse-engineering', phasePath: '01', order: 1 },
          { stageId: 'requirements-analysis', phasePath: '01', order: 2 },
        ],
        edges: [],
      },
    });
    workflowGet.mockResolvedValue({
      phases: [
        { path: '00', phaseId: 'initialization', name: 'Initialization' },
        { path: '01', phaseId: 'inception', name: 'Inception' },
      ],
    });
    get.mockResolvedValue({
      ...baseDetail({
        status: 'FAILED',
        currentStage: 'state-init',
        failure: { code: 'not_implemented', message: 'mode pipeline' },
        failureReason: 'stage_failed: reverse-engineering: not_implemented: mode pipeline',
      }),
      stages: [
        {
          stageInstanceId: 'si-init',
          stageId: 'state-init',
          state: 'SUCCEEDED',
          phase: 'initialization',
        },
        { stageInstanceId: null, stageId: null, state: 'FAILED', runtimeError: 'not_implemented' },
      ],
      events: [
        {
          eventId: 'e-fail',
          type: 'v2.execution.failed',
          actor: 'orchestrator',
          summary: 'stage_failed: reverse-engineering: not_implemented: mode pipeline',
          timestamp: new Date().toISOString(),
        },
      ],
    });
    start.mockResolvedValue({});
    renderAt();

    expect(
      await screen.findByText(
        'Failed at Reverse Engineering — This stage uses a mode this platform version does not support yet.',
      ),
    ).toBeInTheDocument();
    const inception = await screen.findByRole('button', { name: /^Inception/ });
    expect(inception).toHaveAttribute('data-state', 'failed');
    expect(inception).toHaveTextContent('Failed at Reverse Engineering');

    expect(screen.getByRole('button', { name: 'Restart workflow' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Start on another AI-DLC version' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Restart this workflow from the beginning?',
    });
    expect(dialog).toHaveTextContent(/agents begin working — and spending — again/);
    expect(start).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep run' }));
    expect(start).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Restart workflow' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Restart workflow',
      }),
    );
    expect(start).toHaveBeenCalledWith('p1', 'i1');
  });

  // I3 (staging): one pending question (109 d) and a Scope Definition row still
  // WAITING_FOR_HUMAN since 137 d whose questions were all answered before the
  // recompose. The page used to stack a block above the question saying
  // "2 stages are waiting for input" and "Parked with no open question" right
  // over the open question. It now shows the question, and nothing above it.
  it('I3: a stage parked beside an open question adds no block above the question', async () => {
    get.mockResolvedValue({
      ...baseDetail({
        status: 'WAITING',
        pendingHumanTaskId: 'q-feas',
        currentStage: 'feasibility',
        updatedAt: new Date(Date.now() - 109 * DAY).toISOString(),
      }),
      stages: [
        {
          stageInstanceId: 'si-scope',
          stageId: 'scope-definition',
          state: 'WAITING_FOR_HUMAN',
          phase: 'ideation',
          parkedAt: new Date(Date.now() - 137 * DAY).toISOString(),
        },
        {
          stageInstanceId: 'si-feas',
          stageId: 'feasibility',
          state: 'WAITING_FOR_HUMAN',
          phase: 'ideation',
          parkedAt: new Date(Date.now() - 109 * DAY).toISOString(),
        },
      ],
      gates: [
        {
          ...waitingGate('q-scope', 137, 'What is in scope?'),
          stageInstanceId: 'si-scope',
          status: 'answered',
        },
        { ...waitingGate('q-feas', 109, 'Which gateway?'), stageInstanceId: 'si-feas' },
      ],
    });
    renderAt();

    expect(await screen.findByRole('region', { name: 'Pending questions' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="intent-outcome"]')).toBeNull();
    expect(screen.queryByText(/stages are waiting|Parked|no open question/)).toBeNull();
    // Exactly one answerable card: the open question.
    expect(document.getElementById('gate-card-q-feas')).toBeInTheDocument();
    expect(document.getElementById('gate-card-q-scope')).toBeNull();
  });

  it('shows the pull request of a completed run above its work products (O1)', async () => {
    get.mockResolvedValue({
      ...baseDetail({
        status: 'SUCCEEDED',
        orchestratorStartedAt: '2026-05-01T10:00:00Z',
        completedAt: '2026-05-01T10:42:00Z',
      }),
      pullRequests: [
        {
          id: 'pr-1',
          repository: 'eipasteur/retail-store-cart',
          prUrl: 'https://github.com/eipasteur/retail-store-cart/pull/57',
          prNumber: '57',
          branch: 'aidlc/i1',
          baseBranch: 'main',
          createdAt: '2026-05-01T10:40:00Z',
        },
      ],
      artifacts: [
        {
          id: 'a1',
          artifactType: 'requirements',
          title: 'Reqs',
          content: '# Reqs',
          createdByStageInstanceId: 'si-a',
          createdByExecutionId: 'i1',
          createdAt: null,
        },
      ],
    });
    renderAt();

    const pr = await screen.findByRole('link', { name: 'Pull request #57' });
    expect(pr).toHaveAttribute('href', 'https://github.com/eipasteur/retail-store-cart/pull/57');
    expect(document.querySelector('[data-slot="intent-outcome"]')).toBeNull();
    const products = await screen.findByText('Work products');
    expect(pr.compareDocumentPosition(products) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.queryByText('SUCCEEDED')).toBeNull();
  });

  it('confirms Cancel run in an AlertDialog instead of window.confirm (X7, O8)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    get.mockResolvedValue({
      ...baseDetail({ status: 'WAITING', pendingHumanTaskId: 'h1' }),
      gates: [waitingGate('h1', 1)],
    });
    cancel.mockResolvedValue({ ...baseDetail({ status: 'CANCELLED' }).intent });
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: 'Intent actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this run?' });
    expect(dialog).toHaveTextContent(
      '"My intent" will stop and its pending questions will be retired.',
    );
    expect(cancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(cancel).toHaveBeenCalledWith('p1', 'i1');
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('lets an owner delete from the shared menu and returns to the space', async () => {
    get.mockResolvedValue(baseDetail({ status: 'SUCCEEDED' }));
    del.mockResolvedValue(undefined);
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: 'Intent actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete intent' }));
    await screen.findByRole('alertdialog', { name: 'Delete this intent?' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete intent' }));
    expect(del).toHaveBeenCalledWith('p1', 'i1');
    expect(await screen.findByTestId('space-page')).toBeInTheDocument();
  });

  it('hides Delete from members and keeps Configuration, Download and Audit', async () => {
    projectCacheMock.role = 'member';
    get.mockResolvedValue(baseDetail({ status: 'CANCELLED', agentCli: 'codex' }));
    renderAt();

    await userEvent.click(await screen.findByRole('button', { name: 'Intent actions' }));
    expect(screen.getByRole('menuitem', { name: 'Intent configuration' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^Download workspace/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Audit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete intent' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Cancel run' })).toBeNull();
  });

  it('renders the header from the cached space row while the detail loads', async () => {
    projectCacheMock.summary = {
      id: 'i1',
      title: 'Cached title',
      status: 'WAITING',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: new Date(Date.now() - 3 * DAY).toISOString(),
      completedAt: null,
      scope: 'feature',
      pendingHumanTaskId: 'h1',
    };
    get.mockImplementation(() => new Promise(() => {}));
    renderAt();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cached title' }),
    ).toBeInTheDocument();
    // Status from the row, no age until the detail names the oldest open gate (R3-5).
    expect(screen.getByText('Waiting for input')).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for input · /)).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading intent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Intent actions' })).toBeNull();
  });
});
