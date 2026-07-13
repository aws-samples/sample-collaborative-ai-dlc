import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const compose = vi.fn();
const listComposes = vi.fn();
const recompose = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    compose: (...a: unknown[]) => compose(...a),
    listComposes: (...a: unknown[]) => listComposes(...a),
    recompose: (...a: unknown[]) => recompose(...a),
  },
}));

const compiled = vi.fn();
const getWorkflow = vi.fn();
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: (...a: unknown[]) => compiled(...a),
    get: (...a: unknown[]) => getWorkflow(...a),
  },
}));

import { RecomposePanel } from './RecomposePanel';
import type { Intent, IntentStage } from '@/services/intents';

const intent = (over: Partial<Intent> = {}): Intent =>
  ({
    id: 'i1',
    executionId: 'i1',
    projectId: 'p1',
    title: 'I',
    prompt: 'X',
    status: 'WAITING',
    workflowId: 'aidlc-v2',
    workflowVersion: 4,
    scope: 'feature',
    composedGrid: null,
    ...over,
  }) as Intent;

const stageRow = (stageId: string, state: string): IntentStage =>
  ({ stageInstanceId: `si-${stageId}`, stageId, state, attempt: 0 }) as IntentStage;

const renderPanel = (over: Partial<Parameters<typeof RecomposePanel>[0]> = {}) =>
  render(
    <RecomposePanel
      projectId="p1"
      intentId="i1"
      intent={intent()}
      stageRows={[stageRow('analyze', 'SUCCEEDED'), stageRow('optional', 'WAITING_FOR_HUMAN')]}
      workflowVersion={4}
      onRelaunched={vi.fn()}
      {...over}
    />,
  );

describe('RecomposePanel', () => {
  beforeEach(() => {
    compose.mockReset().mockResolvedValue({ composeId: 'c1', mode: 'inflight', state: 'PENDING' });
    listComposes.mockReset().mockResolvedValue({ composes: [] });
    recompose.mockReset().mockResolvedValue({});
    compiled.mockReset().mockResolvedValue({
      scopeGrid: {
        feature: { init: 'EXECUTE', analyze: 'EXECUTE', optional: 'EXECUTE', build: 'EXECUTE' },
      },
      autonomy: { perStage: {}, rollup: { selfHalting: 0, mixed: 0, humanGated: 0, total: 0 } },
      graph: {
        nodes: [
          { stageId: 'init', phasePath: '01', order: 0 },
          { stageId: 'analyze', phasePath: '03', order: 1 },
          { stageId: 'optional', phasePath: '03', order: 2 },
          { stageId: 'build', phasePath: '04', order: 3 },
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
          name: 'Init',
          kind: 'phase',
          path: '01',
          parentPath: null,
          order: 0,
        },
        {
          phaseId: 'inception',
          name: 'Inception',
          kind: 'phase',
          path: '03',
          parentPath: null,
          order: 2,
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
  });

  it('is collapsed by default and fetches the workflow only when opened', async () => {
    renderPanel();
    expect(compiled).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByTestId('recompose-toggle'));
    await waitFor(() => expect(compiled).toHaveBeenCalled());
    expect(await screen.findByTestId('stage-grid-editor')).toBeInTheDocument();
  });

  it('locks frozen (ran) stages and initialization; a manual flip applies via /recompose', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId('recompose-toggle'));
    await screen.findByTestId('stage-grid-editor');
    // analyze ran, init is initialization — both locked.
    expect(screen.getByTestId('grid-stage-analyze').querySelector('input')!.disabled).toBe(true);
    expect(screen.getByTestId('grid-stage-init').querySelector('input')!.disabled).toBe(true);
    // build is pending — flip it to SKIP and apply.
    await user.click(screen.getByTestId('grid-stage-build').querySelector('input')!);
    await user.click(screen.getByTestId('recompose-apply-manual'));
    await waitFor(() =>
      expect(recompose).toHaveBeenCalledWith('p1', 'i1', {
        composedGrid: expect.objectContaining({
          init: 'EXECUTE',
          analyze: 'EXECUTE',
          optional: 'EXECUTE',
          build: 'SKIP',
        }),
        scope: 'feature-recomposed',
      }),
    );
  });

  it('asks the composer in inflight mode and applies its proposal', async () => {
    const user = userEvent.setup();
    listComposes.mockResolvedValue({ composes: [] });
    renderPanel();
    await user.click(screen.getByTestId('recompose-toggle'));
    await user.type(screen.getByTestId('recompose-instructions'), 'trim it');
    await user.click(screen.getByTestId('recompose-ask-composer'));
    await waitFor(() =>
      expect(compose).toHaveBeenCalledWith('p1', 'i1', {
        mode: 'inflight',
        instructions: 'trim it',
      }),
    );
    // The poll returns a completed proposal.
    listComposes.mockResolvedValue({
      composes: [
        {
          composeId: 'c1',
          mode: 'inflight',
          state: 'COMPLETED',
          source: 'llm',
          proposal: {
            mode: 'custom',
            scope: 'trimmed',
            grid: { init: 'EXECUTE', analyze: 'EXECUTE', optional: 'EXECUTE', build: 'SKIP' },
            rationale: ['tail not needed'],
            confidence: 0.9,
          },
          validation: {
            valid: true,
            errors: [],
            warnings: [],
            summary: {
              executedStages: 3,
              totalStages: 4,
              approvalGates: 2,
              perUnitStages: 0,
              skippedStages: 0,
              outOfScopeStages: 1,
            },
          },
          failureReason: null,
        },
      ],
    });
    const proposalCard = await screen.findByTestId('recompose-proposal', undefined, {
      timeout: 6000,
    });
    expect(proposalCard.textContent).toContain('trimmed');
    await user.click(screen.getByTestId('recompose-apply-proposal'));
    await waitFor(() =>
      expect(recompose).toHaveBeenCalledWith('p1', 'i1', {
        composedGrid: { init: 'EXECUTE', analyze: 'EXECUTE', optional: 'EXECUTE', build: 'SKIP' },
        scope: 'trimmed',
      }),
    );
  });
});
