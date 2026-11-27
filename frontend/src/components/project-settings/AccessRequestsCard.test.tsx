import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const service = vi.hoisted(() => ({
  listAccessRequests: vi.fn(),
  decideAccessRequest: vi.fn(),
}));
vi.mock('@/services/projects', () => ({ projectsService: service }));

import { AccessRequestsCard } from './AccessRequestsCard';

const onApproved = vi.fn();

beforeEach(() => {
  // Radix Select uses browser APIs that jsdom does not implement.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  service.listAccessRequests.mockReset().mockResolvedValue([
    {
      userId: 'u1',
      email: 'asker@example.com',
      message: 'I build the card API',
      createdAt: '2026-11-27T10:00:00.000Z',
    },
    {
      userId: 'u2',
      email: 'other@example.com',
      message: '',
      createdAt: '2026-11-27T11:00:00.000Z',
    },
  ]);
  service.decideAccessRequest.mockReset().mockResolvedValue({});
  onApproved.mockReset();
});

describe('AccessRequestsCard', () => {
  it('renders nothing when no one is waiting', async () => {
    service.listAccessRequests.mockResolvedValueOnce([]);
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<AccessRequestsCard projectId="p1" onApproved={onApproved} />));
    });
    expect(service.listAccessRequests).toHaveBeenCalledWith('p1');
    expect(container).toBeEmptyDOMElement();
  });

  it('approves as Member by default and reloads the members', async () => {
    render(<AccessRequestsCard projectId="p1" onApproved={onApproved} />);
    expect(await screen.findByText('I build the card API')).toBeInTheDocument();
    expect(screen.getByText('2 waiting')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve asker@example.com' }));
    expect(service.decideAccessRequest).toHaveBeenCalledWith('p1', 'u1', 'approve', 'member');
    expect(onApproved).toHaveBeenCalled();
    expect(screen.queryByText('asker@example.com')).not.toBeInTheDocument();
  });

  it('approves with the role the Owner picks', async () => {
    render(<AccessRequestsCard projectId="p1" onApproved={onApproved} />);
    await userEvent.click(
      await screen.findByRole('combobox', { name: 'Role for other@example.com' }),
    );
    await userEvent.click(await screen.findByRole('option', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve other@example.com' }));
    expect(service.decideAccessRequest).toHaveBeenCalledWith('p1', 'u2', 'approve', 'owner');
  });

  it('offers the Viewer role', async () => {
    render(<AccessRequestsCard projectId="p1" onApproved={onApproved} />);
    await userEvent.click(
      await screen.findByRole('combobox', { name: 'Role for asker@example.com' }),
    );
    await userEvent.click(await screen.findByRole('option', { name: 'Viewer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve asker@example.com' }));
    expect(service.decideAccessRequest).toHaveBeenCalledWith('p1', 'u1', 'approve', 'viewer');
  });

  it('declines without reloading members, and shows a failure', async () => {
    render(<AccessRequestsCard projectId="p1" onApproved={onApproved} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Decline asker@example.com' }));
    expect(service.decideAccessRequest).toHaveBeenCalledWith('p1', 'u1', 'decline', undefined);
    expect(onApproved).not.toHaveBeenCalled();

    service.decideAccessRequest.mockRejectedValueOnce(new Error('Membership changed.'));
    await userEvent.click(screen.getByRole('button', { name: 'Decline other@example.com' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Membership changed.');
  });

  it('reloads when the member list changes', async () => {
    const { rerender } = render(
      <AccessRequestsCard projectId="p1" onApproved={onApproved} reloadKey="a" />,
    );
    await screen.findByText('I build the card API');
    service.listAccessRequests.mockResolvedValueOnce([]);
    await act(async () => {
      rerender(<AccessRequestsCard projectId="p1" onApproved={onApproved} reloadKey="a,b" />);
    });
    await waitFor(() => expect(screen.queryByText('I build the card API')).not.toBeInTheDocument());
  });
});
