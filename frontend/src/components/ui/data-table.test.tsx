import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { Button } from './button';
import { DataTable, type DataTableColumn } from './data-table';

interface Space {
  id: string;
  name: string;
  runs: number;
  repo: string;
}

const rows: Space[] = [
  { id: 'a', name: 'Checkout', runs: 12, repo: 'acme/checkout' },
  { id: 'b', name: 'Payments', runs: 3, repo: 'acme/payments' },
];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderTable(extra: Partial<React.ComponentProps<typeof DataTable<Space>>> = {}) {
  const onAction = vi.fn();
  const columns: DataTableColumn<Space>[] = [
    { id: 'name', header: 'Space', cell: (row) => row.name },
    { id: 'repo', header: 'Repository', cell: (row) => row.repo, hideBelow: 'md' },
    { id: 'runs', header: 'Runs', cell: (row) => row.runs, numeric: true, width: '6rem' },
  ];
  const utils = render(
    <MemoryRouter initialEntries={['/']}>
      <LocationProbe />
      <Routes>
        <Route
          path="/"
          element={
            <DataTable<Space>
              aria-label="Spaces"
              columns={columns}
              rows={rows}
              getRowId={(row) => row.id}
              rowHref={(row) => `/space/${row.id}`}
              rowActions={(row) => (
                <Button size="xs" variant="ghost" onClick={() => onAction(row.id)}>
                  Delete
                </Button>
              )}
              {...extra}
            />
          }
        />
        <Route path="/space/:id" element={<p>Space page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...utils, onAction };
}

describe('DataTable', () => {
  it('renders a semantic table with column headers and a row header per row', () => {
    renderTable();
    const table = screen.getByRole('table', { name: 'Spaces' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Space', 'Repository', 'Runs', 'Actions']);
    const rowHeaders = within(table).getAllByRole('rowheader');
    expect(rowHeaders).toHaveLength(2);
    expect(rowHeaders[0]).toHaveAttribute('scope', 'row');
  });

  it('makes the first cell a stretched link so a click in the middle of another cell navigates', async () => {
    renderTable();
    const link = screen.getByRole('link', { name: 'Checkout' });
    expect(link).toHaveAttribute('href', '/space/a');
    expect(link).toHaveClass('after:absolute', 'after:inset-0');
    const repoCell = screen.getByRole('cell', { name: 'acme/checkout' });
    await userEvent.click(repoCell);
    expect(screen.getByTestId('location')).toHaveTextContent('/space/a');
  });

  it('does not navigate when a row action is clicked', async () => {
    const { onAction } = renderTable();
    const actions = screen.getAllByRole('button', { name: 'Delete' });
    await userEvent.click(actions[1]);
    expect(onAction).toHaveBeenCalledWith('b');
    expect(screen.getByTestId('location')).toHaveTextContent('/');
    const actionsCell = actions[1].closest('td') as HTMLElement;
    expect(actionsCell).toHaveClass('relative', 'z-10');
  });

  it('keeps the link as the keyboard focus target for the row', async () => {
    renderTable();
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Checkout' })).toHaveFocus();
  });

  it('right-aligns numeric columns with tabular figures', () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: 'Runs' })).toHaveClass(
      'text-right',
      'tabular-nums',
    );
    expect(screen.getByRole('cell', { name: '12' })).toHaveClass('text-right', 'tabular-nums');
    expect(screen.getByRole('columnheader', { name: 'Space' })).not.toHaveClass('tabular-nums');
  });

  it('hides hideBelow columns on narrow containers', () => {
    renderTable();
    const header = screen.getByRole('columnheader', { name: 'Repository' });
    expect(header).toHaveClass('hidden', '@[48rem]:table-cell');
    expect(screen.getByRole('cell', { name: 'acme/checkout' })).toHaveClass(
      'hidden',
      '@[48rem]:table-cell',
    );
    expect(screen.getByRole('columnheader', { name: 'Space' })).not.toHaveClass('hidden');
  });

  it('applies column widths through a colgroup', () => {
    renderTable();
    const table = screen.getByRole('table');
    const cols = table.querySelectorAll('colgroup > col');
    expect(cols).toHaveLength(4);
    expect((cols[2] as HTMLElement).style.width).toBe('6rem');
    expect(table).toHaveClass('table-fixed');
  });

  it('renders the empty slot in place of rows', () => {
    renderTable({ rows: [], empty: <p>No spaces match</p> });
    expect(screen.getByText('No spaces match')).toBeInTheDocument();
    expect(screen.queryAllByRole('rowheader')).toHaveLength(0);
    expect(screen.getByRole('columnheader', { name: 'Space' })).toBeInTheDocument();
  });

  it('renders plain text cells without links when rowHref is omitted', () => {
    renderTable({ rowHref: undefined });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('rowheader', { name: 'Checkout' })).toBeInTheDocument();
  });

  it('names the table from a caption when no aria-label is given', () => {
    renderTable({ 'aria-label': undefined, caption: 'Spaces you belong to' });
    expect(screen.getByRole('table', { name: 'Spaces you belong to' })).toBeInTheDocument();
  });
});
