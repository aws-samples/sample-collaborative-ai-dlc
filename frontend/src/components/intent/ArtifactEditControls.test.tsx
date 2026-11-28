import { render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactImpact, IntentArtifact } from '@/services/intents';

const artifactImpact = vi.fn();
const startQuorumEdit = vi.fn();

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({
    projectId: 'p1',
    intentId: 'i1',
    reload: vi.fn(),
    detail: { intent: { status: 'WAITING' }, quorumEdits: [] },
    compiled: null,
    stageAccess: () => ({ edit: true, decide: true }),
  }),
}));

vi.mock('@/services/intents', () => ({
  intentsService: {
    artifactImpact: (...args: unknown[]) => artifactImpact(...args),
    startQuorumEdit: (...args: unknown[]) => startQuorumEdit(...args),
    verifyArtifact: vi.fn(),
  },
}));

import { ArtifactEditControls } from './ArtifactEditControls';

const artifact: IntentArtifact = {
  id: 'architecture',
  artifactType: 'architecture',
  title: 'Architecture — Retail store',
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-arch',
  createdAt: '2026-01-03T00:00:00.000Z',
};

const impact: ArtifactImpact = {
  artifactId: 'architecture',
  artifactType: 'architecture',
  consumingStages: [
    { stageId: 'requirements-analysis', via: ['declared', 'read'] },
    { stageId: 'user-stories', via: ['declared'] },
  ],
  downstream: [
    {
      id: 'fx-req',
      title: 'Requirements — Cart quantity',
      artifactType: 'requirements',
      depth: 1,
      via: ['CONSUMES'],
      stale: false,
    },
    {
      id: 'fx-stories',
      title: null,
      artifactType: 'user-stories',
      depth: 2,
      via: ['DERIVED_FROM'],
      stale: true,
    },
  ],
  executionActive: false,
  editBlocked: false,
  blockReason: null,
  activeQuorumEditId: null,
};

describe('ArtifactEditControls — impact dialog (W14)', () => {
  beforeEach(() => {
    artifactImpact.mockReset().mockResolvedValue(impact);
  });

  it('describes the impact with display names and plain sentences, not slugs or edge labels', async () => {
    const user = userEvent.setup();
    render(<ArtifactEditControls artifact={artifact} onStartEdit={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Edit document' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Read by Requirements Analysis')).toBeInTheDocument();
    expect(within(dialog).getByText('Listed as an input of User Stories')).toBeInTheDocument();
    expect(within(dialog).getByText('2 documents were built from it')).toBeInTheDocument();
    expect(within(dialog).getByText('Requirements — Cart quantity')).toBeInTheDocument();
    expect(within(dialog).getByText(/User Stories · indirectly/)).toBeInTheDocument();
    expect(within(dialog).getByText(/already marked possibly stale/)).toBeInTheDocument();

    expect(within(dialog).queryByText(/requirements-analysis/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/declared \+ read/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/consumes|derived_from|depth \d/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText('fx-stories')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /technical details/i }));
    expect(within(dialog).getByText(/requirements-analysis/)).toBeInTheDocument();
    expect(within(dialog).getByText(/fx-stories/)).toBeInTheDocument();
  });

  it('makes Edit with Quorum the primary action and Edit anyway the secondary one', async () => {
    const user = userEvent.setup();
    const onStartEdit = vi.fn();
    render(<ArtifactEditControls artifact={artifact} onStartEdit={onStartEdit} />);

    await user.click(screen.getByRole('button', { name: 'Edit document' }));
    const dialog = await screen.findByRole('dialog');
    const quorum = within(dialog).getByRole('button', { name: 'Edit with Quorum' });
    const anyway = within(dialog).getByRole('button', { name: 'Edit anyway' });

    expect(quorum).toHaveClass('bg-primary');
    expect(anyway).not.toHaveClass('bg-primary');
    expect(quorum.compareDocumentPosition(anyway)).toBe(Node.DOCUMENT_POSITION_PRECEDING);

    await user.click(anyway);
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing downstream depends on the document', async () => {
    const user = userEvent.setup();
    artifactImpact.mockResolvedValue({ ...impact, consumingStages: [], downstream: [] });
    render(<ArtifactEditControls artifact={artifact} onStartEdit={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Edit document' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/No other work depends on this document/)).toBeInTheDocument();
  });
});
