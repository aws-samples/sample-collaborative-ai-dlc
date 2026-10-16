import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { act } from 'react';
import { Link, MemoryRouter, Routes, Route, useLocation } from 'react-router';

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

const setAssistAgentCli = vi.fn();
vi.mock('@/components/discussion/DiscussionProvider', () => ({
  useDiscussions: () => ({ setAssistAgentCli }),
}));

const get = vi.fn();
const start = vi.fn();
const update = vi.fn();
const compose = vi.fn();
const listComposes = vi.fn();
const composeReportUpload = vi.fn();
const attachments = vi.fn();
const attachmentUploadUrls = vi.fn();
const trackerAttachments = vi.fn();
const importTrackerAttachment = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    start: (...a: unknown[]) => start(...a),
    update: (...a: unknown[]) => update(...a),
    compose: (...a: unknown[]) => compose(...a),
    listComposes: (...a: unknown[]) => listComposes(...a),
    composeReportUpload: (...a: unknown[]) => composeReportUpload(...a),
    attachments: (...a: unknown[]) => attachments(...a),
    attachmentUploadUrls: (...a: unknown[]) => attachmentUploadUrls(...a),
    trackerAttachments: (...a: unknown[]) => trackerAttachments(...a),
    importTrackerAttachment: (...a: unknown[]) => importTrackerAttachment(...a),
  },
}));

const getProjectCapabilities = vi.fn();
vi.mock('@/services/agents', () => ({
  agentsService: {
    getProjectCapabilities: (...a: unknown[]) => getProjectCapabilities(...a),
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
const setAidlcSetting = vi.fn();
const applyComposedSelection = vi.fn();
const pruneAidlcSettings = vi.fn((..._a: unknown[]) => [] as string[]);
const flushDraft = vi.fn();
vi.mock('@/hooks/useCollaborativeIntentDraft', () => ({
  useCollaborativeIntentDraft: () => ({
    title: (draftState.title as string) ?? '',
    prompt: (draftState.prompt as string) ?? '',
    scope: (draftState.scope as string) ?? null,
    composedGrid: (draftState.composedGrid as Record<string, 'EXECUTE' | 'SKIP'>) ?? null,
    policyScope: (draftState.policyScope as string) ?? null,
    skipStageIds: (draftState.skipStageIds as string[]) ?? null,
    aidlcSettings: (draftState.aidlcSettings as Record<string, string | boolean>) ?? null,
    synced: true,
    hydrated: (draftState.hydrated as boolean) ?? true,
    remoteUsers: new Map(),
    setCursor: vi.fn(),
    initFromIntent: vi.fn(),
    setTitle: vi.fn(),
    setPrompt: vi.fn(),
    setScope: (...a: unknown[]) => setScope(...a),
    setComposedGrid: (...a: unknown[]) => setComposedGrid(...a),
    setSkipStageIds: (...a: unknown[]) => setSkipStageIds(...a),
    setAidlcSetting: (...a: unknown[]) => setAidlcSetting(...a),
    setAidlcSettings: vi.fn(),
    pruneAidlcSettings: (...a: unknown[]) => pruneAidlcSettings(...a),
    applyComposedSelection: (...a: unknown[]) => applyComposedSelection(...a),
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

const renderPage = (controls?: ReactNode, state?: Record<string, unknown>) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/space/p1/intent/i1/compose', state }]}>
      {controls}
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
    attachmentUploadUrls.mockReset();
    getProjectCapabilities.mockReset().mockResolvedValue({
      available: ['kiro', 'claude'],
      runtimeClis: [
        {
          cli: 'kiro',
          installed: true,
          authed: true,
          available: true,
          credentialSource: 'user',
        },
        {
          cli: 'claude',
          installed: true,
          authed: true,
          available: true,
          credentialSource: 'space',
        },
        { cli: 'opencode', installed: true, authed: false, available: false },
        { cli: 'codex', installed: false, authed: false, available: false },
      ],
    });
    flushDraft.mockReset().mockResolvedValue(undefined);
    reloadIntent.mockReset().mockResolvedValue(undefined);
    setAssistAgentCli.mockReset();
    setSkipStageIds.mockReset();
    setScope.mockReset();
    setComposedGrid.mockReset();
    applyComposedSelection.mockReset();
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

  it('consumes automatic import state so reloading does not restore removed files', async () => {
    const source = { bindingId: 'b1', resourceId: '42', provider: 'github-issues' };
    get.mockResolvedValue(draftIntent({ source, attachments: [] }));
    trackerAttachments.mockReset().mockResolvedValue({
      attachments: [
        {
          id: 'asset-1',
          filename: 'spec.pdf',
          url: 'https://github.com/user-attachments/files/1/spec.pdf',
        },
      ],
    });
    importTrackerAttachment.mockReset().mockResolvedValue({
      status: 'imported',
      attachment: { attachmentId: 'a1', filename: 'spec.pdf' },
    });
    const NavigationState = () => (
      <output data-testid="navigation-state">{JSON.stringify(useLocation().state)}</output>
    );
    const first = renderPage(<NavigationState />, {
      importTrackerAttachments: true,
      releaseSelectionFallback: true,
    });
    await screen.findByText('spec.pdf: imported');
    await waitFor(() => {
      expect(JSON.parse(screen.getByTestId('navigation-state').textContent || '{}')).toEqual({
        releaseSelectionFallback: true,
      });
    });
    const savedState = JSON.parse(screen.getByTestId('navigation-state').textContent || '{}');
    first.unmount();
    // The backend now has no attachment (the user removed it). Simulate a
    // reload using the history entry actually left by the first render.
    renderPage(<NavigationState />, savedState);
    await screen.findByRole('button', { name: 'Import attachments' });
    expect(trackerAttachments).toHaveBeenCalledTimes(1);
    expect(importTrackerAttachment).toHaveBeenCalledTimes(1);
  });

  it('uploads PDF, DOCX, and XLSX originals to reach the 50-file limit', async () => {
    const existing = Array.from({ length: 47 }, (_, index) => ({
      attachmentId: `existing-${index}`,
      filename: `notes-${index}.md`,
      mimeType: 'text/markdown',
      size: 1,
    }));
    get.mockResolvedValue(draftIntent({ attachments: existing }));
    const documents = [
      { filename: 'spec.PDF', mimeType: 'application/pdf' },
      {
        filename: 'brief.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      {
        filename: 'budget.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ];
    // Browsers may omit the MIME type; the filename determines the upload descriptor.
    const files = documents.map(
      ({ filename }) => new File([new Uint8Array([0, 128, 255])], filename),
    );
    const uploads = documents.map((document, index) => ({
      attachmentId: `a${index}`,
      url: `https://uploads.example.com/${index}`,
      fields: { key: `staging/${index}`, 'Content-Type': document.mimeType },
    }));
    attachmentUploadUrls.mockResolvedValue({ uploads });
    attachments.mockResolvedValue({
      attachments: [
        ...existing,
        ...documents.map((document, index) => ({
          ...document,
          attachmentId: uploads[index].attachmentId,
          size: files[index].size,
        })),
      ],
      attachmentRevision: 1,
    });
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {});
    const status = vi.spyOn(XMLHttpRequest.prototype, 'status', 'get').mockReturnValue(204);
    const send = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(function (
      this: XMLHttpRequest,
    ) {
      this.dispatchEvent(new ProgressEvent('load'));
    });
    try {
      const user = userEvent.setup();
      renderPage();
      await user.upload(await screen.findByTestId('attachment-picker'), files);

      await waitFor(() => expect(screen.getByTestId('attachment-list').children).toHaveLength(50));
      expect(attachmentUploadUrls).toHaveBeenCalledWith(
        'p1',
        'i1',
        documents.map((document, index) => ({ ...document, size: files[index].size })),
      );
      for (const [index, file] of files.entries()) {
        expect(open).toHaveBeenNthCalledWith(index + 1, 'POST', uploads[index].url);
        const form = send.mock.calls[index][0] as FormData;
        expect(form.get('file')).toBe(file);
        expect(form.get('Content-Type')).toBe(documents[index].mimeType);
        expect(screen.getByText(file.name)).toBeInTheDocument();
      }
      expect(screen.queryByTestId('attachment-progress')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled();
    } finally {
      open.mockRestore();
      status.mockRestore();
      send.mockRestore();
    }
  });

  it.each([
    {
      name: 'an oversized PDF',
      files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.pdf')],
      error: 'large.pdf is unsupported or larger than 5 MB.',
    },
    {
      name: 'more than 50 documents',
      files: Array.from({ length: 51 }, (_, index) => new File(['pdf'], `${index}.pdf`)),
      error: 'Attach up to 50 files.',
    },
    {
      name: 'documents exceeding 25 MB combined',
      files: Array.from(
        { length: 6 },
        (_, index) => new File([new Uint8Array(5 * 1024 * 1024)], `${index}.pdf`),
      ),
      error: 'Attachments cannot exceed 25 MB in total.',
    },
    {
      name: 'a macro-enabled document',
      files: [new File(['docm'], 'macros.docm')],
      error: 'macros.docm is unsupported or larger than 5 MB.',
    },
  ])('rejects $name before requesting uploads', async ({ files, error }) => {
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    await user.upload(await screen.findByTestId('attachment-picker'), files);
    expect(await screen.findByText(error)).toBeInTheDocument();
    expect(attachmentUploadUrls).not.toHaveBeenCalled();
  });

  it('renders the exact stage/gate counts from the preview summary', async () => {
    renderPage();
    const summary = await screen.findByTestId('scope-summary');
    expect(summary.textContent).toContain('Runs 24 of 32 stages');
    expect(summary.textContent).toContain('18 approval gates');
    expect(summary.textContent).toContain('5 stages fan out per unit of work');
  });

  it('keeps workflow reads stable when the intent reloads as an equivalent new object', async () => {
    // A trailing-slash link keeps the same route and params mounted but gives
    // useNavigate a new identity, which re-runs the page's intent load and
    // replaces `intent` with a new object carrying the same data.
    get.mockImplementation(() => Promise.resolve(draftIntent()));
    const user = userEvent.setup();
    renderPage(
      <Link to="/space/p1/intent/i1/compose/" data-testid="reload-intent">
        Reload
      </Link>,
    );

    await waitFor(() => expect(compiled).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(executionPreview).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId('reload-intent'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(compiled).toHaveBeenCalledTimes(1);
    expect(executionPreview).toHaveBeenCalledTimes(1);
  });

  it('previews a composed grid through validate-grid instead of the scope preview', async () => {
    draftState.composedGrid = { a: 'EXECUTE', b: 'SKIP' };
    draftState.scope = 'my-custom';
    get.mockReset().mockResolvedValue(
      draftIntent({
        workflowId: 'aidlc-v2',
        workflowVersion: 7,
        methodologyRelease: { releaseId: 'aidlc:demoted', importerRevision: 1 },
      }),
    );
    useProjectCache.mockReturnValue({
      project: baseProject({ workflowId: 'project-latest', workflowVersion: 9 }),
      loading: false,
    });
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
    await waitFor(() =>
      expect(
        validateGrid.mock.calls.some(
          ([, input]) => input.projectId === 'p1' && input.intentId === 'i1',
        ),
      ).toBe(true),
    );
    const authorizedGridCall = validateGrid.mock.calls.find(
      ([, input]) => input.projectId === 'p1' && input.intentId === 'i1',
    );
    expect(authorizedGridCall?.[1]).toMatchObject({
      composedGrid: { a: 'EXECUTE', b: 'SKIP' },
      scope: 'my-custom',
      version: 7,
    });
    expect(authorizedGridCall?.[1]).toMatchObject({ projectId: 'p1', intentId: 'i1' });
    expect(authorizedGridCall).toMatchObject([
      'aidlc-v2',
      {
        release: 'aidlc:demoted',
        releaseImporterRevision: 1,
        projectId: 'p1',
        intentId: 'i1',
      },
    ]);
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

  it('disables draft-mutating controls until persisted state is hydrated', async () => {
    const user = userEvent.setup();
    draftState.hydrated = false;

    renderPage();

    expect(await screen.findByLabelText('Title')).toBeDisabled();
    expect(screen.getByLabelText('Prompt')).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled();
    expect(screen.getByTestId('compose-instructions')).toBeDisabled();
    expect(screen.getByTestId('compose-start')).toBeDisabled();
    expect(screen.getByTestId('start-intent')).toBeDisabled();

    await user.click(await screen.findByTestId('grid-editor-toggle'));
    const designBox = (await screen.findByTestId('grid-stage-design')).querySelector(
      'input',
    ) as HTMLInputElement;
    expect(designBox).toBeDisabled();
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
    expect(setComposedGrid).toHaveBeenCalledWith(
      { init: 'EXECUTE', design: 'SKIP', build: 'SKIP' },
      // The stock scope the grid was built from, recorded on every release:
      // this one authors no per-intent setting, so the plan, the preview and
      // the save all ignore the base and the grid resolves exactly the policy
      // it resolved before.
      'feature',
    );
    expect(setSkipStageIds).toHaveBeenCalledWith(null);
  });

  it('Start flushes the shared draft first, then launches and navigates', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('agent-cli-kiro'));
    await waitFor(() => expect(setAssistAgentCli).toHaveBeenLastCalledWith('kiro'));
    const startBtn = await screen.findByTestId('start-intent');
    await waitFor(() => expect(startBtn).toBeEnabled());
    await user.click(startBtn);
    await waitFor(() => expect(start).toHaveBeenCalledWith('p1', 'i1', { agentCli: 'kiro' }));
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
    await user.click(screen.getByTestId('agent-cli-kiro'));
    await user.type(screen.getByTestId('compose-instructions'), 'keep it lean');
    await user.click(screen.getByTestId('compose-start'));
    await waitFor(() =>
      expect(compose).toHaveBeenCalledWith('p1', 'i1', {
        agentCli: 'kiro',
        instructions: 'keep it lean',
      }),
    );
  });

  it('requires an explicit CLI selection before Compose or Start', async () => {
    renderPage();
    expect(await screen.findByTestId('compose-start')).toBeDisabled();
    expect(screen.getByTestId('start-intent')).toBeDisabled();
    expect(screen.getByText('Select an agent CLI to continue')).toBeInTheDocument();
  });

  it('requires a fresh CLI selection when switching drafts in the same space', async () => {
    get.mockImplementation((_projectId, intentId) =>
      Promise.resolve(draftIntent({ id: intentId, executionId: intentId })),
    );
    const user = userEvent.setup();
    renderPage(
      <Link to="/space/p1/intent/i2/compose" data-testid="switch-draft">
        Switch draft
      </Link>,
    );

    await user.click(await screen.findByTestId('agent-cli-kiro'));
    await waitFor(() => expect(setAssistAgentCli).toHaveBeenLastCalledWith('kiro'));
    expect(screen.getByTestId('start-intent')).toBeEnabled();

    await user.click(screen.getByTestId('switch-draft'));

    await waitFor(() => expect(get).toHaveBeenCalledWith('p1', 'i2'));
    expect(screen.getByTestId('agent-cli-kiro')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('start-intent')).toBeDisabled();
    expect(screen.getByText('Select an agent CLI to continue')).toBeInTheDocument();
    await waitFor(() => expect(setAssistAgentCli).toHaveBeenLastCalledWith(null));
  });

  it('reports missing credentials without claiming the CLIs are not installed', async () => {
    getProjectCapabilities.mockResolvedValue({
      available: [],
      runtimeClis: [],
      credentialSources: { bedrock: null, kiro: null },
    });

    renderPage();

    expect(
      await screen.findByText(
        'No agent credential is currently available. Add one before starting this draft.',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText('no credential')).toHaveLength(4);
    expect(screen.queryByText('not installed')).not.toBeInTheDocument();
    expect(screen.getByTestId('start-intent')).toBeDisabled();
  });

  it('greys out a CLI the platform admin disabled', async () => {
    getProjectCapabilities.mockResolvedValue({
      available: ['kiro'],
      disabledClis: ['codex'],
      runtimeClis: [
        {
          cli: 'kiro',
          installed: true,
          authed: true,
          available: true,
          enabled: true,
          credentialSource: 'platform',
        },
        {
          cli: 'codex',
          installed: true,
          authed: true,
          available: false,
          enabled: false,
          credentialSource: 'platform',
        },
      ],
      credentialSources: { bedrock: 'platform', kiro: 'platform' },
    });

    renderPage();

    expect(await screen.findByText('disabled by admin')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('agent-cli-codex')).toBeDisabled());
    expect(screen.getByTestId('agent-cli-kiro')).toBeEnabled();
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
    // ONE transaction, not a scope write and a grid write a peer could observe
    // between.
    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'bugfix',
      aidlcSettings: null,
    });
    expect(setScope).not.toHaveBeenCalled();
    expect(setComposedGrid).not.toHaveBeenCalled();
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
    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'lean-fix',
      composedGrid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      // No base scope on a release that authors no setting, so the save of a
      // classic draft carries exactly the fields it always carried.
      policyScope: null,
      aidlcSettings: null,
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
    expect(setComposedGrid).toHaveBeenCalledWith(
      { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      'feature',
    );
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

// ── Release access is gated on selectability ──
//
// A release-pinned intent compiles its compose views from the pinned closure. If
// that resolution fails (the release was demoted, or is no longer offered), the
// page must say so rather than quietly rendering the LIVE methodology — a preview
// of stages and scopes this intent will never execute.
// The per-intent AI-DLC settings on the real page: offered only for what the
// previewed scope authors, written straight into the shared draft selection, and
// pruned — with the withdrawal named — when the selection stops offering one.
describe('IntentComposePage — the per-intent AI-DLC settings', () => {
  beforeEach(() => {
    for (const k of Object.keys(draftState)) delete draftState[k];
    draftState.prompt = 'Build X';
    draftState.scope = 'feature';
    get.mockReset().mockResolvedValue(draftIntent());
    start.mockReset().mockResolvedValue({});
    update.mockReset().mockResolvedValue({});
    listComposes.mockReset().mockResolvedValue({ composes: [] });
    attachments.mockReset().mockResolvedValue({ attachments: [], attachmentRevision: 0 });
    getProjectCapabilities.mockReset().mockResolvedValue({ available: ['kiro'], runtimeClis: [] });
    flushDraft.mockReset().mockResolvedValue(undefined);
    reloadIntent.mockReset().mockResolvedValue(undefined);
    setAssistAgentCli.mockReset();
    setAidlcSetting.mockReset();
    pruneAidlcSettings.mockReset().mockReturnValue([]);
    compose.mockReset().mockResolvedValue({ composeId: 'c1', state: 'PENDING', mode: 'front' });
    composeReportUpload.mockReset();
    compiled.mockReset().mockResolvedValue({
      scopeGrid: { feature: { init: 'EXECUTE' } },
      autonomy: { perStage: {}, rollup: { selfHalting: 0, mixed: 0, humanGated: 0, total: 0 } },
      graph: {
        nodes: [{ stageId: 'init', phasePath: '01', order: 0 }],
        edges: [],
        cycles: [],
        danglingConsumes: [],
        orphanProduces: [],
        unknownArtifacts: [],
        acyclic: true,
      },
      rules: { universal: [], phaseRules: {}, pairings: [], perStage: {}, unresolved: [] },
      stages: { init: { id: 'init', phase: 'inception' } },
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
      ],
    });
    validateGrid.mockReset();
    useProjectCache.mockReset();
    useProjectCache.mockReturnValue({ project: baseProject(), loading: false });
    window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  const SUMMARY = {
    executedStages: 24,
    totalStages: 32,
    approvalGates: 18,
    perUnitStages: 5,
    skippedStages: 0,
    outOfScopeStages: 8,
  };

  const withAuthored = (authored: Record<string, string | boolean> | null) =>
    executionPreview.mockReset().mockResolvedValue({
      valid: true,
      errors: [],
      summary: SUMMARY,
      plan: { stages: [], summary: SUMMARY, aidlcSettingsAuthored: authored },
    });

  it('stays hidden for a release that authors no setting', async () => {
    withAuthored(null);

    renderPage();

    await screen.findByTestId('scope-summary');
    expect(screen.queryByTestId('aidlc-settings')).not.toBeInTheDocument();
  });

  it('offers the settings the previewed scope authors', async () => {
    withAuthored({ guardPolicy: 'off', planApproval: 'on' });

    renderPage();

    await screen.findByTestId('aidlc-settings');
    expect(screen.getByRole('combobox', { name: 'Guard Policy' })).toHaveTextContent('Off');
    expect(screen.queryByRole('combobox', { name: 'Project type' })).toBeNull();
  });

  // A pick is a change to the shared draft selection, nothing else: no request
  // of its own, so there is no second operation Start has to wait for.
  it('writes a pick into the shared selection with no request of its own', async () => {
    withAuthored({ guardPolicy: 'off' });
    const user = userEvent.setup();

    renderPage();
    await screen.findByTestId('aidlc-settings');
    await user.click(screen.getByRole('combobox', { name: 'Guard Policy' }));
    await user.click(screen.getByRole('option', { name: 'Strict' }));

    expect(setAidlcSetting).toHaveBeenCalledWith('guardPolicy', 'strict');
    expect(update).not.toHaveBeenCalled();
  });

  it('shows a chosen override against the scope default', async () => {
    withAuthored({ guardPolicy: 'off' });
    draftState.aidlcSettings = { guardPolicy: 'strict' };

    renderPage();

    await screen.findByTestId('aidlc-settings');
    expect(screen.getByTestId('aidlc-setting-source-guardPolicy')).toHaveTextContent(
      'Changed for this intent (scope default: Off)',
    );
  });

  // The selection decides which settings exist, so the page prunes against the
  // authored map of the selection now in force and names what it withdrew.
  it('prunes against the previewed selection and names what it withdrew', async () => {
    withAuthored({ guardPolicy: 'off', planApproval: 'on' });
    pruneAidlcSettings.mockReturnValue(['existingCode']);

    renderPage();

    const notice = await screen.findByTestId('aidlc-settings-dropped');
    expect(notice).toHaveTextContent('Project type');
    expect(pruneAidlcSettings).toHaveBeenCalledWith({ guardPolicy: 'off', planApproval: 'on' });
  });

  it('says nothing when the selection withdrew no setting', async () => {
    withAuthored({ guardPolicy: 'off' });

    renderPage();

    await screen.findByTestId('aidlc-settings');
    expect(screen.queryByTestId('aidlc-settings-dropped')).not.toBeInTheDocument();
  });
});

// Accepting a composed plan's settings on the real page. One call, carrying the
// whole selection, so the card is Applied because a local transaction committed.
describe('IntentComposePage — applying a composed plan with its settings', () => {
  // The release of this describe authors the per-intent settings, which is the
  // only case in which a base scope resolves a policy or a setting can be
  // stored at all.
  const AUTHORED = { guardPolicy: 'off', planApproval: 'on', collaborators: 'off' };

  beforeEach(() => {
    for (const k of Object.keys(draftState)) delete draftState[k];
    draftState.prompt = 'Build X';
    draftState.scope = 'feature';
    get.mockReset().mockResolvedValue(draftIntent());
    start.mockReset().mockResolvedValue({});
    update.mockReset().mockResolvedValue({});
    compose.mockReset().mockResolvedValue({ composeId: 'c1', state: 'PENDING', mode: 'front' });
    composeReportUpload.mockReset();
    attachments.mockReset().mockResolvedValue({ attachments: [], attachmentRevision: 0 });
    getProjectCapabilities.mockReset().mockResolvedValue({ available: ['kiro'], runtimeClis: [] });
    flushDraft.mockReset().mockResolvedValue(undefined);
    reloadIntent.mockReset().mockResolvedValue(undefined);
    setAssistAgentCli.mockReset();
    applyComposedSelection.mockReset();
    setScope.mockReset();
    setComposedGrid.mockReset();
    setSkipStageIds.mockReset();
    pruneAidlcSettings.mockReset().mockReturnValue([]);
    compiled.mockReset().mockResolvedValue({
      scopeGrid: { feature: { init: 'EXECUTE', design: 'EXECUTE', build: 'EXECUTE' } },
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
      stages: {
        init: { id: 'init', phase: 'initialization' },
        design: { id: 'design', phase: 'construction' },
        build: { id: 'build', phase: 'construction' },
      },
    });
    getWorkflow.mockReset().mockResolvedValue({ phases: [] });
    executionPreview.mockReset().mockResolvedValue({
      valid: true,
      errors: [],
      summary: null,
      plan: { stages: [], summary: null, aidlcSettingsAuthored: AUTHORED },
    });
    validateGrid.mockReset().mockResolvedValue({
      valid: true,
      errors: [],
      summary: null,
      plan: { stages: [], summary: null, aidlcSettingsAuthored: AUTHORED },
    });
    useProjectCache.mockReset();
    useProjectCache.mockReturnValue({ project: baseProject(), loading: false });
  });

  const withProposal = (proposal: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    listComposes.mockReset().mockResolvedValue({
      composes: [
        {
          composeId: 'c9',
          mode: 'front',
          state: 'COMPLETED',
          source: 'llm',
          proposal: { grid: null, rationale: [], confidence: 0.8, ...proposal },
          validation: { valid: true, errors: [], warnings: [], summary: null },
          failureReason: null,
          ...extra,
        },
      ],
    });

  it('applies a matched proposal and its settings in one call', async () => {
    const user = userEvent.setup();
    withProposal(
      {
        mode: 'matched',
        scope: 'bugfix',
        guardPolicy: 'strict',
        scopeSettings: { collaborators: 'on' },
      },
      { settingsScope: 'bugfix' },
    );

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'bugfix',
      aidlcSettings: { guardPolicy: 'strict', collaborators: 'on' },
    });
  });

  it('applies a custom proposal with the settings scope it was validated against', async () => {
    const user = userEvent.setup();
    withProposal(
      {
        mode: 'custom',
        scope: 'lean-fix',
        grid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
        guardPolicy: 'relaxed',
        baseScope: 'bugfix',
      },
      { settingsScope: 'bugfix' },
    );

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'lean-fix',
      composedGrid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      policyScope: 'bugfix',
      aidlcSettings: { guardPolicy: 'relaxed' },
    });
  });

  // A proposal that omits the base scope keeps the one the selection already
  // runs on — never the display label, which names no scope block.
  it('keeps the current base scope when the proposal omits it', async () => {
    const user = userEvent.setup();
    draftState.scope = 'feature-custom';
    draftState.policyScope = 'feature';
    draftState.composedGrid = { init: 'EXECUTE', design: 'EXECUTE', build: 'EXECUTE' };
    withProposal({
      mode: 'custom',
      scope: 'leaner',
      grid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
    });

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'leaner',
      composedGrid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      policyScope: 'feature',
      aidlcSettings: null,
    });
  });

  // Applying a proposal for the scope already selected changes no selection, so
  // no preview re-runs to prune it: a proposed value equal to that scope's
  // default would stay in the shared document as a choice and become a real
  // override of the next scope's own default.
  it('drops proposed values equal to the current scope default when the selection is unchanged', async () => {
    const user = userEvent.setup();
    withProposal(
      {
        mode: 'matched',
        scope: 'feature',
        guardPolicy: 'off',
        scopeSettings: { collaborators: 'on' },
      },
      { settingsScope: 'feature' },
    );

    renderPage();
    await screen.findByTestId('proposal-apply');
    await waitFor(() => expect(executionPreview).toHaveBeenCalled());
    await user.click(screen.getByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'feature',
      aidlcSettings: { collaborators: 'on' },
    });
  });

  it('stores nothing when every proposed value equals the current scope default', async () => {
    const user = userEvent.setup();
    withProposal(
      { mode: 'matched', scope: 'feature', guardPolicy: 'off' },
      { settingsScope: 'feature' },
    );

    renderPage();
    await screen.findByTestId('proposal-apply');
    await waitFor(() => expect(executionPreview).toHaveBeenCalled());
    await user.click(screen.getByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({ scope: 'feature', aidlcSettings: null });
  });

  // The proposal was validated against the defaults of ITS settings scope, which
  // the compose row records. Those are the defaults Apply normalizes against —
  // not the ones of whatever selection the page happens to be previewing. Here
  // the page previews `feature` (Guard Policy off by default) while the
  // proposal runs a custom grid on `bugfix` (strict by default): accepting
  // Guard Policy off is a real override of bugfix's strict default and must
  // reach the selection, or the run would execute strict.
  it('normalizes against the defaults the proposal was validated against, not the previewed ones', async () => {
    const user = userEvent.setup();
    const grid = { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' };
    draftState.scope = 'feature-custom';
    draftState.policyScope = 'feature';
    draftState.composedGrid = grid;
    withProposal(
      {
        mode: 'custom',
        scope: 'feature-custom',
        grid,
        baseScope: 'bugfix',
        guardPolicy: 'off',
        scopeSettings: { collaborators: 'off' },
      },
      {
        settingsScope: 'bugfix',
        settingsAuthored: { guardPolicy: 'strict', collaborators: 'off' },
      },
    );

    renderPage();
    await screen.findByTestId('proposal-apply');
    await waitFor(() => expect(validateGrid).toHaveBeenCalled());
    await user.click(screen.getByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'feature-custom',
      composedGrid: grid,
      policyScope: 'bugfix',
      aidlcSettings: { guardPolicy: 'off' },
    });
  });

  // A preview still loading — for instance just after a scope change — must
  // not decide what Apply keeps: the recorded defaults already answer it.
  it('normalizes a matched proposal while the preview is still loading', async () => {
    const user = userEvent.setup();
    executionPreview.mockReset().mockReturnValue(new Promise(() => {}));
    withProposal(
      {
        mode: 'matched',
        scope: 'feature',
        guardPolicy: 'off',
        scopeSettings: { collaborators: 'on' },
      },
      { settingsScope: 'feature', settingsAuthored: { guardPolicy: 'off', collaborators: 'off' } },
    );

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'feature',
      aidlcSettings: { collaborators: 'on' },
    });
  });

  it('sends no settings for a proposal that proposed none', async () => {
    const user = userEvent.setup();
    withProposal({ mode: 'matched', scope: 'bugfix' });

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'bugfix',
      aidlcSettings: null,
    });
  });

  // The first customization of a STOCK selection records the scope it was built
  // from: the display label it is about to take names no scope block, so
  // without this the whole policy and every settable switch would vanish on the
  // first toggle.
  it('records the stock scope a first customization was built from', async () => {
    const user = userEvent.setup();
    listComposes.mockReset().mockResolvedValue({ composes: [] });

    renderPage();
    await user.click(await screen.findByTestId('grid-editor-toggle'));
    await user.click(screen.getByTestId('grid-stage-design').querySelector('input')!);

    expect(setComposedGrid).toHaveBeenCalledWith(
      { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      'feature',
    );
    expect(setScope).toHaveBeenCalledWith('feature-custom');
  });

  // A selection that is ALREADY a customization has a display label, not a
  // scope. Recording that label would record a base no catalog resolves, and
  // every later save — a title edit, a prompt edit, the Start flush — would be
  // refused for naming a scope that does not exist.
  it('records no base scope for a draft that is already customized', async () => {
    const user = userEvent.setup();
    listComposes.mockReset().mockResolvedValue({ composes: [] });
    draftState.scope = 'feature-custom';
    draftState.composedGrid = { init: 'EXECUTE', design: 'EXECUTE', build: 'EXECUTE' };

    renderPage();
    await user.click(await screen.findByTestId('grid-editor-toggle'));
    await user.click(screen.getByTestId('grid-stage-design').querySelector('input')!);

    expect(setComposedGrid).toHaveBeenCalledWith(
      { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      null,
    );
    expect(setScope).not.toHaveBeenCalled();
  });

  // A second Apply onto an already-customized selection keeps the base the
  // compose was validated against; it never promotes the previous display
  // label, which is what made the next save refuse the whole draft.
  it('never promotes a display label to the base scope on a second apply', async () => {
    const user = userEvent.setup();
    draftState.scope = 'leaner';
    draftState.composedGrid = { init: 'EXECUTE', design: 'EXECUTE', build: 'EXECUTE' };
    withProposal({
      mode: 'custom',
      scope: 'leanest',
      grid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
    });

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'leanest',
      composedGrid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      policyScope: null,
      aidlcSettings: null,
    });
  });

  // A release that authors no setting stores no setting, whatever a model
  // volunteered: the compose job records no settings scope there, which is the
  // catalog's own answer and the only one the page may trust.
  it('records nothing from a proposal on a release that authors no setting', async () => {
    const user = userEvent.setup();
    executionPreview.mockReset().mockResolvedValue({
      valid: true,
      errors: [],
      summary: null,
      plan: { stages: [], summary: null },
    });
    withProposal({
      mode: 'custom',
      scope: 'lean-fix',
      grid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      guardPolicy: 'strict',
      baseScope: 'bugfix',
    });

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'lean-fix',
      composedGrid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      policyScope: null,
      aidlcSettings: null,
    });
  });

  // The preview is what tells the page which settings a selection AUTHORS, and
  // it has not answered yet. The compose job already validated this proposal
  // against a settings scope, which only a settings-aware catalog has — so the
  // accepted values and their base land, instead of being dropped because a
  // request was still in flight.
  it('applies the proposed settings while the preview is still pending', async () => {
    const user = userEvent.setup();
    executionPreview.mockReset().mockReturnValue(new Promise(() => {}));
    validateGrid.mockReset().mockReturnValue(new Promise(() => {}));
    withProposal(
      {
        mode: 'custom',
        scope: 'lean-fix',
        grid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
        guardPolicy: 'relaxed',
        baseScope: 'bugfix',
      },
      { settingsScope: 'bugfix' },
    );

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'lean-fix',
      composedGrid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      policyScope: 'bugfix',
      aidlcSettings: { guardPolicy: 'relaxed' },
    });
  });

  // The same, after the preview FAILED: a transport error must not silently
  // turn an accepted policy into the scope default.
  it('applies the proposed settings after the preview failed', async () => {
    const user = userEvent.setup();
    executionPreview.mockReset().mockRejectedValue(new Error('offline'));
    withProposal(
      {
        mode: 'matched',
        scope: 'bugfix',
        guardPolicy: 'relaxed',
        scopeSettings: { collaborators: 'off' },
      },
      { settingsScope: 'bugfix' },
    );

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'bugfix',
      aidlcSettings: { guardPolicy: 'relaxed', collaborators: 'off' },
    });
  });

  // A 2.11 draft customized before the base was recorded — a fork draft, or one
  // that went through the pending-preview window above. The base is taken from
  // the proposal the job validated, so Apply does not store a value the server
  // would then resolve against a different scope.
  it('applies a proposal onto a customized draft that has no recorded base', async () => {
    const user = userEvent.setup();
    draftState.scope = 'feature-custom';
    draftState.policyScope = null;
    draftState.composedGrid = { init: 'EXECUTE', design: 'EXECUTE', build: 'EXECUTE' };
    withProposal(
      {
        mode: 'custom',
        scope: 'enterprise-custom',
        grid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
        guardPolicy: 'relaxed',
        baseScope: 'enterprise',
      },
      { settingsScope: 'enterprise' },
    );

    renderPage();
    await user.click(await screen.findByTestId('proposal-apply'));

    expect(applyComposedSelection).toHaveBeenCalledWith({
      scope: 'enterprise-custom',
      composedGrid: { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      policyScope: 'enterprise',
      aidlcSettings: { guardPolicy: 'relaxed' },
    });
  });

  // The toggle in the same window. The base comes from the SELECTION — a stock
  // scope is a stock scope whatever a preview says — so the first toggle cannot
  // withdraw the whole policy because a request had not come back.
  it('records the base scope on a first toggle while the preview is pending', async () => {
    const user = userEvent.setup();
    listComposes.mockReset().mockResolvedValue({ composes: [] });
    executionPreview.mockReset().mockReturnValue(new Promise(() => {}));
    validateGrid.mockReset().mockReturnValue(new Promise(() => {}));

    renderPage();
    await user.click(await screen.findByTestId('grid-editor-toggle'));
    await user.click(screen.getByTestId('grid-stage-design').querySelector('input')!);

    expect(setComposedGrid).toHaveBeenCalledWith(
      { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      'feature',
    );
  });

  // An older bundle cleared the grid without clearing the base it belonged to,
  // so the shared document can still hold one. Reading it without a grid would
  // run a feature-derived grid on Classic's policy and settings.
  it('ignores a base left in the document when the selection has no grid', async () => {
    const user = userEvent.setup();
    listComposes.mockReset().mockResolvedValue({ composes: [] });
    draftState.scope = 'feature';
    draftState.policyScope = 'classic';
    draftState.composedGrid = null;

    renderPage();
    await user.click(await screen.findByTestId('grid-editor-toggle'));
    await user.click(screen.getByTestId('grid-stage-design').querySelector('input')!);

    expect(setComposedGrid).toHaveBeenCalledWith(
      { init: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
      'feature',
    );
  });
});

describe('IntentComposePage — a pinned release that no longer resolves', () => {
  beforeEach(() => {
    for (const k of Object.keys(draftState)) delete draftState[k];
    draftState.prompt = 'Build X';
    draftState.scope = 'feature';
    start.mockReset().mockResolvedValue({});
    update.mockReset().mockResolvedValue({});
    compose.mockReset().mockResolvedValue({ composeId: 'c1', state: 'PENDING', mode: 'front' });
    listComposes.mockReset().mockResolvedValue({ composes: [] });
    attachments.mockReset().mockResolvedValue({ attachments: [], attachmentRevision: 0 });
    getProjectCapabilities.mockReset().mockResolvedValue({ available: ['kiro'], runtimeClis: [] });
    flushDraft.mockReset().mockResolvedValue(undefined);
    reloadIntent.mockReset().mockResolvedValue(undefined);
    getWorkflow.mockReset().mockResolvedValue({ phases: [] });
    executionPreview.mockReset().mockRejectedValue(new Error('release not found'));
    validateGrid.mockReset().mockRejectedValue(new Error('release not found'));
    compiled.mockReset().mockRejectedValue(new Error('release not found'));
    useProjectCache.mockReset();
    useProjectCache.mockReturnValue({ project: baseProject(), loading: false });
    get
      .mockReset()
      .mockResolvedValue(draftIntent({ methodologyRelease: { releaseId: 'aidlc:demoted' } }));
  });

  it('shows the inline notice instead of falling back to the live workflow', async () => {
    renderPage();

    const notice = await screen.findByTestId('release-view-unavailable');
    expect(notice.textContent).toContain('no longer offered');
    expect(notice.textContent).toContain('still runs on its pinned version');
    // The live-workflow read is the silent fallback that must NOT happen.
    expect(getWorkflow).not.toHaveBeenCalled();
  });

  it('uses the intent workflow id and version for compile and preview reads', async () => {
    useProjectCache.mockReturnValue({
      project: baseProject({ workflowId: 'project-latest', workflowVersion: 9 }),
      loading: false,
    });
    get.mockReset().mockResolvedValue(
      draftIntent({
        workflowId: 'aidlc-v2',
        workflowVersion: 7,
        methodologyRelease: { releaseId: 'aidlc:demoted', importerRevision: 1 },
      }),
    );
    renderPage();

    await waitFor(() =>
      expect(compiled).toHaveBeenCalledWith('aidlc-v2', 7, 'aidlc:demoted', 1, {
        projectId: 'p1',
        intentId: 'i1',
      }),
    );
    await waitFor(() =>
      expect(executionPreview).toHaveBeenCalledWith(
        'aidlc-v2',
        'feature',
        7,
        undefined,
        'aidlc:demoted',
        1,
        { projectId: 'p1', intentId: 'i1' },
      ),
    );
  });

  it("passes the pin's own importer revision so an upgraded release still compiles this intent's closure", async () => {
    get.mockResolvedValue(
      draftIntent({
        workflowVersion: 7,
        methodologyRelease: { releaseId: 'aidlc:demoted', importerRevision: 1 },
      }),
    );

    renderPage();

    await waitFor(() =>
      expect(compiled).toHaveBeenCalledWith('aidlc-v2', 7, 'aidlc:demoted', 1, {
        projectId: 'p1',
        intentId: 'i1',
      }),
    );
  });

  it('does not show the notice for an unpinned intent whose compile fails', async () => {
    get.mockResolvedValue(draftIntent());

    renderPage();

    // The unpinned failure keeps its existing generic error banner.
    await screen.findByText('release not found');
    expect(screen.queryByTestId('release-view-unavailable')).not.toBeInTheDocument();
  });
});
