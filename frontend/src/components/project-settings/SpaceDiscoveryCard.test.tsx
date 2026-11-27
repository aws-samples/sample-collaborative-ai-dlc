import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Project } from '@/services/projects';

const update = vi.hoisted(() => vi.fn());
vi.mock('@/services/projects', () => ({ projectsService: { update } }));
vi.mock('@/hooks/useProjectsCache', () => ({ invalidateProjects: vi.fn() }));

import { SpaceDiscoveryCard } from './SpaceDiscoveryCard';

const project = { id: 'p1', name: 'Payments', trackers: [] } as unknown as Project;
const onProjectUpdated = vi.fn();

beforeEach(() => {
  update.mockReset().mockImplementation((_id, input) => Promise.resolve({ id: 'p1', ...input }));
  onProjectUpdated.mockReset();
});

describe('SpaceDiscoveryCard', () => {
  it('starts private and saves the switch and description together', async () => {
    render(<SpaceDiscoveryCard project={project} canEdit onProjectUpdated={onProjectUpdated} />);
    const toggle = screen.getByRole('switch', { name: 'Discoverable' });
    expect(toggle).not.toBeChecked();
    const save = screen.getByRole('button', { name: 'Save Discovery' });
    expect(save).toBeDisabled();
    await userEvent.click(toggle);
    await userEvent.type(screen.getByLabelText('Description'), 'Card payments team');
    await userEvent.click(save);
    expect(update).toHaveBeenCalledWith('p1', {
      discoverable: true,
      description: 'Card payments team',
    });
    expect(onProjectUpdated).toHaveBeenCalledWith({
      discoverable: true,
      description: 'Card payments team',
    });
  });

  it('is read-only for Members', () => {
    render(
      <SpaceDiscoveryCard
        project={{ ...project, discoverable: true, description: 'Hello' }}
        canEdit={false}
        onProjectUpdated={onProjectUpdated}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Discoverable' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Discoverable' })).toBeChecked();
    expect(screen.getByLabelText('Description')).toHaveValue('Hello');
    expect(screen.queryByRole('button', { name: 'Save Discovery' })).not.toBeInTheDocument();
  });

  it('sends only the field that changed', async () => {
    render(
      <SpaceDiscoveryCard
        project={{ ...project, discoverable: true, description: 'Old' }}
        canEdit
        onProjectUpdated={onProjectUpdated}
      />,
    );
    await userEvent.clear(screen.getByLabelText('Description'));
    await userEvent.type(screen.getByLabelText('Description'), 'New');
    await userEvent.click(screen.getByRole('button', { name: 'Save Discovery' }));
    expect(update).toHaveBeenCalledWith('p1', { description: 'New' });
    expect(onProjectUpdated).toHaveBeenCalledWith({ discoverable: true, description: 'New' });
  });
});
