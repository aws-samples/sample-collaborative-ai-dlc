import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/services/api';
import { trackersService } from '@/services/trackers';

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

const project = { key: 'CAREER', name: 'Career Compass' };
const expiredGrant = () => new ApiError(401, 'Jira authorization required', { reconnect: true });

describe('Jira project picker authorization', () => {
  beforeEach(() => {
    vi.mocked(trackersService.listExternalProjects).mockReset().mockResolvedValue([project]);
  });
  it('authorizes automatically when listing projects requires a new grant', async () => {
    vi.mocked(trackersService.listExternalProjects).mockRejectedValue(expiredGrant());
    const onAuthorize = vi.fn().mockResolvedValue(undefined);
    render(
      <JiraProjectPickerDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onAuthorize={onAuthorize}
      />,
    );
    await screen.findByText('Connecting to Jira…');
    expect(onAuthorize).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /Reconnect/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('shows an add-project failure and lets the user retry without starting OAuth', async () => {
    const onAuthorize = vi.fn();
    const onOpenChange = vi.fn();
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to save tracker binding'))
      .mockResolvedValueOnce(undefined);
    render(
      <JiraProjectPickerDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        onAuthorize={onAuthorize}
      />,
    );
    await screen.findByText(project.name);
    fireEvent.click(screen.getByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Failed to save tracker binding');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(onAuthorize).not.toHaveBeenCalled();
  });

  it.each([
    new ApiError(503, 'Jira unavailable', { reconnect: false }),
    new ApiError(403, 'Access denied'),
    new Error('Network unavailable'),
  ])('does not start authorization for an unrelated failure: %s', async (error) => {
    vi.mocked(trackersService.listExternalProjects).mockRejectedValue(error);
    const onAuthorize = vi.fn();
    render(
      <JiraProjectPickerDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onAuthorize={onAuthorize}
      />,
    );
    await screen.findByText(error.message);
    expect(onAuthorize).not.toHaveBeenCalled();
  });

  it('shows an OAuth-start failure and lets the user close the picker', async () => {
    vi.mocked(trackersService.listExternalProjects).mockRejectedValue(expiredGrant());
    const onAuthorize = vi.fn().mockRejectedValue(new Error('OAuth app unavailable'));
    render(
      <JiraProjectPickerDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        onAuthorize={onAuthorize}
      />,
    );
    await screen.findByText('OAuth app unavailable');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(onAuthorize).toHaveBeenCalledOnce();
  });

  it('adds a project with a valid connection without starting OAuth', async () => {
    const onAuthorize = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <JiraProjectPickerDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        onAuthorize={onAuthorize}
      />,
    );
    await screen.findByText(project.name);
    fireEvent.click(screen.getByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledWith(project);
    expect(onAuthorize).not.toHaveBeenCalled();
  });
});
