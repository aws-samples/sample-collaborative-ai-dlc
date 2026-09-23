import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentDetail, QuorumEdit, QuorumEditPlanItem } from '@/services/intents';

const mocks = vi.hoisted(() => ({
  decideQuorumEdit: vi.fn(),
  openArtifactPreview: vi.fn(),
  reload: vi.fn(),
}));

let detail: IntentDetail;

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({
    detail,
    projectId: 'project-1',
    intentId: 'intent-1',
    openArtifactPreview: mocks.openArtifactPreview,
    reload: mocks.reload,
  }),
}));

vi.mock('@/services/intents', () => ({
  intentsService: {
    decideQuorumEdit: (...args: unknown[]) => mocks.decideQuorumEdit(...args),
  },
}));

import { QuorumEditPanel } from './QuorumEditPanel';

const nestedPath = (index: number) =>
  `docs/architecture/workstreams/customer-experience/decisions/${String(index).padStart(2, '0')}/deeply-nested-artifact-with-a-realistically-long-file-name-${index}.md`;

const approvalTextPath =
  'docs/architecture/CustomerExperienceAuthorizationAndSessionManagementImplementation.md';

const planItem = (index: number): QuorumEditPlanItem => ({
  artifactId: nestedPath(index),
  title: `Architecture decision ${index + 1}`,
  artifactType: 'decision',
  depth: index % 4,
  action: index % 2 === 0 ? 'update' : 'verify-unaffected',
  rationale: `This artifact depends on ${approvalTextPath} through relationship ${index + 1}.`,
  proposedChange: `Update ${approvalTextPath} to reflect the revised authentication requirements.`,
});

const awaitingApprovalEdit = (items: QuorumEditPlanItem[]): QuorumEdit => ({
  editId: 'qedit-1',
  artifactId: 'target.md',
  artifactType: 'document',
  artifactTitle: 'Target document',
  changeDescription: 'Apply the requested architecture update.',
  state: 'AWAITING_APPROVAL',
  plan: {
    summary: 'Review the downstream artifacts before applying the update.',
    items,
  },
  requestedBy: 'user-1',
  requestedByName: 'Reviewer',
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  approvedArtifactIds: null,
  updatedArtifactIds: null,
  verifiedArtifactIds: null,
  failedArtifactIds: null,
  failureReason: null,
  createdAt: '2026-09-22T12:00:00.000Z',
  updatedAt: '2026-09-22T12:00:00.000Z',
  completedAt: null,
});

describe('QuorumEditPanel large artifact plans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detail = {
      quorumEdits: [
        awaitingApprovalEdit(Array.from({ length: 48 }, (_, index) => planItem(index))),
      ],
    } as IntentDetail;
  });

  it('bounds a realistic artifact set and keeps decision controls keyboard-reachable', async () => {
    const user = userEvent.setup();
    render(<QuorumEditPanel />);

    const artifactList = screen.getByRole('region', { name: 'Quorum artifact plan' });
    expect(artifactList).toHaveClass('max-h-80', 'overflow-y-auto', 'overflow-x-hidden');
    expect(artifactList).toHaveAttribute('tabindex', '0');

    const approve = screen.getByRole('button', { name: 'Approve & apply' });
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(artifactList).not.toContainElement(approve);
    expect(artifactList).not.toContainElement(reject);
    expect(within(artifactList).getAllByRole('checkbox')).toHaveLength(48);

    screen
      .getByRole('button', {
        name: new RegExp(`^Preview artifact Architecture decision 48`),
      })
      .focus();
    await user.tab();
    expect(approve).toHaveFocus();
    await user.tab();
    expect(reject).toHaveFocus();
  });

  it('wraps long rationale and proposed-change text inside the artifact row', () => {
    detail = {
      quorumEdits: [awaitingApprovalEdit([planItem(0)])],
    } as IntentDetail;
    render(<QuorumEditPanel />);

    const rationale = screen.getByText(
      `This artifact depends on ${approvalTextPath} through relationship 1.`,
    );
    const proposedChange = screen.getByText(
      (_, element) =>
        element?.textContent ===
        `→ Update ${approvalTextPath} to reflect the revised authentication requirements.`,
    );

    expect(rationale).toBeVisible();
    expect(proposedChange).toBeVisible();
    expect(rationale.parentElement).toBe(proposedChange.parentElement);
    expect(rationale.parentElement).toHaveClass('[overflow-wrap:anywhere]');
  });

  it('preserves list position and keyboard focus while selecting and previewing artifacts', async () => {
    const user = userEvent.setup();
    const view = render(<QuorumEditPanel />);
    mocks.openArtifactPreview.mockImplementation(() => {
      view.rerender(<QuorumEditPanel />);
    });

    const path = nestedPath(31);
    const artifactList = screen.getByRole('region', { name: 'Quorum artifact plan' });
    artifactList.scrollTop = 420;

    const checkbox = screen.getByRole('checkbox', {
      name: `Include artifact Architecture decision 32 (${path})`,
    });
    await user.click(screen.getByText('Architecture decision 32'));

    expect(checkbox).not.toBeChecked();
    expect(artifactList).toHaveProperty('scrollTop', 420);
    expect(checkbox).toHaveFocus();

    const preview = screen.getByRole('button', {
      name: `Preview artifact Architecture decision 32 (${path})`,
    });
    preview.focus();
    await user.keyboard('{Enter}');

    expect(mocks.openArtifactPreview).toHaveBeenCalledWith(path);
    expect(artifactList).toHaveProperty('scrollTop', 420);
    expect(preview).toHaveFocus();
    expect(screen.getByText(path)).toBeVisible();
    expect(checkbox).not.toBeChecked();
  });
});
