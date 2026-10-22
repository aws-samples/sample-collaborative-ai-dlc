import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listExternalProjects = vi.hoisted(() => vi.fn());
vi.mock('@/services/trackers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/trackers')>();
  return { ...actual, trackersService: { listExternalProjects } };
});

import { JiraProjectPickerDialog } from './JiraProjectPickerDialog';

const PROJECTS = [
  { key: 'ENG', name: 'Engineering', displayKey: 'ENG', projectTypeKey: 'software' },
  { key: 'IDEAS', name: 'Product Ideas', displayKey: 'IDEAS', projectTypeKey: 'product_discovery' },
  { key: 'OPS', name: 'Operations', displayKey: 'OPS', projectTypeKey: 'service_desk' },
];

beforeEach(() => {
  listExternalProjects.mockReset();
  listExternalProjects.mockResolvedValue(PROJECTS);
});

describe('JiraProjectPickerDialog', () => {
  it('searches by name or key, labels project types and binds the chosen one', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<JiraProjectPickerDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);

    const search = await screen.findByRole('textbox', { name: 'Search Jira projects' });
    expect(screen.getByText(/Product Discovery/)).toBeInTheDocument();
    // Nothing is preselected, so Add can't bind an unseen first project.
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    await userEvent.type(search, 'idea');
    expect(screen.queryByText('Engineering')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio'));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onConfirm).toHaveBeenCalledWith(PROJECTS[1]);

    await userEvent.clear(search);
    await userEvent.type(search, 'ops');
    expect(screen.getByText('Operations')).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(screen.getByText('No projects match "zzz".')).toBeInTheDocument();
  });
  it('clears a selection the search hides, so Add cannot submit an unseen project', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<JiraProjectPickerDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    const search = await screen.findByRole('textbox', { name: 'Search Jira projects' });
    const add = screen.getByRole('button', { name: 'Add' });

    await userEvent.click(screen.getByRole('radio', { name: /Engineering/ }));
    expect(add).toBeEnabled();

    await userEvent.type(search, 'ops');
    expect(screen.queryByText('Engineering')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Operations/ })).not.toBeChecked();
    expect(add).toBeDisabled();

    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(add).toBeDisabled();

    await userEvent.clear(search);
    await userEvent.type(search, 'ops');
    await userEvent.click(screen.getByRole('radio', { name: /Operations/ }));
    await userEvent.click(add);
    expect(onConfirm).toHaveBeenCalledWith(PROJECTS[2]);
  });

  it('keeps a selection the search still shows', async () => {
    render(<JiraProjectPickerDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    const search = await screen.findByRole('textbox', { name: 'Search Jira projects' });
    await userEvent.click(screen.getByRole('radio', { name: /Engineering/ }));
    await userEvent.type(search, 'eng');
    expect(screen.getByRole('radio', { name: /Engineering/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });
});
