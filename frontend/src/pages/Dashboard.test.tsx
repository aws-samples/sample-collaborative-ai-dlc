import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/services/projects', () => ({
  projectsService: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectsCache: () => ({
    projects: [],
    loading: false,
    error: null,
    refresh: () => {},
    invalidate: () => {},
  }),
  projectLastActivityAt: () => null,
}));
vi.mock('@/hooks/useProjectSort', () => ({
  useProjectSort: () => ['activity', vi.fn()],
  projectComparator: () => () => 0,
  PROJECT_SORT_LABELS: { activity: 'Activity', created: 'Created', name: 'Name' },
}));

import Dashboard from './Dashboard';

describe('Dashboard — branding', () => {
  it('shows "Spaces" as the hero title and explains shared workspaces', () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Spaces' })).toBeInTheDocument();
    expect(
      screen.getByText('Shared workspaces where people and AI agents build together'),
    ).toBeInTheDocument();
  });
});
