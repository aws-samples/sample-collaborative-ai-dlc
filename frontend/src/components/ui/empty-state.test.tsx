import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FolderGit2 } from 'lucide-react';
import { Button } from './button';
import { EmptyState } from './empty-state';

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
  it.each([EmptyState])('renders an h3 by default and the requested level otherwise', (State) => {
    const { rerender } = render(<State title="No spaces yet" />);
    expect(screen.getByRole('heading', { level: 3, name: 'No spaces yet' })).toBeInTheDocument();
    rerender(<State headingLevel={1} title="This page doesn't exist" />);
    expect(
      screen.getByRole('heading', { level: 1, name: "This page doesn't exist" }),
    ).toBeInTheDocument();
  });
});
