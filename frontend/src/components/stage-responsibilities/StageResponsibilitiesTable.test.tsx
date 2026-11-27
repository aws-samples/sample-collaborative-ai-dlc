import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StageResponsibilitiesTable } from './StageResponsibilitiesTable';
import type { StageResponsibilities } from '@/services/stageResponsibilities';

const mocks = vi.hoisted(() => ({ get: vi.fn(), project: vi.fn(), workflows: vi.fn() }));
vi.mock('@/services/stageResponsibilities', () => ({
  stageResponsibilitiesService: { get: mocks.get },
}));
vi.mock('@/services/projects', () => ({ projectsService: { get: mocks.project } }));
vi.mock('@/services/workflows', () => ({ workflowsService: { list: mocks.workflows } }));

const preview: StageResponsibilities = {
  previewOnly: true,
  enforceStageRoles: false,
  workflowId: 'flow',
  workflowVersion: 3,
  roles: [
    { id: 'product-owner', name: 'Product Owner' },
    { id: 'architect', name: 'Architect' },
    { id: 'developer', name: 'Developer' },
  ],
  stages: [
    {
      stageId: 'requirements-analysis',
      gateIds: [],
      stageInstanceId: null,
      name: 'Requirements Analysis',
      permissions: {
        decisionMakerRoles: ['product-owner'],
        contributorRoles: ['architect', 'developer'],
      },
      reason: 'contributors',
      decisionMakers: [{ userId: 'ba', name: 'Selected by backend', roles: ['developer'] }],
      contributors: [{ userId: 'ba', name: 'Selected by backend', roles: ['developer'] }],
      missingDecisionMakerRoles: ['product-owner'],
      missingContributorRoles: ['architect'],
    },
    {
      stageId: 'custom',
      gateIds: [],
      stageInstanceId: null,
      name: 'Custom stage',
      permissions: null,
      reason: 'unmapped',
      decisionMakers: [],
      contributors: [],
      missingDecisionMakerRoles: [],
      missingContributorRoles: [],
    },
  ],
};
beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(preview);
  mocks.project.mockReset().mockResolvedValue({ workflowId: 'flow', workflowVersion: 3 });
  mocks.workflows.mockReset().mockResolvedValue({
    workflows: [{ id: 'flow', name: 'Workflow', version: 5, owner: 'default' }],
  });
});

describe('Stage responsibilities', () => {
  it('shows saved member changes immediately, then replaces the preview with the backend result', async () => {
    const { rerender } = render(<StageResponsibilitiesTable projectId="space" />);
    await screen.findByText('No role mapping');
    let resolve!: (value: typeof preview) => void;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise<typeof preview>((done) => {
          resolve = done;
        }),
    );
    const members = [
      {
        userId: 'po',
        email: 'po@example.com',
        role: 'member' as const,
        effectiveRoles: ['product-owner'],
      },
    ];
    rerender(<StageResponsibilitiesTable projectId="space" refreshVersion={1} members={members} />);
    const cell = () => within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1];
    expect(cell()).toHaveTextContent('po@example.com');
    expect(screen.queryByText('Loading responsibilities…')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false');
    await act(async () =>
      resolve({
        ...preview,
        stages: [
          {
            ...preview.stages[0],
            reason: 'decision-makers',
            decisionMakers: [
              { userId: 'architect', name: 'Policy-selected architect', roles: ['architect'] },
            ],
          },
        ],
      }),
    );
    expect(cell()).toHaveTextContent('Policy-selected architect');
    expect(cell()).not.toHaveTextContent('po@example.com');
    // A later Members response must not replace the completed policy result.
    rerender(
      <StageResponsibilitiesTable projectId="space" refreshVersion={1} members={[...members]} />,
    );
    expect(cell()).toHaveTextContent('Policy-selected architect');
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('discards an older response after member changes trigger a fresh request', async () => {
    let resolve!: (value: typeof preview) => void;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise<typeof preview>((done) => {
          resolve = done;
        }),
    );
    const { rerender } = render(
      <StageResponsibilitiesTable projectId="space" refreshVersion={0} />,
    );
    mocks.get.mockResolvedValue({
      ...preview,
      stages: [
        {
          ...preview.stages[0],
          reason: 'decision-makers',
          decisionMakers: [
            { userId: 'architect', name: 'Policy-selected architect', roles: ['architect'] },
          ],
        },
      ],
    });
    rerender(<StageResponsibilitiesTable projectId="space" refreshVersion={1} />);
    await screen.findByText('Policy-selected architect');
    await act(async () => resolve(preview));
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('Policy-selected architect');
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('shows the table headers and a loading row while the request is pending', async () => {
    let resolve!: (value: typeof preview) => void;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise<typeof preview>((done) => {
          resolve = done;
        }),
    );
    render(<StageResponsibilitiesTable projectId="space" />);
    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('aria-busy', 'true');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
    expect(within(table).getByRole('status')).toHaveTextContent('Loading responsibilities…');
    expect(screen.queryByText('Requirements Analysis')).not.toBeInTheDocument();

    await act(async () => resolve(preview));

    expect(table).toHaveAttribute('aria-busy', 'false');
    expect(within(table).queryByRole('status')).not.toBeInTheDocument();
    expect(within(table).getByText('Requirements Analysis')).toBeInTheDocument();
  });

  it('uses the intent pin without setup selectors and supports enforced responsibility responses', async () => {
    mocks.get.mockResolvedValue({
      ...preview,
      previewOnly: false,
      enforceStageRoles: true,
      stages: [
        { ...preview.stages[0], stageInstanceId: 'unit-a-requirements', gateIds: ['gate-a'] },
      ],
    });
    render(<StageResponsibilitiesTable projectId="space" intentId="intent-a" />);
    await screen.findByText('unit-a-requirements');
    expect(mocks.get).toHaveBeenCalledWith('space', { intentId: 'intent-a' });
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.workflows).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByText('flow · Version 3')).toBeInTheDocument();
    expect(screen.queryByText('Business role enforcement is off.')).not.toBeInTheDocument();
  });

  it('discards a late result when switching intents', async () => {
    let resolveOld!: (value: typeof preview) => void;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise<typeof preview>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { rerender } = render(
      <StageResponsibilitiesTable projectId="space" intentId="intent-a" />,
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('space', { intentId: 'intent-a' }));
    mocks.get.mockResolvedValue({ ...preview, stages: [] });
    rerender(<StageResponsibilitiesTable projectId="space" intentId="intent-b" />);
    await screen.findByText('flow · Version 3');
    expect(mocks.get).toHaveBeenLastCalledWith('space', { intentId: 'intent-b' });
    await act(async () => {
      resolveOld(preview);
    });
    expect(screen.queryByText('No role mapping')).not.toBeInTheDocument();
  });

  it('uses the space workflow resolved by the backend without configuration controls', async () => {
    const { rerender } = render(
      <StageResponsibilitiesTable projectId="space" refreshVersion={0} />,
    );
    await screen.findByText('Selected by backend');
    expect(mocks.get).toHaveBeenCalledWith('space', {});
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.workflows).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    expect(screen.queryByText('flow · Version 3')).not.toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', {
        name: 'Contributors (Fallbacks when no Decision Makers)',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No current Decision Makers\./)).not.toBeInTheDocument();
    expect(screen.getByText('No role mapping')).toBeInTheDocument();
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    expect(cells[1]).not.toHaveTextContent('Selected by backend');
    expect(within(cells[1]).getByRole('img', { name: 'No members' })).toBeInTheDocument();
    expect(cells[1]).not.toHaveTextContent('No members');
    expect(cells[1]).not.toHaveTextContent('Architect');
    expect(cells[2]).toHaveTextContent('Selected by backend');
    expect(within(cells[2]).getByText('Developer')).toBeInTheDocument();
    expect(cells[2]).not.toHaveTextContent('Architect');
    expect(cells[2]).not.toHaveTextContent('Product Owner');
    expect(screen.queryByRole('columnheader', { name: 'Unassigned' })).not.toBeInTheDocument();
    expect(cells).toHaveLength(3);
    expect(
      within(cells[1]).getByRole('button', {
        name: 'No members. Unassigned Decision Makers: Product Owner',
      }),
    ).toBeInTheDocument();
    expect(within(cells[2]).getByRole('button', { name: '1 unassigned role' })).toBeInTheDocument();
    expect(screen.queryByText(/\(Unassigned\)/)).not.toBeInTheDocument();
    mocks.get.mockResolvedValue({ ...preview, stages: [] });
    rerender(<StageResponsibilitiesTable projectId="space" refreshVersion={1} />);
    await waitFor(() => expect(screen.queryByText('Selected by backend')).not.toBeInTheDocument());
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('loads once when mounted without polling or reloading on focus', async () => {
    const interval = vi.spyOn(window, 'setInterval');
    render(<StageResponsibilitiesTable projectId="space" />);
    await screen.findByText('No role mapping');
    const intervalsAfterLoad = interval.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls.length).toBe(intervalsAfterLoad);
    expect(interval.mock.calls.some(([, delay]) => delay === 15_000)).toBe(false);
    interval.mockRestore();
  });

  it('reveals the missing roles for each column on hover or click', async () => {
    const user = userEvent.setup();
    render(<StageResponsibilitiesTable projectId="space" />);
    await screen.findByText('No role mapping');
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    await user.hover(within(cells[1]).getByRole('button'));
    const decisionRoles = await screen.findByRole('tooltip');
    expect(decisionRoles).toHaveTextContent('Unassigned Decision Makers:');
    expect(within(decisionRoles).getByRole('listitem')).toHaveTextContent('Product Owner');
    expect(decisionRoles).not.toHaveTextContent('Architect');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    await user.click(within(cells[2]).getByRole('button', { name: '1 unassigned role' }));
    const contributorRoles = await screen.findByRole('tooltip');
    expect(contributorRoles).toHaveTextContent('Unassigned Contributors:');
    expect(within(contributorRoles).getByRole('listitem')).toHaveTextContent('Architect');
    expect(contributorRoles).not.toHaveTextContent('Product Owner');
  });

  it('keeps a visible count of multiple missing roles with keyboard-accessible details', async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({
      ...preview,
      stages: [
        {
          ...preview.stages[0],
          permissions: {
            decisionMakerRoles: ['product-owner'],
            contributorRoles: ['architect', 'developer', 'product-owner'],
          },
          missingContributorRoles: ['architect', 'product-owner'],
        },
      ],
    });
    render(<StageResponsibilitiesTable projectId="space" />);
    const indicator = await screen.findByRole('button', { name: '2 unassigned roles' });
    await act(async () => {
      indicator.focus();
    });
    await user.keyboard('{Enter}');
    const roles = await screen.findByRole('tooltip');
    expect(within(roles).getByText('Architect')).toBeInTheDocument();
    expect(within(roles).getByText('Product Owner')).toBeInTheDocument();
    expect(roles).not.toHaveTextContent('Developer');
  });

  it.each([
    { missingDecisionMakerRoles: ['architect'], missingContributorRoles: [] },
    { missingDecisionMakerRoles: [], missingContributorRoles: ['architect'] },
    { missingDecisionMakerRoles: [], missingContributorRoles: [] },
  ])(
    'indicates partial assignments in the relevant column ($missingDecisionMakerRoles / $missingContributorRoles)',
    async (missing) => {
      mocks.get.mockResolvedValue({
        ...preview,
        stages: [
          {
            ...preview.stages[0],
            ...missing,
            reason: 'decision-makers',
            decisionMakers: [{ userId: 'po', name: 'Product owner', roles: ['product-owner'] }],
            permissions: {
              decisionMakerRoles: ['product-owner', 'architect'],
              contributorRoles: ['architect', 'developer'],
            },
          },
        ],
      });
      render(<StageResponsibilitiesTable projectId="space" intentId="intent-a" />);
      await screen.findByText('flow · Version 3');
      const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
      expect(!!within(cells[1]).queryByRole('button', { name: '1 unassigned role' })).toBe(
        missing.missingDecisionMakerRoles.length > 0,
      );
      expect(!!within(cells[2]).queryByRole('button', { name: '1 unassigned role' })).toBe(
        missing.missingContributorRoles.length > 0,
      );
    },
  );

  it('shows each person with only their roles for the relevant column', async () => {
    const owner = {
      userId: 'po',
      email: 'owner@example.com',
      roles: ['product-owner', 'architect'],
    };
    const developer = {
      userId: 'dev',
      email: 'developer@example.com',
      roles: ['developer'],
    };
    const architect = {
      userId: 'architect',
      email: 'architect@example.com',
      roles: ['architect', 'developer'],
    };
    mocks.get.mockResolvedValue({
      ...preview,
      stages: [
        {
          ...preview.stages[0],
          reason: 'decision-makers',
          decisionMakers: [owner],
          contributors: [owner, developer, architect],
          missingDecisionMakerRoles: [],
          missingContributorRoles: [],
        },
      ],
    });
    render(<StageResponsibilitiesTable projectId="space" intentId="intent-a" />);
    await screen.findByText('flow · Version 3');
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    const decisionMaker = within(cells[1]).getByText(owner.email);
    expect(within(decisionMaker).getByText('Product Owner')).toBeInTheDocument();
    expect(decisionMaker).not.toHaveTextContent('Architect');
    const ownerContribution = within(cells[2]).getByText(owner.email);
    expect(within(ownerContribution).getByText('Architect')).toBeInTheDocument();
    expect(ownerContribution).not.toHaveTextContent('Product Owner');
    expect(
      within(within(cells[2]).getByText(developer.email)).getByText('Developer'),
    ).toBeInTheDocument();
    expect(
      within(within(cells[2]).getByText(architect.email)).getByText('Architect, Developer'),
    ).toBeInTheDocument();
  });

  it('omits automatic stages while preserving human and unmapped stages', async () => {
    mocks.get.mockResolvedValue({
      ...preview,
      stages: [
        {
          stageId: 'state-init',
          name: 'State init',
          permissions: { decisionMakerRoles: [], contributorRoles: [], automatic: true },
          reason: 'automatic',
          decisionMakers: [],
          contributors: [],
          missingDecisionMakerRoles: [],
          missingContributorRoles: [],
        },
        ...preview.stages,
      ],
    });
    render(<StageResponsibilitiesTable projectId="space" intentId="intent-a" />);
    await screen.findByText('No role mapping');
    expect(screen.queryByText('State init')).not.toBeInTheDocument();
    expect(screen.queryByText('Automatic — no human decisions')).not.toBeInTheDocument();
    expect(screen.getByText('Requirements Analysis')).toBeInTheDocument();
    expect(screen.getByText('Custom stage')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it.each(['owners', 'decision-makers'])(
    'keeps the Decision Makers column accurate when resolution uses %s',
    async (reason) => {
      mocks.get.mockResolvedValue({
        ...preview,
        stages: [
          {
            ...preview.stages[0],
            reason,
            contributors: [],
            missingDecisionMakerRoles: reason === 'owners' ? ['product-owner'] : [],
            missingContributorRoles: ['architect', 'developer'],
          },
        ],
      });
      render(<StageResponsibilitiesTable projectId="space" intentId="intent-a" />);
      await screen.findByText('flow · Version 3');
      const cell = within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1];
      if (reason === 'owners') {
        expect(cell).toHaveTextContent('Selected by backend');
        expect(within(cell).queryByRole('img', { name: 'No members' })).not.toBeInTheDocument();
        expect(within(cell).getByText('Selected by backend')).toHaveTextContent(
          'No current Decision Makers or Contributors. Space Owners decide as fallback.',
        );
      } else {
        expect(cell).toHaveTextContent('Selected by backend');
        expect(cell).not.toHaveTextContent('fallback');
        expect(cell).not.toHaveTextContent('No members');
        expect(cell).not.toHaveTextContent('(Unassigned)');
      }
      expect(
        within(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[2]).getByRole('img', {
          name: 'No members',
        }),
      ).toBeInTheDocument();
    },
  );

  it('retains the displayed rows when the background request fails', async () => {
    const { rerender } = render(<StageResponsibilitiesTable projectId="space" />);
    await screen.findByText('No role mapping');
    mocks.get.mockRejectedValue(new Error('Stored Cedar policies are invalid'));
    rerender(<StageResponsibilitiesTable projectId="space" refreshVersion={1} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Stored Cedar policies are invalid');
    expect(screen.getByText('Selected by backend')).toBeInTheDocument();
    expect(screen.queryByText('Loading responsibilities…')).not.toBeInTheDocument();
  });
});
