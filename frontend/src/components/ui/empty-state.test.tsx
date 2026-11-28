import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FolderGit2 } from 'lucide-react';
import { Button } from './button';
import { EmptyState, ErrorState, LoadingState } from './empty-state';

describe('EmptyState', () => {
  it('renders icon, title, description and exactly one primary action', () => {
    render(
      <EmptyState
        icon={FolderGit2}
        title="No spaces yet"
        description="Create your first space to start."
        action={<Button>New space</Button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No spaces yet' })).toBeInTheDocument();
    expect(screen.getByText('Create your first space to start.')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'New space' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // P2-5 (a11y audit): the title was always an h3, even as a page's only heading.
  it.each([EmptyState, ErrorState])(
    'renders an h3 by default and the requested level otherwise',
    (State) => {
      const { rerender } = render(<State title="No spaces yet" />);
      expect(screen.getByRole('heading', { level: 3, name: 'No spaces yet' })).toBeInTheDocument();
      rerender(<State headingLevel={1} title="This page doesn't exist" />);
      expect(
        screen.getByRole('heading', { level: 1, name: "This page doesn't exist" }),
      ).toBeInTheDocument();
    },
  );
});

describe('ErrorState', () => {
  it('calls onRetry from a single Retry button', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState title="Couldn't load spaces" description="Network error" onRetry={onRetry} />,
    );
    expect(screen.getByText("Couldn't load spaces")).toBeInTheDocument();
    expect(screen.getByText('Network error')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('marks the Retry button busy while retrying', () => {
    render(<ErrorState title="Failed" onRetry={() => {}} retrying />);
    const button = screen.getByRole('button', { name: 'Retry' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('is only an alert when live', () => {
    const { rerender } = render(<ErrorState title="Failed" />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<ErrorState title="Failed" live />);
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
  });

  it('renders no retry control without onRetry, but allows a secondary action', () => {
    render(
      <ErrorState
        title="Access expired"
        secondaryAction={<Button variant="outline">Reconnect GitHub</Button>}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reconnect GitHub' })).toBeInTheDocument();
  });
});

describe('LoadingState', () => {
  it('is a single labelled status region with decorative skeleton bars', () => {
    render(<LoadingState label="Loading intents" />);
    const status = screen.getByRole('status', { name: 'Loading intents' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(status.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });
});
