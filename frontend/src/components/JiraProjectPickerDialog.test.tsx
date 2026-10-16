import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/services/api';
import { trackersService } from '@/services/trackers';
import { JiraProjectPickerDialog } from './JiraProjectPickerDialog';

vi.mock('@/services/trackers', () => ({
  trackersService: { listExternalProjects: vi.fn() },
}));

const project = { key: 'CAREER', name: 'Career Compass' };
const expiredGrant = () => new ApiError(401, 'Jira authorization required', { reconnect: true });

beforeEach(() => {
  vi.mocked(trackersService.listExternalProjects).mockReset().mockResolvedValue([project]);
});

describe('Jira project picker authorization', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledWith(project);
    expect(onAuthorize).not.toHaveBeenCalled();
  });
});
