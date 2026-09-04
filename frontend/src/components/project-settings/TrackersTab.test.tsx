import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Project, TrackerBinding } from '@/services/projects';
import type { ProjectSourceControlStatus } from '@/services/sourceControl';

// The tab reads tracker connections + operator OAuth-app config on mount. Stub
// both to empty so the component renders without network access — this test is
// only about whether the "Add <git tracker>" CTA appears for a given provider.
const listConnections = vi.hoisted(() => vi.fn());
vi.mock('@/services/trackers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/trackers')>();
  return {
    ...actual,
    trackersService: {
      listConnections: (...args: unknown[]) => listConnections(...args),
      addToProject: vi.fn(),
      removeFromProject: vi.fn(),
      getAuthUrl: vi.fn(),
    },
  };
});

vi.mock('@/hooks/useTrackerProviders', () => ({
  useTrackerProviders: () => ({ providers: [] }),
}));

const getSourceControlStatus = vi.hoisted(() => vi.fn());
vi.mock('@/services/sourceControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sourceControl')>();
  return {
    ...actual,
    sourceControlService: {
      ...actual.sourceControlService,
      getStatus: (...args: unknown[]) => getSourceControlStatus(...args),
    },
  };
});

import { TrackersTab } from './TrackersTab';

const makeProject = (overrides: Partial<Project>): Project =>
  ({
    id: 'project-1',
    gitRepo: 'acme/api',
    trackers: [],
    ...overrides,
  }) as Project;

const makeTracker = (overrides: Partial<TrackerBinding>): TrackerBinding => ({
  id: 'tracker-1',
  provider: 'github-issues',
  instance: null,
  externalProjectKey: 'acme/api',
  displayName: 'acme/api',
  createdAt: null,
  createdBy: null,
  ...overrides,
});

const sourceControlStatus = (
  authType: 'github-app' | 'github-oauth' | 'gitlab-oauth',
): ProjectSourceControlStatus => ({
  ready: true,
  repositories: [
    {
      provider: authType.startsWith('github') ? 'github' : 'gitlab',
      repo: 'acme/api',
      authType,
      status: 'active',
      invalidReason: null,
      capabilities: { repositoryWrite: true },
      verifiedAt: null,
      updatedAt: null,
    },
  ],
});

beforeEach(() => {
  listConnections.mockReset().mockResolvedValue([]);
  getSourceControlStatus.mockReset().mockResolvedValue({ ready: false, repositories: [] });
});

describe('TrackersTab — git tracker CTA', () => {
  // Bitbucket is code-host-only: there is no bitbucket-issues tracker provider,
  // so offering "Add Bitbucket" would 400 with "Unknown or missing provider".
  // Guard against a regression that re-adds Bitbucket to the CTA.
  it('does NOT offer an "Add" git-tracker CTA for a Bitbucket project', async () => {
    render(
      <TrackersTab project={makeProject({ gitProvider: 'bitbucket' })} canEdit reload={vi.fn()} />,
    );

    // Let the mount effect (listConnections) settle.
    expect(await screen.findByText('Trackers')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add /i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Start sprints from/i)).not.toBeInTheDocument();
  });

  // Counter-proof: GitHub has a real issue tracker (github-issues), so the CTA
  // must still render for a GitHub project.
  it('offers the "Add GitHub Issues" CTA for a GitHub project', async () => {
    render(
      <TrackersTab project={makeProject({ gitProvider: 'github' })} canEdit reload={vi.fn()} />,
    );

    expect(await screen.findByText('Trackers')).toBeInTheDocument();
    expect(screen.getByText(/Start sprints from/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add GitHub Issues/i })).toBeInTheDocument();
  });
});

describe('TrackersTab — tracker reconnection', () => {
  it('hides OAuth reconnection for a tracker backed by a GitHub App binding', async () => {
    getSourceControlStatus.mockResolvedValue(sourceControlStatus('github-app'));

    render(
      <TrackersTab
        project={makeProject({ trackers: [makeTracker({})] })}
        canEdit
        reload={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(getSourceControlStatus).toHaveBeenCalledWith('project-1');
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it.each([
    ['a read-only GitHub Issues binding', makeProject({ trackers: [makeTracker({})] }), false],
    ['a tracker-free project', makeProject({ trackers: [] }), true],
    [
      'a legacy GitHub Issues binding',
      makeProject({ trackers: [makeTracker({ id: 'legacy-github' })] }),
      true,
    ],
    [
      'a GitLab Issues binding',
      makeProject({
        gitProvider: 'gitlab',
        trackers: [makeTracker({ provider: 'gitlab-issues' })],
      }),
      true,
    ],
    [
      'a Jira binding',
      makeProject({
        trackers: [makeTracker({ provider: 'jira-cloud', externalProjectKey: 'AIDLC' })],
      }),
      true,
    ],
  ] as const)('does not load source-control status for %s', async (_, project, canEdit) => {
    render(<TrackersTab project={project} canEdit={canEdit} reload={vi.fn()} />);

    await waitFor(() => {
      expect(listConnections).toHaveBeenCalledOnce();
    });
    expect(getSourceControlStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['GitHub OAuth', 'github', 'github-issues', 'github-oauth'],
    ['GitLab OAuth', 'gitlab', 'gitlab-issues', 'gitlab-oauth'],
  ] as const)(
    'offers reconnection for a tracker backed by %s',
    async (_, provider, tracker, auth) => {
      getSourceControlStatus.mockResolvedValue(sourceControlStatus(auth));

      render(
        <TrackersTab
          project={makeProject({
            gitProvider: provider,
            trackers: [makeTracker({ provider: tracker })],
          })}
          canEdit
          reload={vi.fn()}
        />,
      );

      expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    },
  );

  it('keeps reconnection available for Jira trackers', async () => {
    render(
      <TrackersTab
        project={makeProject({
          trackers: [
            makeTracker({
              provider: 'jira-cloud',
              externalProjectKey: 'AIDLC',
              displayName: 'AI-DLC',
            }),
          ],
        })}
        canEdit
        reload={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('keeps reconnection available when binding status cannot be loaded', async () => {
    getSourceControlStatus.mockRejectedValue(new Error('status unavailable'));

    render(
      <TrackersTab
        project={makeProject({ trackers: [makeTracker({})] })}
        canEdit
        reload={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });
});
