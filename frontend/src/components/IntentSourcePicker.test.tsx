import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, TrackerBinding } from '@/services/projects';
import type { TrackerIssue, TrackerIssueType } from '@/services/trackers';

// Records every listIssuePages call and yields one page.
const listIssuePages = vi.hoisted(() => vi.fn());
vi.mock('@/services/trackers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/trackers')>();
  return { ...actual, trackersService: { listIssuePages } };
});

import { IntentSourcePicker } from './IntentSourcePicker';

const binding = (provider: string): TrackerBinding =>
  ({ id: 'b1', provider, instance: 'cloud', externalProjectKey: 'ARC' }) as TrackerBinding;

const renderPicker = (provider: string) =>
  render(
    <IntentSourcePicker
      project={{ id: 'p1', trackers: [binding(provider)] } as unknown as Project}
      selected={null}
      onSelect={vi.fn()}
    />,
  );

const issue = (
  key: string,
  entityType: string,
  extra: Partial<TrackerIssue> = {},
): TrackerIssue => ({
  resourceId: key,
  resourceUrl: `https://x/browse/${key}`,
  resourceType: 'issue',
  entityType,
  entityIconUrl: null,
  title: `${entityType} ${key}`,
  body: null,
  state: 'open',
  labels: [],
  author: { handle: 'A' },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...extra,
});

const SOFTWARE_TYPES: TrackerIssueType[] = [
  { name: 'Initiative', iconUrl: null, hierarchyLevel: 2, subtask: false },
  { name: 'Epic', iconUrl: null, hierarchyLevel: 1, subtask: false },
  { name: 'Defect', iconUrl: null, hierarchyLevel: 0, subtask: false },
  { name: 'Spike', iconUrl: null, hierarchyLevel: 0, subtask: false },
  { name: 'Sub-task', iconUrl: null, hierarchyLevel: -1, subtask: true },
];

const pageOf = (
  items: TrackerIssue[],
  issueTypes?: TrackerIssueType[],
  projectTypeKey = 'software',
) =>
  async function* () {
    yield { items, totalCount: null, done: true, issueTypes, projectTypeKey };
  };

// [state, q, filters] of the most recent request.
const lastRequest = () => {
  const args = listIssuePages.mock.calls.at(-1) ?? [];
  return [args[2], args[3], args[6]];
};

beforeEach(() => {
  listIssuePages.mockReset();
});

describe('IntentSourcePicker', () => {
  it("lists the bound project's own issue types and filters by them", async () => {
    listIssuePages.mockImplementation(
      pageOf([issue('PROJ-1', 'Spike'), issue('PROJ-2', 'Sub-task')], SOFTWARE_TYPES),
    );
    renderPicker('jira-cloud');
    await waitFor(() => expect(lastRequest()).toEqual(['open', undefined, { withTypes: true }]));

    const select = await screen.findByRole('combobox', { name: 'Issue type' });
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Defect' })).toBeInTheDocument(),
    );
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All types', 'Initiative', 'Epic', 'Defect', 'Spike', 'Sub-task']);

    await userEvent.selectOptions(select, 'Spike');
    await waitFor(() =>
      expect(lastRequest()).toEqual(['open', undefined, { type: 'Spike', withTypes: true }]),
    );

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(lastRequest()[0]).toBe('all'));
  });

  it("shows an issue's parent and drills into children", async () => {
    listIssuePages.mockImplementation(
      pageOf(
        [
          issue('PROJ-5', 'Epic'),
          issue('PROJ-6', 'Story', {
            parent: { resourceId: 'PROJ-5', title: 'Login', entityType: 'Epic' },
          }),
          issue('PROJ-7', 'Sub-task'),
        ],
        [...SOFTWARE_TYPES, { name: 'Story', iconUrl: null, hierarchyLevel: 0, subtask: false }],
      ),
    );
    renderPicker('jira-cloud');

    expect(await screen.findByText('Epic PROJ-5 Login')).toBeInTheDocument();
    // Sub-tasks have nothing beneath them.
    expect(screen.queryByRole('button', { name: 'Children of PROJ-7' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Children of PROJ-5' }));
    await waitFor(() =>
      expect(lastRequest()).toEqual(['open', undefined, { parent: 'PROJ-5', withTypes: true }]),
    );
    const trail = screen.getByRole('navigation', { name: 'Hierarchy' });
    expect(within(trail).getByText('PROJ-5')).toHaveAttribute('aria-current', 'location');

    await userEvent.click(within(trail).getByRole('button', { name: 'All' }));
    await waitFor(() => expect(lastRequest()[2]).toEqual({ withTypes: true }));
    expect(screen.queryByRole('navigation', { name: 'Hierarchy' })).not.toBeInTheDocument();
  });

  it('browses linked items in a Product Discovery project, without a Type filter', async () => {
    listIssuePages.mockImplementation(
      pageOf(
        [issue('IDEAS-1', 'Idea')],
        [{ name: 'Idea', iconUrl: null, hierarchyLevel: 0, subtask: false }],
        'product_discovery',
      ),
    );
    renderPicker('jira-cloud');
    await userEvent.click(await screen.findByRole('button', { name: 'Linked items of IDEAS-1' }));
    await waitFor(() => expect(lastRequest()[2]).toMatchObject({ parent: 'IDEAS-1' }));
    // Linked items sit in other projects, so the Discovery project's types don't apply.
    expect(screen.queryByRole('combobox', { name: 'Issue type' })).not.toBeInTheDocument();

    const trail = screen.getByRole('navigation', { name: 'Hierarchy' });
    await userEvent.click(within(trail).getByRole('button', { name: 'All' }));
    expect(await screen.findByRole('combobox', { name: 'Issue type' })).toBeInTheDocument();
  });

  it('clears the type and search that found a parent when opening its children', async () => {
    listIssuePages.mockImplementation(pageOf([issue('PROJ-5', 'Epic')], SOFTWARE_TYPES));
    renderPicker('jira-cloud');

    const select = await screen.findByRole('combobox', { name: 'Issue type' });
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Epic' })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(select, 'Epic');
    const search = screen.getByRole('textbox', { name: /Search/ });
    await userEvent.type(search, 'PROJ-5');
    await waitFor(() =>
      expect(lastRequest()).toEqual(['open', 'PROJ-5', { type: 'Epic', withTypes: true }]),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Children of PROJ-5' }));
    await waitFor(() =>
      expect(lastRequest()).toEqual(['open', undefined, { parent: 'PROJ-5', withTypes: true }]),
    );
    expect(select).toHaveValue('');
    expect(search).toHaveValue('');
  });

  it('ignores a late response from a tracker that is no longer selected', async () => {
    let releaseSoftware: () => void = () => {};
    const softwareHeld = new Promise<void>((resolve) => {
      releaseSoftware = resolve;
    });
    listIssuePages.mockImplementation((_projectId: string, bindingId: string) =>
      bindingId === 'b1'
        ? (async function* () {
            await softwareHeld;
            yield {
              items: [issue('PROJ-1', 'Epic')],
              totalCount: null,
              done: true,
              issueTypes: SOFTWARE_TYPES,
              projectTypeKey: 'software',
            };
          })()
        : pageOf(
            [issue('IDEAS-1', 'Idea')],
            [{ name: 'Idea', iconUrl: null, hierarchyLevel: 0, subtask: false }],
            'product_discovery',
          )(),
    );
    render(
      <IntentSourcePicker
        project={
          {
            id: 'p1',
            trackers: [
              binding('jira-cloud'),
              { ...binding('jira-cloud'), id: 'b2', externalProjectKey: 'IDEAS' },
            ],
          } as unknown as Project
        }
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    await waitFor(() => expect(listIssuePages).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole('button', { name: /IDEAS/ }));
    expect(
      await screen.findByRole('button', { name: 'Linked items of IDEAS-1' }),
    ).toBeInTheDocument();

    releaseSoftware();
    await softwareHeld;
    // Give the superseded request a chance to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/PROJ-1/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Linked items of IDEAS-1' })).toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Issue type' });
    expect(within(select).queryByRole('option', { name: 'Epic' })).not.toBeInTheDocument();
  });

  it('shows no Jira-only filters for other trackers', async () => {
    listIssuePages.mockImplementation(pageOf([issue('1', 'Issue')]));
    renderPicker('github-issues');
    await waitFor(() => expect(listIssuePages).toHaveBeenCalled());
    expect(screen.queryByRole('combobox', { name: 'Issue type' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    expect(lastRequest()).toEqual(['open', undefined, {}]);
  });
});
