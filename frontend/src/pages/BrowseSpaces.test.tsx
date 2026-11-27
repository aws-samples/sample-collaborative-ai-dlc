import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { DiscoverableSpace } from '@/services/projects';

const service = vi.hoisted(() => ({
  listDiscoverable: vi.fn(),
  requestAccess: vi.fn(),
  withdrawAccessRequest: vi.fn(),
}));
vi.mock('@/services/projects', () => ({ projectsService: service }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { userId: 'me' } }),
}));

import BrowseSpaces from './BrowseSpaces';

const space = (over: Partial<DiscoverableSpace>): DiscoverableSpace => ({
  id: 'p1',
  name: 'Payments',
  description: 'Card payments team',
  owners: [{ email: 'owner@example.com' }],
  access: 'none',
  ...over,
});

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/browse-spaces']}>
      <Routes>
        <Route path="/browse-spaces" element={<BrowseSpaces />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  service.listDiscoverable
    .mockReset()
    .mockResolvedValue([
      space({}),
      space({ id: 'p2', name: 'Data lake', description: '', access: 'member', owners: [] }),
      space({ id: 'p3', name: 'Mobile', description: 'Apps', access: 'pending' }),
    ]);
  service.requestAccess.mockReset().mockResolvedValue({});
  service.withdrawAccessRequest.mockReset().mockResolvedValue(undefined);
});

describe('BrowseSpaces', () => {
  it('lists discoverable spaces with their description, Owners and the right action', async () => {
    renderPage();
    const list = await screen.findByRole('list', { name: 'Discoverable spaces' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('Card payments team')).toBeInTheDocument();
    expect(within(items[0]).getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request access to Payments' })).toBeInTheDocument();
    expect(within(items[1]).getByText('Joined')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw request for Mobile' })).toBeInTheDocument();
  });

  it('filters by name, description or Owner', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Discoverable spaces' });
    await userEvent.type(screen.getByLabelText('Search spaces'), 'apps');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Mobile')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search spaces'));
    await userEvent.type(screen.getByLabelText('Search spaces'), 'nothing like it');
    expect(screen.getByText('No matching spaces')).toBeInTheDocument();
  });

  it('sends a request with an optional message and shows it as requested', async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Request access to Payments' }),
    );
    await userEvent.type(screen.getByLabelText('Message (optional)'), '  I build the card API ');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(service.requestAccess).toHaveBeenCalledWith('p1', 'I build the card API');
    expect(
      await screen.findByRole('button', { name: 'Withdraw request for Payments' }),
    ).toBeInTheDocument();
  });

  it('keeps the dialog open with the error when the request fails', async () => {
    service.requestAccess.mockRejectedValueOnce(
      new Error('You already have a pending request for this space'),
    );
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Request access to Payments' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(service.requestAccess).toHaveBeenCalledWith('p1', undefined);
    expect(await screen.findByRole('alert')).toHaveTextContent('already have a pending request');
    // The directory is re-read so the space shows where the user really stands.
    expect(service.listDiscoverable).toHaveBeenCalledTimes(2);
  });

  it('withdraws the signed-in user’s own request', async () => {
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Withdraw request for Mobile' }),
    );
    expect(service.withdrawAccessRequest).toHaveBeenCalledWith('p3', 'me');
    expect(
      await screen.findByRole('button', { name: 'Request access to Mobile' }),
    ).toBeInTheDocument();
  });

  it('opens a space the user already belongs to', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Discoverable spaces' });
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/space/p2');
  });

  it('explains an empty directory', async () => {
    service.listDiscoverable.mockResolvedValueOnce([]);
    renderPage();
    expect(await screen.findByText('No discoverable spaces yet')).toBeInTheDocument();
  });

  it('re-reads the directory when withdrawing fails', async () => {
    service.withdrawAccessRequest.mockRejectedValueOnce(new Error('Request not found'));
    service.listDiscoverable
      .mockResolvedValueOnce([space({ id: 'p3', name: 'Mobile', access: 'pending' })])
      .mockResolvedValueOnce([space({ id: 'p3', name: 'Mobile', access: 'member' })]);
    renderPage();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Withdraw request for Mobile' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Request not found');
    expect(await screen.findByText('Joined')).toBeInTheDocument();
  });
});
