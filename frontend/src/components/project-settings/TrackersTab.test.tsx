import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Project } from '@/services/projects';

// The tab reads tracker connections + operator OAuth-app config on mount. Stub
// both to empty so the component renders without network access — this test is
// only about whether the "Add <git tracker>" CTA appears for a given provider.
const listConnections = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
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

import { TrackersTab } from './TrackersTab';

const makeProject = (overrides: Partial<Project>): Project =>
  ({
    id: 'project-1',
    gitRepo: 'acme/api',
    trackers: [],
    ...overrides,
  }) as Project;

beforeEach(() => {
  listConnections.mockReset().mockImplementation(() => Promise.resolve([]));
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
