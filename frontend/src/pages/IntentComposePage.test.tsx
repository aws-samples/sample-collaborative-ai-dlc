import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

beforeEach(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

const useProjectCache = vi.fn();
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: (...a: unknown[]) => useProjectCache(...a),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'Alice', email: 'a@x' } }),
}));

const reloadIntent = vi.fn();
vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({ reload: (...a: unknown[]) => reloadIntent(...a) }),
}));

const get = vi.fn();
const start = vi.fn();
const update = vi.fn();
const compose = vi.fn();
const listComposes = vi.fn();
const composeReportUpload = vi.fn();
const attachments = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    start: (...a: unknown[]) => start(...a),
    update: (...a: unknown[]) => update(...a),
    compose: (...a: unknown[]) => compose(...a),
    listComposes: (...a: unknown[]) => listComposes(...a),
    composeReportUpload: (...a: unknown[]) => composeReportUpload(...a),
    attachments: (...a: unknown[]) => attachments(...a),
  },
}));

const compiled = vi.fn();
const executionPreview = vi.fn();
const validateGrid = vi.fn();
const getWorkflow = vi.fn();
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: (...a: unknown[]) => compiled(...a),
    executionPreview: (...a: unknown[]) => executionPreview(...a),
    validateGrid: (...a: unknown[]) => validateGrid(...a),
    get: (...a: unknown[]) => getWorkflow(...a),
  },
}));

// The collaborative draft hook drags in the whole Yjs/WebSocket transport —
// substitute a deterministic local implementation that mirrors its contract.
const draftState: Record<string, unknown> = {};
const setSkipStageIds = vi.fn();
const setScope = vi.fn();
const setComposedGrid = vi.fn();
const flushDraft = vi.fn();
vi.mock('@/hooks/useCollaborativeIntentDraft', () => ({
  useCollaborativeIntentDraft: () => ({
    title: (draftState.title as string) ?? '',
    prompt: (draftState.prompt as string) ?? '',
    scope: (draftState.scope as string) ?? null,
    composedGrid: (draftState.composedGrid as Record<string, 'EXECUTE' | 'SKIP'>) ?? null,
    skipStageIds: (draftState.skipStageIds as string[]) ?? null,
    synced: true,
    remoteUsers: new Map(),
    setCursor: vi.fn(),
    initFromIntent: vi.fn(),
    setTitle: vi.fn(),
    setPrompt: vi.fn(),
    setScope: (...a: unknown[]) => setScope(...a),
    setComposedGrid: (...a: unknown[]) => setComposedGrid(...a),
    setSkipStageIds: (...a: unknown[]) => setSkipStageIds(...a),
    flushDraft: (...a: unknown[]) => flushDraft(...a),
  }),
}));

import IntentComposePage from './IntentComposePage';

const baseProject = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'P',
  gitProvider: 'github',
  agentCli: 'kiro',
  createdAt: 'T',
  trackers: [],
  repos: [],
  workflowId: 'aidlc-v2',
  ...over,
});

const draftIntent = (over: Record<string, unknown> = {}) => ({
  intent: {
    id: 'i1',
    executionId: 'i1',
    projectId: 'p1',
    title: 'My intent',
    prompt: 'Build X',
    status: 'DRAFT',
    workflowId: 'aidlc-v2',
    workflowVersion: 1,
    scope: 'feature',
    ...over,
  },
  stages: [],
  events: [],
  gates: [],
  steering: [],
  metrics: [],
  outputs: [],
  sensorRuns: [],
  artifacts: [],
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1/intent/i1/compose']}>
      <Routes>
        <Route path="/space/:projectId/intent/:intentId/compose" element={<IntentComposePage />} />
        <Route
          path="/space/:projectId/intent/:intentId"
          element={<div data-testid="intent-view" />}
        />
      </Routes>
    </MemoryRouter>,
  );

const summaryPlan = (summary: Record<string, number>, stages: unknown[] = []) => ({
  valid: true,
  errors: [],
  warnings: [],
  plan: { stages, summary },
});

describe('IntentComposePage', () => {
  beforeEach(() => {
    for (const k of Object.keys(draftState)) delete draftState[k];
    draftState.prompt = 'Build X';
    draftState.scope = 'feature';
    get.mockReset().mockResolvedValue(draftIntent());
    start.mockReset().mockResolvedValue({});
    update.mockReset().mockResolvedValue({});
    compose.mockReset().mockResolvedValue({ composeId: 'c1', state: 'PENDING', mode: 'front' });
    listComposes.mockReset().mockResolvedValue({ composes: [] });
    composeReportUpload.mockReset();
    attachments.mockReset().mockResolvedValue({ attachments: [], attachmentRevision: 0 });
    flushDraft.mockReset().mockResolvedValue(undefined);
    reloadIntent.mockReset().mockResolvedValue(undefined);
    setSkipStageIds.mockReset();
    setScope.mockReset();
    setComposedGrid.mockReset();
    compiled.mockReset().mockResolvedValue({
      scopeGrid: {
        feature: { init: 'EXECUTE', design: 'EXECUTE', build: 'EXECUTE' },
        bugfix: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      },
      autonomy: { perStage: {}, rollup: { selfHalting: 0, mixed: 0, humanGated: 0, total: 0 } },
      graph: {
        nodes: [
          { stageId: 'init', phasePath: '01', order: 0 },
          { stageId: 'design', phasePath: '04', order: 1 },
          { stageId: 'build', phasePath: '04', order: 2 },
        ],
        edges: [],
        cycles: [],
        danglingConsumes: [],
        orphanProduces: [],
        unknownArtifacts: [],
        acyclic: true,
      },
      rules: { universal: [], phaseRules: {}, pairings: [], perStage: {}, unresolved: [] },
    });
    getWorkflow.mockReset().mockResolvedValue({
      phases: [
        {
          phaseId: 'initialization',
          name: 'Initialization',
          kind: 'phase',
          path: '01',
          parentPath: null,
          order: 0,
        },
        {
          phaseId: 'construction',
          name: 'Construction',
          kind: 'phase',
          path: '04',
          parentPath: null,
          order: 3,
        },
      ],
    });
    executionPreview.mockReset().mockResolvedValue(
      summaryPlan({
        executedStages: 24,
        totalStages: 32,
        approvalGates: 18,
        perUnitStages: 5,
        skippedStages: 0,
        outOfScopeStages: 8,
      }),
    );
    validateGrid.mockReset();
    useProjectCache.mockReset();
    useProjectCache.mockReturnValue({ project: baseProject(), loading: false });
  });

  it('renders the exact stage/gate counts from the preview summary', async () => {
    renderPage();
    const summary = await screen.findByTestId('scope-summary');
    expect(summary.textContent).toContain('Runs 24 of 32 stages');
    expect(summary.textContent).toContain('18 approval gates');
    expect(summary.textContent).toContain('5 stages fan out per unit of work');
  });

  it('previews a composed grid through validate-grid instead of the scope preview', async () => {
    draftState.composedGrid = { a: 'EXECUTE', b: 'SKIP' };
    draftState.scope = 'my-custom';
    validateGrid.mockResolvedValue(
      summaryPlan({
        executedStages: 2,
        totalStages: 3,
        approvalGates: 1,
        perUnitStages: 0,
        skippedStages: 0,
        outOfScopeStages: 1,
      }),
    );
    renderPage();
    await waitFor(() => expect(validateGrid).toHaveBeenCalled());
    expect(validateGrid.mock.calls[0][1]).toMatchObject({
      composedGrid: { a: 'EXECUTE', b: 'SKIP' },
      scope: 'my-custom',
    });
    expect(executionPreview).not.toHaveBeenCalled();
    const summary = await screen.findByTestId('scope-summary');
    expect(summary.textContent).toContain('Customized scope');
    expect(summary.textContent).toContain('Runs 2 of 3 stages');
  });

  it('shows no skip-checkbox section — the stage grid is the single selection surface', async () => {
    renderPage();
    await screen.findByTestId('scope-summary');
    expect(screen.queryByText('Skip stages')).not.toBeInTheDocument();
    expect(screen.getByTestId('grid-editor-toggle')).toBeInTheDocument();
  });

  it('legacy deselections render as SKIP in the grid and are absorbed on the first edit', async () => {
    const user = userEvent.setup();
    // A draft created through the API with the old skip overlay.
    draftState.skipStageIds = ['design'];
    renderPage();
    await user.click(await screen.findByTestId('grid-editor-toggle'));
    // The deselected stage shows unchecked even though the scope runs it.
    const designBox = screen
      .getByTestId('grid-stage-design')
      .querySelector('input') as HTMLInputElement;
    expect(designBox.checked).toBe(false);
    // Editing any stage folds the deselection into the grid and clears the overlay.
    await user.click(screen.getByTestId('grid-stage-build').querySelector('input')!);
    expect(setComposedGrid).toHaveBeenCalledWith({
      init: 'EXECUTE',
      design: 'SKIP',
      build: 'SKIP',
    });
    expect(setSkipStageIds).toHaveBeenCalledWith(null);
  });

  it('Start flushes the shared draft first, then launches and navigates', async () => {
    const user = userEvent.setup();
    renderPage();
    const startBtn = await screen.findByTestId('start-intent');
    await waitFor(() => expect(startBtn).toBeEnabled());
    await user.click(startBtn);
    await waitFor(() => expect(start).toHaveBeenCalledWith('p1', 'i1'));
    expect(flushDraft.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(
      reloadIntent.mock.invocationCallOrder[0],
    );
    expect(await screen.findByTestId('intent-view')).toBeInTheDocument();
  });

  it('a non-DRAFT intent leaves the compose step for the intent view', async () => {
    get.mockResolvedValue(draftIntent({ status: 'RUNNING' }));
    renderPage();
    expect(await screen.findByTestId('intent-view')).toBeInTheDocument();
  });

  it('starts a compose session with the typed steering instructions', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('compose-panel');
    await user.type(screen.getByTestId('compose-instructions'), 'keep it lean');
    await user.click(screen.getByTestId('compose-start'));
    await waitFor(() =>
      expect(compose).toHaveBeenCalledWith('p1', 'i1', { instructions: 'keep it lean' }),
    );
  });

  it('applying a matched proposal writes the scope into the shared draft and clears any grid', async () => {
    const user = userEvent.setup();
    listComposes.mockResolvedValue({
      composes: [
        {
          composeId: 'c1',
          mode: 'front',
          state: 'COMPLETED',
          source: 'match',
          proposal: {
            mode: 'matched',
            scope: 'bugfix',
            grid: null,
            rationale: ['keyword match: hotfix'],
            confidence: 1,
          },
          validation: {
            valid: true,
            errors: [],
            warnings: [],
            summary: {
              executedStages: 2,
              totalStages: 3,
              approvalGates: 1,
              perUnitStages: 0,
              skippedStages: 0,
              outOfScopeStages: 1,
            },
          },
          failureReason: null,
        },
      ],
    });
    renderPage();
    expect(await screen.findByTestId('compose-proposal')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-summary').textContent).toContain('Runs 2 of 3 stages');
    await user.click(screen.getByTestId('proposal-apply'));
    expect(setScope).toHaveBeenCalledWith('bugfix');
    expect(setComposedGrid).toHaveBeenCalledWith(null);
  });

  it('applying a custom proposal writes the grid + label into the shared draft', async () => {
    const user = userEvent.setup();
    listComposes.mockResolvedValue({
      composes: [
        {
          composeId: 'c2',
          mode: 'front',
          state: 'COMPLETED',
          source: 'llm',
          proposal: {
            mode: 'custom',
            scope: 'lean-fix',
            grid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
            rationale: ['design not needed'],
            confidence: 0.8,
          },
          validation: { valid: true, errors: [], warnings: [], summary: null },
          failureReason: null,
        },
      ],
    });
    renderPage();
    await screen.findByTestId('compose-proposal');
    await user.click(screen.getByTestId('proposal-apply'));
    expect(setScope).toHaveBeenCalledWith('lean-fix');
    expect(setComposedGrid).toHaveBeenCalledWith({
      init: 'EXECUTE',
      design: 'SKIP',
      build: 'EXECUTE',
    });
  });

  it('surfaces a failed compose with its structured reason', async () => {
    listComposes.mockResolvedValue({
      composes: [
        {
          composeId: 'c3',
          mode: 'front',
          state: 'FAILED',
          source: 'llm',
          proposal: null,
          validation: null,
          failureReason: 'proposed grid does not resolve',
        },
      ],
    });
    renderPage();
    const failed = await screen.findByTestId('compose-failed');
    expect(failed.textContent).toContain('proposed grid does not resolve');
  });

  it('customizing the stage grid materializes the scope projection with locked initialization', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('grid-editor-toggle'));
    // init is locked (initialization) — toggling it is a no-op.
    const initBox = screen
      .getByTestId('grid-stage-init')
      .querySelector('input') as HTMLInputElement;
    expect(initBox.disabled).toBe(true);
    // Toggling design flips the materialized feature projection to a grid.
    await user.click(screen.getByTestId('grid-stage-design').querySelector('input')!);
    expect(setComposedGrid).toHaveBeenCalledWith({
      init: 'EXECUTE',
      design: 'SKIP',
      build: 'EXECUTE',
    });
    expect(setScope).toHaveBeenCalledWith('feature-custom');
  });

  it('an invalid grid blocks Start and shows the resolver errors', async () => {
    draftState.composedGrid = { init: 'EXECUTE', design: 'EXECUTE' };
    draftState.scope = 'starved';
    validateGrid.mockResolvedValue({
      valid: false,
      errors: [{ code: 'dangling_consume', message: 'stage "build" consumes "x", …' }],
      warnings: [],
      plan: null,
    });
    renderPage();
    const errors = await screen.findByTestId('grid-errors');
    expect(errors.textContent).toContain('consumes');
    const startBtn = screen.getByTestId('start-intent');
    expect(startBtn).toBeDisabled();
  });
});
